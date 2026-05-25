// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {IERC20} from "./common/interfaces/IERC20.sol";
import {AccessControl} from "./common/utils/AccessControl.sol";
import {AllowanceHolderContext} from "./common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "./common/interfaces/IAllowanceHolder.sol";
import {BytesSpliceLib} from "./common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "./common/lib/CurrencyLib.sol";
import {RescueFundsLib} from "./common/lib/RescueFundsLib.sol";
import {RESCUE_ROLE} from "./common/AccessRoles.sol";

/// @title OpenRouter
/// @notice Pull → optional fee → swap/bridge execution without backend signature verification.
///         Fund safety rests on AllowanceHolder's transient allowance scoping (operator + owner + token):
///         only the user whose address was passed to `AllowanceHolder.exec` can authorise a pull of
///         their own funds. The `_msgSender() == user` check in `_pullFromUser` enforces this.
contract OpenRouter is AccessControl, AllowanceHolderContext {
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
        /// @dev Packed call metadata. Decode with masks/shifts below; encode with
        ///      `callType | (storeResult ? 1 << 8 : 0) | (uint160(target) << 16)`.
        ///
        /// Bit layout (least significant bits first):
        ///   bits 255..160 : reserved (0)
        ///   bits 159..16  : target address (uint160, left-aligned in this field)
        ///   bit 8         : storeResult — when set, returndata is saved to `results[i]`
        ///                   even on success so later actions can splice from it
        ///   bits 7..3     : reserved (0)
        ///   bits 2..0     : CallType — CALL (0), STATICCALL (1), CALL_WITH_NATIVE (2)
        ///
        /// CALL_WITH_NATIVE: first 32 bytes of `data` are forwarded as `msg.value`;
        /// the remaining bytes are the call payload.
        uint256 actionInfo;
        /// @dev Calldata passed to the target. Splices from `splices[]` overwrite byte
        /// ranges in a mutable memory copy before the external call runs.
        bytes data;
        /// @dev Packed splice descriptors applied to `data` before the call.
        /// Each entry is one `uint256` with four uint64 fields (see layout below).
        /// Encode with `packSpliceInfo` in `scripts/e2e/utils/modularActionsBuilder/index.js`.
        ///
        /// Per-entry bit layout (least significant bits first):
        ///   bits 255..192 : length — number of bytes to copy (must be > 0)
        ///   bits 191..128 : dstOffset — byte offset into this action's `data` payload
        ///                   (skips the bytes-array length word; for CALL_WITH_NATIVE,
        ///                   offset 0 is the value word, offset 32 is payload start)
        ///   bits 127..64  : srcOffset — byte offset into `results[sourceActionIndex]`
        ///                   payload (same length-prefix convention)
        ///   bits 63..0    : sourceActionIndex — index of a prior action (< current index)
        ///
        /// Packing formula:
        ///   sourceActionIndex | (srcOffset << 64) | (dstOffset << 128) | (length << 192)
        ///
        /// The source action must have bit 8 set in `actionInfo` (storeResult); the JS
        /// builder sets this automatically when a splice references that action.
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

            // Approve spender
            if (
                // check spender & token
                swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS && 
                    // check current allowance
                    swapInput > IERC20(input.inputToken).allowance(address(this), swapData.approvalSpender)
            ) {
                // approve max allowance
                SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, type(uint256).max);
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
        _execBridge(swapData.outputToken, finalAmount, flags, bridgeData, bridgeCallData);

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

        uint256 netAmount;
        unchecked {
            netAmount = input.inputAmount - feeAmount;
        }

        // Approve bridge spender
        if (
            // check spender && token
            bridgeData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS && 
                // check current allowance
                netAmount > IERC20(input.inputToken).allowance(address(this), bridgeData.approvalSpender)
        ) {
            // approve max allowance
            SafeTransferLib.safeApproveWithRetry(input.inputToken, bridgeData.approvalSpender, type(uint256).max);
        }

        // Execute bridge
        _execCallCalldata(bridgeData.target, bridgeData.value, bridgeCallData, false);

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
     * @return finalAmount Swap output net of any post-swap fee, ready for `_execBridge`.
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
            if (
                // check spender & token
                swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS && 
                    // check current allowance
                    swapInput > IERC20(input.inputToken).allowance(address(this), swapData.approvalSpender)
            ) {
                // approve max allowance
                SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, type(uint256).max);
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
    function _execBridge(
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
        if (
            // check spender & token
            bridgeData.approvalSpender != address(0) && token != CurrencyLib.NATIVE_TOKEN_ADDRESS && 
                // check current allowance
                amount > IERC20(token).allowance(address(this), bridgeData.approvalSpender)
        ) {
            // approve max allowance
            SafeTransferLib.safeApproveWithRetry(token, bridgeData.approvalSpender, type(uint256).max);
        }

        // Parse and set bridge value flag
        uint256 bridgeValue = ((flags & BRIDGE_VALUE_FLAG_BIT_MASK) != 0) ? amount + bridgeData.value : bridgeData.value;

        // Execute bridge call
        _execCall(bridgeData.target, bridgeValue, _bridgeCallData);
    }

    // --------------------------------------
    //   performActions internal functions
    // --------------------------------------

    /**
     * @dev Executes `actions` in order, applying returndata splices before each call.
     * @dev See `Action` for `actionInfo` and `splices[]` bit layouts.
     * @param actions Ordered list of actions to run.
     */
    function _performActions(Action[] calldata actions) internal {
        uint256 actionsLength = actions.length;
        bytes[] memory results = new bytes[](actionsLength);

        for (uint256 i; i < actionsLength;) {
            Action calldata action = actions[i];
            bytes memory callData = action.data;

            // Patch callData with slices of prior action returndata.
            uint256 splicesLength = action.splices.length;
            for (uint256 j; j < splicesLength;) {
                uint256 spliceInfo = action.splices[j];
                uint256 sourceActionIndex = uint64(spliceInfo); // first 64 bits: index of the prior action to read returndata from.
                if (sourceActionIndex >= i) revert FutureSplice(i, sourceActionIndex);

                uint256 srcOffset = uint64(spliceInfo >> 64); // Next 64 bits: byte offset into source returndata
                uint256 dstOffset = uint64(spliceInfo >> 128); // Next 64 bits: byte offset into next action's data
                uint256 length = spliceInfo >> 192; // Top 64 bits: number of bytes to copy

                // Fetch source action returndata
                bytes memory source = results[sourceActionIndex];
                if (srcOffset + length > source.length || dstOffset + length > callData.length) {
                    revert SpliceOutOfBounds(i, j);
                }

                assembly ("memory-safe") {
                    // copy `length` bytes from `source returndata starting from `srcOffset` to `callData` starting from `dstOffset`
                    mcopy(add(add(callData, 0x20), dstOffset), add(add(source, 0x20), srcOffset), length)
                }

                unchecked {
                    ++j;
                }
            }

            // Parse actionInfo
            bool success;
            uint256 actionInfo = action.actionInfo;
            bool storeResult = (actionInfo & 0xff00) != 0; // Bit 8: persist returndata if set
            uint256 callType = actionInfo & 0xff; // Bits 0–7: specify CallType
            address target = address(uint160(actionInfo >> 16)); // Bits 16+: target address

            if (callType == uint256(CallType.STATICCALL)) {
                assembly ("memory-safe") {
                    // staticcall without copying return data by default
                    success := staticcall(gas(), target, add(callData, 0x20), mload(callData), 0, 0)
                }
            } else if (callType == uint256(CallType.CALL_WITH_NATIVE)) {
                if (callData.length < 32) revert MissingNativeValue(i);
                uint256 callValue;
                uint256 payloadLength = callData.length - 32;
                assembly ("memory-safe") {
                    // regular call with value forwarded without copying return data by default
                    callValue := mload(add(callData, 0x20)) // CALL_WITH_NATIVE prepends a 32-byte wei amount before the actual calldata payload.
                    success := call(gas(), target, callValue, add(callData, 0x40), payloadLength, 0, 0) // skips first two bytes to reach actuall calldata
                }
            } else {
                assembly ("memory-safe") {
                    // regular call with zero value forwarded without copying return data by default
                    success := call(gas(), target, 0, add(callData, 0x20), mload(callData), 0, 0)
                }
            }

            // Capture returndata on failure (for revert reason) or when explicitly requested.
            if (!success || storeResult) {
                bytes memory ret;
                assembly ("memory-safe") {
                    // prep return / revert data
                    let returnDataSize := returndatasize()
                    ret := mload(0x40)
                    mstore(ret, returnDataSize) // write length prefix on free-mem pointer
                    returndatacopy(add(ret, 0x20), 0, returnDataSize) // copy returndata after length
                    mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f))) // Advance free pointer to next 32-byte boundary: (ret + 0x20 + size + 31) and clear last 5 bits with not(0x1f)
                }
                // if any call was failed, revert with the returndata
                if (!success) revert CallFailed(i, ret);
                
                // else, save returndata to results array
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
            // Manually ABI-encode AllowanceHolder.transferFrom(address token, address owner, address recipient, uint256 amount)
            // selector 0x15dacbea. Calldata is 0x84 (132) bytes and starts at ptr+0x1c (see last mstore below).
            //
            // The `shl(0x60, addr)` trick left-aligns a 20-byte address in a 32-byte word: the high 20 bytes
            // hold the address and the trailing 12 bytes are zero, which simultaneously encodes the address AND
            // provides the ABI zero-padding for the *next* field — so each shifted mstore clears the following
            // field's padding without a separate write.
            //
            // Calldata layout relative to ptr+0x1c:
            //   [0..3]    selector   (0x15dacbea)
            //   [4..35]   token      (12-byte pad + 20-byte address)
            //   [36..67]  owner/user (12-byte pad + 20-byte address)
            //   [68..99]  recipient  (12-byte pad + 20-byte address = address(this))
            //   [100..131] amount    (uint256)
            let ptr := mload(0x40)
            mstore(add(0x80, ptr), amount) // calldata[100..131]: amount (uint256, right-aligned)
            mstore(add(0x60, ptr), address()) // calldata[68..99]: recipient = this contract (right-aligned, high 12 bytes are zero padding)
            mstore(add(0x4c, ptr), shl(0x60, user)) // calldata[48..67]: user address; trailing 12 zero bytes fill calldata[68..79] (recipient padding)
            // `shl(0x60)` (96-bit), NOT `shl(0xa0)` (160-bit): 0xa0 here is literal 160, which
            // shifts the 20-byte address out of place and corrupts the calldata token. Same as 0x-settler `Permit2Payment._allowanceHolderTransferFrom`.
            mstore(add(0x2c, ptr), shl(0x60, token)) // calldata[16..35]: token address; trailing 12 zero bytes fill calldata[36..47] (user padding)
            mstore(add(0x0c, ptr), 0x15dacbea000000000000000000000000) // selector at calldata[0..3]; 12 zero bytes fill calldata[4..15] (token padding); calldata begins at ptr+0x1c

            if iszero(call(gas(), allowanceHolder, 0x00, add(0x1c, ptr), 0x84, 0x00, 0x00)) {
                // if call did not succeed, revert with the revert returndata
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
            _execCallCalldata(swapData.target, swapData.value, swapCallData, false);
            finalAmount = CurrencyLib.balanceOf(swapData.outputToken, outputReceiver) - before;
        } else {
            // Decode output from returndata
            bytes memory ret = _execCallCalldata(swapData.target, swapData.value, swapCallData, true);
            finalAmount = _decodeReturnWord(ret, swapData.returnDataWordOffset);
        }
    }

    /**
     * @dev Low-level `call` with bubbled revert data on failure.
     * @param target Call recipient.
     * @param value Wei forwarded with the call.
     * @param data ABI-encoded calldata in memory.
     */
    function _execCall(address target, uint256 value, bytes memory data) internal {
        bool success;
        assembly ("memory-safe") {
            success := call(gas(), target, value, add(data, 0x20), mload(data), 0, 0)
        }

        if (!success) {
            bytes memory ret;
            assembly ("memory-safe") {
                // prep and return revert data
                let returnDataSize := returndatasize()
                ret := mload(0x40)
                mstore(ret, returnDataSize) // write length prefix on free-mem pointer
                returndatacopy(add(ret, 0x20), 0, returnDataSize) // copy returndata after length
                mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f))) // bump free pointer
                revert(add(ret, 0x20), mload(ret)) // bubbles up the original revert payload
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
    function _execCallCalldata(address target, uint256 value, bytes calldata data, bool storeResult)
        internal
        returns (bytes memory ret)
    {
        bool success;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length) // copy calldata slice to fresh memory (avoids redundant memory alloc)
            mstore(0x40, and(add(add(ptr, data.length), 0x1f), not(0x1f))) // advance free pointer to next 32-byte boundary
            success := call(gas(), target, value, ptr, data.length, 0, 0)
        }

        if (!success || storeResult) {
            assembly ("memory-safe") {
                // prep and return revert data
                let returnDataSize := returndatasize()
                ret := mload(0x40)
                mstore(ret, returnDataSize) // write length prefix on free-mem pointer
                returndatacopy(add(ret, 0x20), 0, returnDataSize) // copy returndata after length
                mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f))) // bump free pointer
            }
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret)) // bubble up the raw revert payload
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
            // read the word at the offset from return data
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
