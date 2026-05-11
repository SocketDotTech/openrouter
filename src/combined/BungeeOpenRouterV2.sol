// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {OpenRouterAuthBase} from "../common/OpenRouterAuthBase.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "../common/interfaces/IAllowanceHolder.sol";
import {BytesSpliceLib} from "../common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";

/// @title BungeeOpenRouterV2
/// @notice Combined open-router that exposes two execution paths behind a
///         single signature-verified, AllowanceHolder-based fund pull:
///
///         1. `performExecution` — monolithic path. The signed payload describes
///            every step explicitly: pull, optional pre-swap fee, optional swap,
///            optional post-swap fee, bridge call with multi-position amount
///            splicing. Suitable for the vast majority of routes.
///
///         2. `performModularExecution` — generic action loop (identical to
///            `BungeeOpenRouterModular`). Each `Action` carries a list of
///            `Splice`s that copy byte ranges from the previous action's
///            returndata into this action's calldata before dispatch. Use this
///            for routes that need more than one bridge call, non-standard step
///            ordering, or multiple amount fields patched from a single prior
///            return value.
///
///         Fund pulls always go through 0x AllowanceHolder (transient-storage
///         allowance). The `_msgSender() == user` guard ensures the AH
///         ephemeral allowance (keyed by operator + owner + token) belongs to
///         the user named in the signed payload.
///
/// @dev Both entrypoints verify a personal_sign signature over
///      `keccak256(abi.encode(chainid, address(this), exec))` and consume a
///      single-use nonce, matching the `Solver` / `StakedRouterReceiver`
///      authentication model.
contract BungeeOpenRouterV2 is OpenRouterAuthBase, AllowanceHolderContext {
    using SafeTransferLib for address;

    // =========================================================================
    // Monolithic execution types
    // =========================================================================

    /// @notice Who is sending funds and how much.
    struct InputData {
        address user;
        address inputToken;
        uint256 inputAmount;
    }

    /// @notice Optional fee. Set `receiver` to address(0) and `amount` to 0 to skip.
    struct FeeData {
        address receiver;
        uint256 amount;
    }

    /// @notice Optional swap step. Set `target` to address(0) to skip entirely.
    struct SwapData {
        address target;
        address approvalSpender; // 0 to skip ERC20 approval before swap
        address outputToken; // token measured via balance delta
        uint256 value; // ETH forwarded to the swap target
        uint256 minOutput; // minimum balance delta; reverts if not met
        bytes data;
    }

    /// @notice Mandatory bridge call. `amountPositions` lists every byte offset
    ///         in `data` where the final post-fee amount must be written.
    struct BridgeData {
        address target;
        address approvalSpender; // 0 to skip ERC20 approval before bridge
        uint256 value; // ETH forwarded to the bridge target
        bytes data;
        uint256[] amountPositions;
    }

    /// @notice Signed payload for the monolithic execution path.
    /// @dev Digest: keccak256(abi.encode(block.chainid, address(this), exec)).
    struct MonolithicExecution {
        InputData input;
        FeeData preFee; // taken in inputToken before swap
        SwapData swap;
        FeeData postFee; // taken in finalToken after swap
        BridgeData bridge;
        uint256 nonce;
        uint256 deadline;
    }

    // =========================================================================
    // Modular execution types
    // =========================================================================

    enum CallType {
        CALL,
        DELEGATECALL,
        STATICCALL
    }

    /// @notice Byte-range copy from the previous action's returndata into this
    ///         action's calldata, applied before the action is dispatched.
    struct Splice {
        uint256 srcOffset; // offset within the previous action's returndata
        uint256 dstOffset; // offset within this action's `data`
        uint256 length; // number of bytes to copy
    }

    /// @notice One step in the modular execution pipeline.
    struct Action {
        CallType callType;
        address target;
        uint256 value; // ETH forwarded; must be zero for DELEGATECALL / STATICCALL
        bytes data; // base calldata, patched in-place by splices before dispatch
        Splice[] splices; // applied BEFORE this action runs
    }

    /// @notice Signed payload for the modular execution path.
    struct ModularExecution {
        Action[] actions;
        uint256 nonce;
        uint256 deadline;
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

    constructor(address _owner, address _openRouterSigner) OpenRouterAuthBase(_owner, _openRouterSigner) {}

    receive() external payable {}

    // =========================================================================
    // External: monolithic path
    // =========================================================================

    /**
     * @notice Executes a monolithic signed payload: pull funds via AH, optional
     *         pre-swap fee, optional swap, optional post-swap fee, bridge call
     *         with multi-position amount splicing.
     * @dev Anyone may call; security is the backend signature + single-use nonce.
     *      The caller MUST route through `AllowanceHolder.exec` so that
     *      `_msgSender()` resolves to `exec.input.user`.
     */
    function performExecution(MonolithicExecution calldata exec, bytes calldata signature) external payable {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _runMonolithic(exec);
    }

    // =========================================================================
    // External: modular path
    // =========================================================================

    /**
     * @notice Executes a signed sequence of generic actions with optional
     *         returndata splicing between steps.
     * @dev The signed digest covers the entire action set, so the caller cannot
     *      reorder, retarget, or strip splices from any action.
     */
    function performModularExecution(ModularExecution calldata exec, bytes calldata signature) external payable {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _performActions(exec.actions);
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
        _performAction(exec.bridge.target, exec.bridge.value, bridgeData);
    }

    /// @dev Balance-delta swap helper; split out to keep _runMonolithic under 100 lines.
    function _performSwap(MonolithicExecution calldata exec) internal returns (address finalToken, uint256 finalAmount) {
        uint256 preBalance = CurrencyLib.balanceOf(exec.swap.outputToken, address(this));

        if (exec.swap.approvalSpender != address(0) && exec.input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            uint256 swapInput;
            unchecked {
                swapInput = exec.input.inputAmount - exec.preFee.amount;
            }
            SafeTransferLib.safeApproveWithRetry(exec.input.inputToken, exec.swap.approvalSpender, swapInput);
        }

        _performAction(exec.swap.target, exec.swap.value, exec.swap.data);

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
     * @dev Requires the caller to have routed through `AllowanceHolder.exec`
     *      so `_msgSender()` resolves to the original user. Mirrors the
     *      assembly in `0x-settler/src/core/Permit2Payment.sol`.
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

    /**
     * @notice Runs a signed sequence of actions, applying returndata splices
     *         from each step into the calldata of the next before dispatch.
     */
    function _performActions(Action[] calldata actions) internal {
        if (actions.length == 0) {
            revert EmptyActions();
        }

        bytes memory prevReturn; // empty on first action; splice on action[0] is illegal
        for (uint256 i = 0; i < actions.length;) {
            Action calldata a = actions[i];
            bytes memory data = a.data;

            // apply splices: copy byte ranges from prevReturn into this action's data
            uint256 spLen = a.splices.length;
            for (uint256 j = 0; j < spLen;) {
                Splice calldata sp = a.splices[j];
                BytesSpliceLib.spliceBytes({
                    dst: data, // this action's calldata (base is signed; patched before dispatch)
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

    /**
     * @notice Dispatches a single action with the given call type; bubbles revert.
     * @dev Named `_dispatchAction` (rather than overloading `_performAction`)
     *      to keep the CALL-only base helper in `OpenRouterAuthBase` distinct
     *      from this three-way dispatcher.
     */
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
}
