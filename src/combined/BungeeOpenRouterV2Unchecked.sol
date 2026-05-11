// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {Ownable} from "../common/utils/Ownable.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "../common/interfaces/IAllowanceHolder.sol";
import {BytesSpliceLib} from "../common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";

/// @title BungeeOpenRouterV2Unchecked
/// @notice Identical execution logic to `BungeeOpenRouterV2` with all backend
///         signature verification removed. There are no nonce or deadline
///         fields; either entrypoint can be called by anyone.
///
///         Fund safety still rests on AllowanceHolder's transient allowance
///         scoping (operator + owner + token): only the user whose address was
///         passed to `AllowanceHolder.exec` can authorise a pull of their own
///         funds. The `_msgSender() == user` check in `_pullFromUser` enforces
///         this at the contract level.
///
///         Intended for development / testing environments where spinning up a
///         backend signer is inconvenient, or for operational flows where the
///         operator calls through AllowanceHolder directly without a separate
///         signing step. Do NOT deploy to production without adding an access
///         control layer appropriate to your threat model.
///
/// @dev Both struct types mirror their `BungeeOpenRouterV2` counterparts but
///      drop the `nonce` and `deadline` fields, which are only relevant for
///      signature-based replay protection.
contract BungeeOpenRouterV2Unchecked is Ownable, AllowanceHolderContext {
    using SafeTransferLib for address;

    // =========================================================================
    // Monolithic execution types
    // =========================================================================

    struct InputData {
        address user;
        address inputToken;
        uint256 inputAmount;
    }

    struct FeeData {
        address receiver;
        uint256 amount;
    }

    struct SwapData {
        address target;
        address approvalSpender;
        address outputToken;
        uint256 value;
        uint256 minOutput;
        bytes data;
    }

    struct BridgeData {
        address target;
        address approvalSpender;
        uint256 value;
        bytes data;
        uint256[] amountPositions;
    }

    struct MonolithicExecution {
        InputData input;
        FeeData preFee;
        SwapData swap;
        FeeData postFee;
        BridgeData bridge;
    }

    // =========================================================================
    // Modular execution types
    // =========================================================================

    enum CallType {
        CALL,
        DELEGATECALL,
        STATICCALL
    }

    struct Splice {
        uint256 srcOffset;
        uint256 dstOffset;
        uint256 length;
    }

    struct Action {
        CallType callType;
        address target;
        uint256 value;
        bytes data;
        Splice[] splices;
    }

    // =========================================================================
    // Errors
    // =========================================================================

    error SwapOutputInsufficient();
    error InsufficientFunds();
    error InvalidExecution();
    error CallerNotSignedUser();
    error ValueOnNonCall();
    error EmptyActions();
    error UnknownCallType();

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address _owner) Ownable(_owner) {}

    receive() external payable {}

    // =========================================================================
    // External: monolithic path
    // =========================================================================

    /**
     * @notice Executes the monolithic pipeline without signature verification:
     *         pull via AH, optional pre-swap fee, optional swap, optional
     *         post-swap fee, bridge call with multi-position amount splicing.
     * @dev The caller MUST route through `AllowanceHolder.exec` so that
     *      `_msgSender()` resolves to `exec.input.user`. There is no nonce or
     *      deadline; replay protection is the caller's responsibility.
     */
    function performExecution(MonolithicExecution calldata exec) external payable {
        _runMonolithic(exec);
    }

    // =========================================================================
    // External: modular path
    // =========================================================================

    /**
     * @notice Runs a sequence of generic actions with optional returndata
     *         splicing between steps. No signature verification.
     */
    function performModularExecution(Action[] calldata actions) external payable {
        _performActions(actions);
    }

    // =========================================================================
    // Internal: monolithic pipeline
    // =========================================================================

    function _runMonolithic(MonolithicExecution calldata exec) internal {
        if (exec.bridge.target == address(0) || exec.input.user == address(0) || exec.input.inputToken == address(0)) {
            revert InvalidExecution();
        }

        // 1. pull funds from user via AllowanceHolder
        _pullFromUser(exec.input.inputToken, exec.input.user, exec.input.inputAmount);

        // 2. optional pre-swap fee in input token
        if (exec.preFee.amount != 0) {
            CurrencyLib.transfer(exec.input.inputToken, exec.preFee.receiver, exec.preFee.amount);
        }

        // 3. optional swap, accounted via pre/post balance delta
        address finalToken;
        uint256 finalAmount;
        if (exec.swap.target != address(0)) {
            (finalToken, finalAmount) = _performSwap(exec);
        } else {
            if (exec.preFee.amount > exec.input.inputAmount) {
                revert InsufficientFunds();
            }
            finalToken = exec.input.inputToken;
            unchecked {
                finalAmount = exec.input.inputAmount - exec.preFee.amount;
            }
        }

        // 4. optional post-swap fee in final token
        if (exec.postFee.amount != 0) {
            if (exec.postFee.amount > finalAmount) {
                revert InsufficientFunds();
            }
            CurrencyLib.transfer(finalToken, exec.postFee.receiver, exec.postFee.amount);
            unchecked {
                finalAmount -= exec.postFee.amount;
            }
        }

        // 5. splice finalAmount into bridge calldata at every signed offset
        bytes memory bridgeData = exec.bridge.data;
        BytesSpliceLib.spliceWords({data: bridgeData, positions: exec.bridge.amountPositions, word: finalAmount});

        // 6. optional approval to bridge spender
        if (exec.bridge.approvalSpender != address(0) && finalToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(finalToken, exec.bridge.approvalSpender, finalAmount);
        }

        // 7. bridge call, bubbling any revert
        _doCall(exec.bridge.target, exec.bridge.value, bridgeData);
    }

    /// @dev Balance-delta swap helper.
    function _performSwap(MonolithicExecution calldata exec) internal returns (address finalToken, uint256 finalAmount) {
        uint256 preBalance = CurrencyLib.balanceOf(exec.swap.outputToken, address(this));

        if (exec.swap.approvalSpender != address(0) && exec.input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            uint256 swapInput;
            unchecked {
                swapInput = exec.input.inputAmount - exec.preFee.amount;
            }
            SafeTransferLib.safeApproveWithRetry(exec.input.inputToken, exec.swap.approvalSpender, swapInput);
        }

        _doCall(exec.swap.target, exec.swap.value, exec.swap.data);

        uint256 postBalance = CurrencyLib.balanceOf(exec.swap.outputToken, address(this));
        if (postBalance < preBalance) {
            revert SwapOutputInsufficient();
        }
        uint256 delta;
        unchecked {
            delta = postBalance - preBalance;
        }
        if (delta < exec.swap.minOutput) {
            revert SwapOutputInsufficient();
        }

        finalToken = exec.swap.outputToken;
        finalAmount = delta;
    }

    // =========================================================================
    // Internal: AllowanceHolder pull
    // =========================================================================

    /**
     * @notice Pulls `amount` of `token` from `user` via AllowanceHolder.
     * @dev Enforces `_msgSender() == user`: the caller must have routed through
     *      `AllowanceHolder.exec` whose `owner` argument matches `user`.
     *      AH selector: transferFrom(address,address,address,uint256) = 0x15dacbea
     */
    function _pullFromUser(address token, address user, uint256 amount) internal {
        if (_msgSender() != user) {
            revert CallerNotSignedUser();
        }

        address allowanceHolder = address(ALLOWANCE_HOLDER);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(0x80, ptr), amount)
            mstore(add(0x60, ptr), address())
            mstore(add(0x4c, ptr), shl(0x60, user)) // clears recipient padding
            mstore(add(0x2c, ptr), shl(0xa0, token)) // clears owner padding
            mstore(add(0x0c, ptr), 0x15dacbea000000000000000000000000) // selector + token padding

            if iszero(call(gas(), allowanceHolder, 0x00, add(0x1c, ptr), 0x84, 0x00, 0x00)) {
                let p := mload(0x40)
                returndatacopy(p, 0x00, returndatasize())
                revert(p, returndatasize())
            }
        }
    }

    // =========================================================================
    // Internal: modular action loop
    // =========================================================================

    function _performActions(Action[] calldata actions) internal {
        if (actions.length == 0) {
            revert EmptyActions();
        }

        bytes memory prevReturn;
        for (uint256 i = 0; i < actions.length;) {
            Action calldata a = actions[i];
            bytes memory data = a.data;

            uint256 spLen = a.splices.length;
            for (uint256 j = 0; j < spLen;) {
                Splice calldata sp = a.splices[j];
                BytesSpliceLib.spliceBytes({
                    dst: data, // this action's calldata (patched before dispatch)
                    dstOffset: sp.dstOffset, // write `length` bytes into `dst` starting here
                    src: prevReturn, // read from the previous action's returndata
                    srcOffset: sp.srcOffset, // copy slice starting at this offset in `src`
                    length: sp.length // number of bytes to copy (overwrites same span in `dst`)
                });
                unchecked {
                    ++j;
                }
            }

            prevReturn = _dispatchAction(a.callType, a.target, a.value, data);
            unchecked {
                ++i;
            }
        }
    }

    function _dispatchAction(CallType callType, address target, uint256 value, bytes memory data)
        internal
        returns (bytes memory ret)
    {
        bool ok;
        if (callType == CallType.CALL) {
            (ok, ret) = target.call{value: value}(data);
        } else if (callType == CallType.DELEGATECALL) {
            if (value != 0) {
                revert ValueOnNonCall();
            }
            (ok, ret) = target.delegatecall(data);
        } else if (callType == CallType.STATICCALL) {
            if (value != 0) {
                revert ValueOnNonCall();
            }
            (ok, ret) = target.staticcall(data);
        } else {
            revert UnknownCallType();
        }

        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // =========================================================================
    // Internal: simple call dispatcher (used by monolithic path)
    // =========================================================================

    function _doCall(address target, uint256 value, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
