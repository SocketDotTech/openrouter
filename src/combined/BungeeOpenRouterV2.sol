// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

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
///         2. `performModularExecution` — generic action loop. Each `Action`
///            carries packed call metadata and packed splices that copy byte
///            ranges from any earlier stored action result into this action's
///            calldata before dispatch.
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
        address outputToken; // token used for post-fee transfer / bridge approval
        uint256 value; // ETH forwarded to the swap target
        uint256 minOutput; // minimum decoded output; reverts if not met
        bytes data;
        uint256 returnDataWordOffset;
    }

    /// @notice Mandatory bridge call. `amountPositions` lists every byte offset
    ///         in `data` where the final post-fee amount must be written.
    struct BridgeData {
        address target;
        address approvalSpender; // 0 to skip ERC20 approval before bridge
        uint256 value; // ETH forwarded to the bridge target
        bytes data;
        uint256[] amountPositions;
        // when true, bridge.value is ignored and finalAmount is forwarded as
        // msg.value instead — needed for native-token bridges (e.g. Arbitrum inbox)
        // where the bridged amount is only known at runtime.
        bool useFinalAmountAsValue;
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
        STATICCALL,
        CALL_WITH_NATIVE
    }

    /// @notice One step in the modular execution pipeline.
    /// @dev `actionInfo` packs call type in bits [0:8), store-result flag in
    ///      bits [8:16), and target address in bits [16:176).
    struct Action {
        uint256 actionInfo;
        bytes data;
        uint256[] splices;
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
    error InsufficientMsgValue();
    error FutureSplice(uint256 actionIndex, uint256 sourceActionIndex);
    error SpliceOutOfBounds(uint256 actionIndex, uint256 spliceIndex);
    error CallFailed(uint256 actionIndex, bytes returndata);
    error MissingNativeValue(uint256 actionIndex);
    error ReturnDataOutOfBounds();

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
    function performModularExecution(ModularExecution calldata exec, bytes calldata signature)
        external
        payable
        returns (bytes[] memory results)
    {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        results = _performActions(exec.actions);
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

        // 3. optional swap, accounted via decoded returndata
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
        // when useFinalAmountAsValue is set, forward finalAmount as msg.value so
        // native-token bridges (e.g. Arbitrum inbox) receive the exact bridged amount.
        uint256 bridgeValue = exec.bridge.useFinalAmountAsValue ? finalAmount : exec.bridge.value;
        _doCall(exec.bridge.target, bridgeValue, bridgeData, false);
    }

    /// @dev Swap helper; decodes final amount from a returndata word.
    function _performSwap(MonolithicExecution calldata exec)
        internal
        returns (address finalToken, uint256 finalAmount)
    {
        if (exec.swap.approvalSpender != address(0) && exec.input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            uint256 swapInput;
            unchecked {
                swapInput = exec.input.inputAmount - exec.preFee.amount;
            }
            SafeTransferLib.safeApproveWithRetry(exec.input.inputToken, exec.swap.approvalSpender, swapInput);
        }

        bytes memory ret = _doCall(exec.swap.target, exec.swap.value, exec.swap.data, true);
        finalAmount = _decodeReturnWord(ret, exec.swap.returnDataWordOffset);

        if (finalAmount < exec.swap.minOutput) {
            revert SwapOutputInsufficient();
        }

        finalToken = exec.swap.outputToken;
    }

    // =========================================================================
    // Internal: AllowanceHolder pull
    // =========================================================================

    /**
     * @notice Pulls `amount` of `token` from `user` into this contract.
     * @dev For ERC20: enforces `_msgSender() == user` (caller must have routed
     *      through `AllowanceHolder.exec`) and calls AH.transferFrom via assembly.
     *      AH selector: transferFrom(address,address,address,uint256) = 0x15dacbea
     *      For native ETH: ETH must already be present as msg.value; we simply
     *      verify sufficient value was forwarded. No AH call is needed.
     */
    function _pullFromUser(address token, address user, uint256 amount) internal {
        if (token == CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            // ETH is already sent as msg.value directly to this contract.
            if (msg.value < amount) {
                revert InsufficientMsgValue();
            }
            return;
        }

        if (_msgSender() != user) {
            revert CallerNotSignedUser();
        }

        address allowanceHolder = address(ALLOWANCE_HOLDER);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(0x80, ptr), amount)
            mstore(add(0x60, ptr), address())
            mstore(add(0x4c, ptr), shl(0x60, user)) // clears `recipient`'s padding
            // `shl(0x60)` (96-bit), NOT `shl(0xa0)` (160-bit): 0xa0 here is literal 160, which
            // shifts the 20-byte address out of place and corrupts the calldata token. Same as
            // 0x-settler `Permit2Payment._allowanceHolderTransferFrom`.
            mstore(add(0x2c, ptr), shl(0x60, token)) // clears `owner`'s padding (settler wording)
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

    function _performActions(Action[] calldata actions) internal returns (bytes[] memory results) {
        uint256 actionsLength = actions.length;
        results = new bytes[](actionsLength);

        for (uint256 i; i < actionsLength;) {
            Action calldata action = actions[i];
            bytes memory callData = action.data;

            uint256 splicesLength = action.splices.length;
            for (uint256 j; j < splicesLength;) {
                uint256 spliceInfo = action.splices[j];
                uint256 sourceActionIndex = uint64(spliceInfo);
                if (sourceActionIndex >= i) revert FutureSplice(i, sourceActionIndex);

                uint256 srcOffset = uint64(spliceInfo >> 64);
                uint256 dstOffset = uint64(spliceInfo >> 128);
                uint256 length = spliceInfo >> 192;
                bytes memory source = results[sourceActionIndex];
                if (srcOffset + length > source.length || dstOffset + length > callData.length) {
                    revert SpliceOutOfBounds(i, j);
                }

                assembly ("memory-safe") {
                    mcopy(add(add(callData, 0x20), dstOffset), add(add(source, 0x20), srcOffset), length)
                }

                unchecked {
                    ++j;
                }
            }

            bool success;
            uint256 actionInfo = action.actionInfo;
            bool storeResult = (actionInfo & 0xff00) != 0;
            uint256 callType = actionInfo & 0xff;
            address target = address(uint160(actionInfo >> 16));

            if (callType == uint256(CallType.STATICCALL)) {
                assembly ("memory-safe") {
                    success := staticcall(gas(), target, add(callData, 0x20), mload(callData), 0, 0)
                }
            } else if (callType == uint256(CallType.CALL_WITH_NATIVE)) {
                if (callData.length < 32) revert MissingNativeValue(i);
                uint256 callValue;
                uint256 payloadLength = callData.length - 32;
                assembly ("memory-safe") {
                    callValue := mload(add(callData, 0x20))
                    success := call(gas(), target, callValue, add(callData, 0x40), payloadLength, 0, 0)
                }
            } else {
                assembly ("memory-safe") {
                    success := call(gas(), target, 0, add(callData, 0x20), mload(callData), 0, 0)
                }
            }

            if (!success || storeResult) {
                bytes memory ret;
                assembly ("memory-safe") {
                    let returnDataSize := returndatasize()
                    ret := mload(0x40)
                    mstore(ret, returnDataSize)
                    returndatacopy(add(ret, 0x20), 0, returnDataSize)
                    mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f)))
                }
                if (!success) revert CallFailed(i, ret);
                results[i] = ret;
            }
            unchecked {
                ++i;
            }
        }
    }

    // =========================================================================
    // Internal: simple call dispatcher (used by monolithic path)
    // =========================================================================

    function _doCall(address target, uint256 value, bytes memory data, bool storeResult)
        internal
        returns (bytes memory ret)
    {
        bool success;
        assembly ("memory-safe") {
            success := call(gas(), target, value, add(data, 0x20), mload(data), 0, 0)
        }

        if (!success || storeResult) {
            assembly ("memory-safe") {
                let returnDataSize := returndatasize()
                ret := mload(0x40)
                mstore(ret, returnDataSize)
                returndatacopy(add(ret, 0x20), 0, returnDataSize)
                mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f)))
            }
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    function _decodeReturnWord(bytes memory ret, uint256 wordOffset) internal pure returns (uint256 word) {
        uint256 offset = wordOffset * 32;
        if (offset + 32 > ret.length) revert ReturnDataOutOfBounds();

        assembly ("memory-safe") {
            word := mload(add(add(ret, 0x20), offset))
        }
    }
}
