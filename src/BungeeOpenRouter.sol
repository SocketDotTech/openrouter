// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {AccessControl} from "./common/utils/AccessControl.sol";
import {AllowanceHolderContext} from "./common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "./common/interfaces/IAllowanceHolder.sol";
import {BytesSpliceLib} from "./common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "./common/lib/CurrencyLib.sol";
import {RescueFundsLib} from "./common/lib/RescueFundsLib.sol";
import {RESCUE_ROLE} from "./common/AccessRoles.sol";

/// @title BungeeOpenRouter
/// @notice Pull → optional fee → swap/bridge execution without backend signature verification.
///         Fund safety rests on AllowanceHolder's transient allowance scoping (operator + owner + token):
///         only the user whose address was passed to `AllowanceHolder.exec` can authorise a pull of
///         their own funds. The `_msgSender() == user` check in `_pullFromUser` enforces this.
contract BungeeOpenRouter is AccessControl, AllowanceHolderContext {
    using SafeTransferLib for address;

    // =========================================================================
    // Structs
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
        uint256 returnDataWordOffset;
    }

    struct BridgeData {
        address target;
        address approvalSpender;
        uint256 value;
    }

    enum CallType {
        CALL,
        STATICCALL,
        CALL_WITH_NATIVE
    }

    struct Action {
        uint256 actionInfo;
        bytes data;
        uint256[] splices;
    }

    // =========================================================================
    // Flags (swap / swapAndBridge)
    // =========================================================================
    //
    // Instead of bool parameters, one uint256 packs independent switches without adding
    // ABI range checks or extra words for standalone bools.
    //
    // Bit layout (least significant bits); test with `(flags & MASK) != 0`:
    //   bits 255..32 : reserved (0)
    //   bits 31..16 : bridge amount word byte offset, uint16, used only when bit 3 is set
    //   bits 15..4  : reserved (0)
    //   bit 3     : BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK (0x08) — splice finalAmount into bridge calldata
    //   bit 2     : BRIDGE_VALUE_FLAG_BIT_MASK (0x04) — bridge msg.value: bridge.value alone vs finalAmount + bridge.value
    //   bit 1     : BALANCE_FLAG_BIT_MASK (0x02) — swap output: returndata vs balance delta
    //   bit 0     : POST_FEE_FLAG_BIT_MASK (0x01)   — swap fee: pre- vs post-swap
    //
    // Combined values for flags:
    //
    //   flags  binary (low byte)    postFee?   balance-of output?            bridge value?
    //   ─────  ──────────────────  ────────   ──────────────────             ─────────────
    //   0x00   00000000              no         returndata word               bridge.value
    //   0x01   00000001              yes        returndata word               bridge.value
    //   0x02   00000010              no         balance delta on outputToken  bridge.value
    //   0x03   00000011              yes        balance delta on outputToken  bridge.value
    //   0x04   00000100              no         returndata word               finalAmount + bridge.value
    //
    // POST_FEE_FLAG_BIT_MASK selects bit 0 — fee timing
    //   0000 — pre-swap fee: pull → deduct fee from input token → swap remainder
    //   0001 — post-swap fee: pull → swap full input → deduct fee from output token (after minOutput check on swap result)
    //
    // BALANCE_FLAG_BIT_MASK selects bit 1 — swap output sizing
    //   0000 — returnData as swap output: decode returned amount from call returndata at `swapData.returnDataWordOffset`
    //   0010 — balanceOf() delta as swap output: snapshot outputToken balance before call, measure (after − before) as output
    //
    // BRIDGE_VALUE_FLAG_BIT_MASK selects bit 2 — bridge native value source
    //   0000 — bridge.value as msg.value: forward `bridge.value` as msg.value
    //   0100 — finalAmount + bridge.value as msg.value: forward `finalAmount + bridge.value` as msg.value (bridge.value carries static addend, e.g. LZ nativeFee)
    //
    // BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK selects bit 3 — bridge calldata amount splicing.
    //   0000 — no bridge calldata modification
    //   1000 — bridge calldata modification: splice finalAmount at uint16(flags >> BRIDGE_AMOUNT_POSITION_SHIFT)
    //

    /// @dev Bit mask 0x01: post-swap fee path when `(flags & mask) != 0`; clear = pre-swap fee from input token.
    uint256 internal constant POST_FEE_FLAG_BIT_MASK = 0x01;

    /// @dev Bit mask 0x02: measure swap output by balance delta when `(flags & mask) != 0`; clear = returndata word.
    uint256 internal constant BALANCE_FLAG_BIT_MASK = 0x02;

    /// @dev Bit mask 0x04: `finalAmount + bridge.value` is forwarded as msg.value (bridge.value acts as a static addend, e.g. LZ nativeFee).
    uint256 internal constant BRIDGE_VALUE_FLAG_BIT_MASK = 0x04;

    /// @dev Bit mask 0x08: splice finalAmount into bridge calldata at the uint16 position packed in flags.
    uint256 internal constant BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK = 0x08;

    /// @dev Shift for the packed uint16 bridge amount position.
    uint256 internal constant BRIDGE_AMOUNT_POSITION_SHIFT = 16;

    /// @dev Mask for the packed uint16 bridge amount position after shifting.
    uint256 internal constant BRIDGE_AMOUNT_POSITION_MASK = 0xffff;

    // =========================================================================
    // Errors
    // =========================================================================

    error SwapOutputInsufficient();
    error InvalidExecution();
    error CallerNotSignedUser();
    error InsufficientMsgValue();
    error FutureSplice(uint256 actionIndex, uint256 sourceActionIndex);
    error SpliceOutOfBounds(uint256 actionIndex, uint256 spliceIndex);
    error CallFailed(uint256 actionIndex, bytes returndata);
    error MissingNativeValue(uint256 actionIndex);
    error ReturnDataOutOfBounds();

    // =========================================================================
    // Events
    // =========================================================================

    event RequestExecuted(bytes32 indexed quoteId);

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploys the router and grants `RESCUE_ROLE` to `_owner`.
     * @param _owner Initial contract owner and rescue-role holder.
     */
    constructor(address _owner) AccessControl(_owner) {
        _grantRole(RESCUE_ROLE, _owner);
    }

    /// @notice Accepts native ETH forwarded with bridge/swap calls.
    receive() external payable {}

    // =========================================================================
    // External functions
    // =========================================================================

    /**
     * @notice Perform swap with optional pre/post fee.
     * @param quoteId Caller-defined correlation id logged in `RequestExecuted`.
     * @param flags Packed flags
     * @param input User, input token, and pull amount.
     * @dev For pre-fee / no-fee: the swap router must
     *      be instructed (via `swapCallData`) to send tokens directly to `receiver`; the contract never holds the output.
     *      For post-fee: tokens land at this contract, fee is deducted, net is forwarded to `receiver`.
     * @param fee Fee collection info: receiver and amount. Set `amount` to 0 to skip fee collection.
     * @param swapData Swap target, spender, output token, value, `minOutput`, and returndata offset.
     * @param swapCallData Calldata forwarded to `swapData.target`.
     * @param receiver Address that ultimately receives the swap output (net of any post-swap fee).
     * @return finalAmount Gross swap output sent to receiver after any post-swap fee
     * @dev `minOutput` is the minimum gross amount coming out of the swap (before any output-token fee). It is enforced immediately after `_execSwap`, then post-swap fee (if any) is collected.
     *      Pre-fee paths take the input-side fee before the swap; `minOutput` still guards the swap outcome.
     */
    function swap(
        bytes32 quoteId,
        uint256 flags,
        InputData calldata input,
        FeeData calldata fee,
        SwapData calldata swapData,
        bytes calldata swapCallData,
        address receiver
    ) external payable returns (uint256 finalAmount) {
        if (
            input.user == address(0) || input.inputToken == address(0) || swapData.target == address(0)
                || receiver == address(0)
        ) {
            revert InvalidExecution();
        }

        // Parse flags
        bool postFee = fee.amount != 0 && ((flags & POST_FEE_FLAG_BIT_MASK) != 0);
        bool useBalanceOf = ((flags & BALANCE_FLAG_BIT_MASK) != 0);

        {
            // Pull funds from user via AllowanceHolder
            _pullFromUser(input.inputToken, input.user, input.inputAmount);

            // Collect pre-swap fee
            uint256 swapInput = input.inputAmount;
            if (fee.amount != 0 && !postFee) {
                uint256 feeAmount = fee.amount;
                CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
                unchecked {
                    swapInput -= feeAmount;
                }
            }

            // Approve swap spender
            if (swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
                SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, swapInput);
            }
        }

        /// @dev Pre-fee / no-fee: swap calldata encodes `receiver` as the output recipient; tokens never touch this contract.
        /// @dev Post-fee: swap output lands at this contract so the fee can be deducted before forwarding.
        address outputReceiver = postFee ? address(this) : receiver;

        // Execute swap
        finalAmount = _execSwap(swapData, swapCallData, useBalanceOf, outputReceiver);
        if (finalAmount < swapData.minOutput) revert SwapOutputInsufficient();

        if (postFee) {
            // Collect post-swap fee
            uint256 feeAmount = fee.amount;
            CurrencyLib.transfer(swapData.outputToken, fee.receiver, feeAmount);
            unchecked {
                finalAmount -= feeAmount;
            }

            // Transfer net output to receiver
            CurrencyLib.transfer(swapData.outputToken, receiver, finalAmount);
        }

        // Pre-fee / no-fee: tokens were sent directly to `receiver` by the swap router; nothing to transfer

        emit RequestExecuted(quoteId);
    }

    /**
     * @notice Perform swap and bridge with optional pre/post swap fee.
     * @param quoteId Caller-defined correlation id logged in `RequestExecuted`.
     * @param flags Packed flags
     * @param input User, input token, and pull amount.
     * @param fee Fee collection info: receiver and amount. Set `amount` to 0 to skip fee collection.
     * @param swapData Swap target, spender, output token, value, `minOutput`, and returndata offset.
     * @param swapCallData Calldata forwarded to `swapData.target`.
     * @param bridgeData Bridge target, approval spender, and static `msg.value` addend.
     * @param bridgeCallData Bridge calldata; optionally spliced with swap output per `flags`.
     * @dev Same `minOutput` rule as `swap`: validated on gross `_execSwap` output, then optional output fee applies.
     */
    function swapAndBridge(
        bytes32 quoteId,
        uint256 flags,
        InputData calldata input,
        FeeData calldata fee,
        SwapData calldata swapData,
        bytes calldata swapCallData,
        BridgeData calldata bridgeData,
        bytes calldata bridgeCallData
    ) external payable {
        if (
            bridgeData.target == address(0) || input.user == address(0) || input.inputToken == address(0)
                || swapData.target == address(0)
        ) {
            revert InvalidExecution();
        }

        // Execute swap before bridge
        uint256 finalAmount = _swapBeforeBridge(flags, input, fee, swapData, swapCallData);

        // Execute bridge
        _doBridge(swapData.outputToken, finalAmount, flags, bridgeData, bridgeCallData);

        emit RequestExecuted(quoteId);
    }

    /**
     * @notice Perform bridge with optional pre-bridge fee.
     * @param quoteId Caller-defined correlation id logged in `RequestExecuted`.
     * @param input User, input token, and pull amount.
     * @param fee Fee collection info: receiver and amount. Set `amount` to 0 to skip fee collection.
     * @param bridgeData Bridge target, approval spender, and `msg.value` for the bridge call.
     * @param bridgeCallData Calldata forwarded to `bridgeData.target` (amount must be baked in by the caller).
     * @dev Because no swap is involved, `finalAmount = inputAmount - feeAmount` is fully knowable by the caller before signing.
     *      The caller must therefore bake the correct amount directly into `bridgeCallData` and set `bridgeData.value` to the desired `msg.value` for the bridge call.
     *      No runtime calldata splicing is performed. The caller MUST route through `AllowanceHolder.exec` for ERC-20 inputs so that `_msgSender()` resolves to `input.user`.
     */
    function bridge(
        bytes32 quoteId,
        InputData calldata input,
        FeeData calldata fee,
        BridgeData calldata bridgeData,
        bytes calldata bridgeCallData
    ) external payable {
        if (bridgeData.target == address(0) || input.user == address(0) || input.inputToken == address(0)) {
            revert InvalidExecution();
        }

        // Pull funds from user via AllowanceHolder
        _pullFromUser(input.inputToken, input.user, input.inputAmount);

        // Collect pre-bridge fee
        uint256 feeAmount = fee.amount;
        if (feeAmount != 0) {
            CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
        }

        // Approve bridge spender
        if (bridgeData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            uint256 netAmount;
            unchecked {
                netAmount = input.inputAmount - feeAmount;
            }
            SafeTransferLib.safeApproveWithRetry(input.inputToken, bridgeData.approvalSpender, netAmount);
        }

        // Execute bridge
        _doCallCalldata(bridgeData.target, bridgeData.value, bridgeCallData, false);

        emit RequestExecuted(quoteId);
    }

    /**
     * @notice Runs a sequence of generic actions with optional returndata splicing between steps.
     * @param quoteId Caller-defined correlation id logged in `RequestExecuted`.
     * @param actions Ordered actions; each may splice bytes from a prior action's returndata into its calldata.
     */
    function performActions(bytes32 quoteId, Action[] calldata actions) external payable {
        _performActions(actions);

        emit RequestExecuted(quoteId);
    }

    // =========================================================================
    // Internal functions
    // =========================================================================

    // -------------------------------------
    //   swapAndBridge internal functions
    // -------------------------------------

    /**
     * @dev Pull, optional pre/post swap fee, and swap for `swapAndBridge`. Swap output always remains at `address(this)` for bridging.
     * @param flags Fee timing and swap output measurement flags (same as `swap`).
     * @param input User, input token, and pull amount.
     * @param fee Fee receiver and amount; `amount == 0` skips fee collection.
     * @param swapData Swap target, spender, output token, value, `minOutput`, and returndata offset.
     * @param swapCallData Calldata forwarded to `swapData.target`.
     * @return finalAmount Swap output net of any post-swap fee, ready for `_doBridge`.
     */
    function _swapBeforeBridge(
        uint256 flags,
        InputData calldata input,
        FeeData calldata fee,
        SwapData calldata swapData,
        bytes calldata swapCallData
    ) internal returns (uint256 finalAmount) {
        // Pull funds from user via AllowanceHolder
        _pullFromUser(input.inputToken, input.user, input.inputAmount);

        bool postFee;
        {
            // Collect pre-swap fee
            uint256 feeAmount = fee.amount;
            postFee = feeAmount != 0 && ((flags & POST_FEE_FLAG_BIT_MASK) != 0);
            uint256 swapInput = input.inputAmount;

            if (feeAmount != 0 && !postFee) {
                CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
                unchecked {
                    swapInput -= feeAmount;
                }
            }

            // Approve swap spender
            if (swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
                SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, swapInput);
            }
        }

        // Execute swap
        /// @dev Swap output always lands at this contract regardless of fee timing — tokens must be here for bridging.
        bool useBalanceOf = ((flags & BALANCE_FLAG_BIT_MASK) != 0);
        finalAmount = _execSwap(swapData, swapCallData, useBalanceOf, address(this));
        if (finalAmount < swapData.minOutput) revert SwapOutputInsufficient();

        // Collect post-swap fee
        if (postFee) {
            uint256 feeAmount = fee.amount;
            CurrencyLib.transfer(swapData.outputToken, fee.receiver, feeAmount);
            unchecked {
                finalAmount -= feeAmount;
            }
        }
    }

    /**
     * @dev Splice `amount` into bridge calldata when flagged, approve the bridge spender, and call the bridge target.
     * @param token ERC-20 bridged (or native sentinel); used for approval only.
     * @param amount Post-swap token amount spliced into calldata and/or forwarded as `msg.value`.
     * @param flags Bridge splice position, `msg.value` composition, and related bit flags.
     * @param bridgeData Bridge target, approval spender, and static `msg.value` addend.
     * @param bridgeCallData Base bridge calldata; copied to memory when splicing is required.
     */
    function _doBridge(
        address token,
        uint256 amount,
        uint256 flags,
        BridgeData calldata bridgeData,
        bytes calldata bridgeCallData
    ) internal {
        bytes memory _bridgeCallData = bridgeCallData;

        // Modify bridge calldata if splicing is required
        if (flags & BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK != 0) {
            uint256 position = flags >> BRIDGE_AMOUNT_POSITION_SHIFT & BRIDGE_AMOUNT_POSITION_MASK;
            BytesSpliceLib.spliceWord({data: _bridgeCallData, position: position, word: amount});
        }

        // Approve bridge spender
        if (bridgeData.approvalSpender != address(0) && token != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(token, bridgeData.approvalSpender, amount);
        }

        // Parse and set bridge value flag
        uint256 bridgeValue = ((flags & BRIDGE_VALUE_FLAG_BIT_MASK) != 0) ? amount + bridgeData.value : bridgeData.value;

        // Execute bridge call
        _doCall(bridgeData.target, bridgeValue, _bridgeCallData);
    }

    // --------------------------------------
    //   performActions internal functions
    // --------------------------------------

    /**
     * @dev Executes `actions` in order, applying returndata splices before each call.
     * @dev actionInfo layout:
     *       - bits 0–7: call type (`CallType`)
     *       - bit 8: store returndata
     *       - bits 16+: target address
     *      splices[j` packs source index, src/dst byte offsets, and length.
     * @param actions Ordered list of actions to run.
     */
    function _performActions(Action[] calldata actions) internal {
        uint256 actionsLength = actions.length;
        bytes[] memory results = new bytes[](actionsLength);

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

    // -------------------------------
    //   Common internal functions
    // -------------------------------

    /**
     * @dev Pulls `amount` of `token` from `user` into this contract.
     *      For ERC20: enforces `_msgSender() == user` (caller must have routed through `AllowanceHolder.exec`) and calls AH.transferFrom via assembly.
     *      AH selector: transferFrom(address,address,address,uint256) = 0x15dacbea.
     *      For native ETH: ETH must already be present as msg.value; verify sufficient value was forwarded.
     * @param token Input token or `CurrencyLib.NATIVE_TOKEN_ADDRESS`.
     * @param user Owner whose AllowanceHolder-scoped allowance is consumed.
     * @param amount Tokens or wei to pull.
     */
    function _pullFromUser(address token, address user, uint256 amount) internal {
        // Check input value if native token
        if (token == CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            if (msg.value < amount) {
                revert InsufficientMsgValue();
            }
            return;
        }

        // Check caller is user
        if (_msgSender() != user) revert CallerNotSignedUser();

        // Call AllowanceHolder.transferFrom()
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

    /**
     * @dev Executes the swap call and returns the output amount. 
     *      `useBalanceOf=true`: measure output as (balance after − balance before) at `outputReceiver`. 
     *      `useBalanceOf=false`: decode output from returndata at `swapData.returnDataWordOffset`. 
     *      `outputReceiver` must be `address(this)` when tokens are expected at the contract (post-swap fee path, bridge path) 
     *      or the end user when the router sends directly to them.
     * @param swapData Swap target, value, output token, and returndata layout.
     * @param swapCallData Calldata forwarded to `swapData.target`.
     * @param useBalanceOf When true, use balance delta instead of returndata decoding.
     * @param outputReceiver Account whose output-token balance is measured or credited.
     * @return finalAmount Gross swap output amount.
     */
    function _execSwap(
        SwapData calldata swapData,
        bytes calldata swapCallData,
        bool useBalanceOf,
        address outputReceiver
    ) internal returns (uint256 finalAmount) {
        if (useBalanceOf) {
            // Measure output as (balance after − balance before) at `outputReceiver`
            uint256 before = CurrencyLib.balanceOf(swapData.outputToken, outputReceiver);
            _doCallCalldata(swapData.target, swapData.value, swapCallData, false);
            finalAmount = CurrencyLib.balanceOf(swapData.outputToken, outputReceiver) - before;
        } else {
            // Decode output from returndata
            bytes memory ret = _doCallCalldata(swapData.target, swapData.value, swapCallData, true);
            finalAmount = _decodeReturnWord(ret, swapData.returnDataWordOffset);
        }
    }

    /**
     * @dev Low-level `call` with bubbled revert data on failure.
     * @param target Call recipient.
     * @param value Wei forwarded with the call.
     * @param data ABI-encoded calldata in memory.
     */
    function _doCall(address target, uint256 value, bytes memory data) internal {
        bool success;
        assembly ("memory-safe") {
            success := call(gas(), target, value, add(data, 0x20), mload(data), 0, 0)
        }

        if (!success) {
            bytes memory ret;
            assembly ("memory-safe") {
                let returnDataSize := returndatasize()
                ret := mload(0x40)
                mstore(ret, returnDataSize)
                returndatacopy(add(ret, 0x20), 0, returnDataSize)
                mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f)))
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /**
     * @dev Low-level `call` using calldata copied to memory; optionally captures returndata.
     * @dev Helps cheaper external calls avoiding early copy of calldata to memory.
     * @param target Call recipient.
     * @param value Wei forwarded with the call.
     * @param data Calldata slice forwarded to `target`.
     * @param storeResult When true, copy returndata into memory even on success.
     * @return ret Returndata when `storeResult` is true or the call reverts (revert bubbles).
     */
    function _doCallCalldata(address target, uint256 value, bytes calldata data, bool storeResult)
        internal
        returns (bytes memory ret)
    {
        bool success;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            mstore(0x40, and(add(add(ptr, data.length), 0x1f), not(0x1f)))
            success := call(gas(), target, value, ptr, data.length, 0, 0)
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

    /**
     * @dev Reads the 32-byte word at `wordOffset` from ABI-encoded `ret` (word index, not byte offset).
     * @param ret Return blob from a prior call.
     * @param wordOffset Zero-based index of the 32-byte word to load.
     * @return word Decoded amount or value at that offset.
     */
    function _decodeReturnWord(bytes memory ret, uint256 wordOffset) internal pure returns (uint256 word) {
        uint256 offset = wordOffset * 32;
        if (offset + 32 > ret.length) revert ReturnDataOutOfBounds();

        assembly ("memory-safe") {
            word := mload(add(add(ret, 0x20), offset))
        }
    }

    /**
     * @notice Rescues funds from the contract if they are locked by mistake.
     * @param token The address of the token contract.
     * @param rescueTo The address where rescued tokens need to be sent.
     * @param amount The amount of tokens to be rescued.
     */
    function rescueFunds(address token, address rescueTo, uint256 amount) external onlyRole(RESCUE_ROLE) {
        RescueFundsLib.rescueFunds(token, rescueTo, amount);
    }
}

