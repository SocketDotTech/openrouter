// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {Ownable} from "../common/utils/Ownable.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "../common/interfaces/IAllowanceHolder.sol";
import {BytesSpliceLib} from "../common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";

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
        uint256 returnDataWordOffset;
    }

    struct BridgeData {
        address target;
        address approvalSpender;
        uint256 value;
    }

    struct MonolithicExecution {
        InputData input;
        FeeData preFee;
        SwapData swap;
        FeeData postFee;
        BridgeData bridge;
        /// Packed flags; monolithic pipeline tests `BALANCE_FLAG_BIT_MASK` in `_execSwap`,
        /// `BRIDGE_VALUE_FLAG_BIT_MASK` and `BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK` in `_doBridge`.
        /// Fee timing uses `preFee` / `postFee` structs — `FEE_FLAG_BIT_MASK` (bit 0) is ignored here.
        uint256 flags;
    }

    // =========================================================================
    // Modular execution types
    // =========================================================================

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
    // Flags (swap / swapAndBridge / monolithic swap step)
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
    //   bit 0     : FEE_FLAG_BIT_MASK (0x01)   — swap fee: pre- vs post-swap (standalone paths only)
    //
    // Combined values for swap()/swapAndBridge():
    //
    //   flags  binary (low byte)    postFee?   balance-of output?         bridge value?
    //   ─────  ──────────────────  ────────   ──────────────────         ─────────────
    //   0x00   00000000              no         returndata word            bridge.value
    //   0x01   00000001              yes        returndata word            bridge.value
    //   0x02   00000010              no         balance delta on outputToken bridge.value
    //   0x03   00000011              yes        balance delta on outputToken bridge.value
    //   0x04   00000100              no         returndata word            finalAmount + bridge.value
    //
    // FEE_FLAG_BIT_MASK selects bit 0 — fee timing.
    //   Cleared — pull → deduct fee from input token → swap remainder.
    //   Set     — pull → swap full input → deduct fee from output token (after minOutput check on swap result).
    //
    // BALANCE_FLAG_BIT_MASK selects bit 1 — swap output sizing.
    //   Cleared — decode returned amount from call returndata at `swapData.returnDataWordOffset`.
    //   Set     — snapshot outputToken balance before call, measure (after − before) as output.
    //
    // BRIDGE_VALUE_FLAG_BIT_MASK selects bit 2 — bridge native value source.
    //   Cleared — forward `bridge.value` as msg.value.
    //   Set     — forward `finalAmount + bridge.value` as msg.value (bridge.value carries static addend, e.g. LZ nativeFee).
    //
    // BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK selects bit 3 — bridge calldata amount splicing.
    //   Cleared — no runtime amount splice.
    //   Set     — splice finalAmount at uint16(flags >> BRIDGE_AMOUNT_POSITION_SHIFT).
    //
    // Monolithic `performExecution` ignores `FEE_FLAG_BIT_MASK`; fee timing is `preFee`/`postFee` structs.

    /// @dev Bit mask 0x01: post-swap fee path when `(flags & mask) != 0`; clear = pre-swap fee from input token.
    uint256 internal constant FEE_FLAG_BIT_MASK = 0x01;

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
    // Events
    // =========================================================================

    event RequestExecuted(bytes32 indexed requestHash);

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
     *         post-swap fee, bridge call with optional single-position amount splicing.
     * @dev The caller MUST route through `AllowanceHolder.exec` so that
     *      `_msgSender()` resolves to `exec.input.user`. There is no nonce or
     *      deadline; replay protection is the caller's responsibility.
     *      Bit 0 (`FEE_FLAG_BIT_MASK`) is unused in monolithic runs; fee placement is `preFee` / `postFee` structs.
     *      `exec.flags` contributes `BALANCE_FLAG_BIT_MASK` to `_execSwap` and
     *      `BRIDGE_VALUE_FLAG_BIT_MASK` to bridge msg.value selection.
     * @param requestHash Caller-defined correlation id logged in `RequestExecuted`.
     */
    function performExecution(
        bytes32 requestHash,
        MonolithicExecution calldata exec,
        bytes calldata swapCallData,
        bytes calldata bridgeCallData
    ) external payable {
        _runMonolithic(exec, swapCallData, bridgeCallData);
        emit RequestExecuted(requestHash);
    }

    // =========================================================================
    // External: standalone swap
    // =========================================================================

    /**
     * @notice Pull → optional pre/post fee → swap.
     * @param requestHash Caller-defined correlation id logged in `RequestExecuted`.
     * @param receiver  Address that ultimately receives the swap output (net of any post-swap fee).
     *                  For pre-fee / no-fee: the swap router must be instructed (via `swapCallData`) to send
     *                  tokens directly to `receiver`; the contract never holds the output.
     *                  For post-fee: tokens land at this contract, fee is deducted, net is forwarded to `receiver`.
     * @param flags     Packed flags; OR masks then test with `flags & MASK != 0`. Masks: `FEE_FLAG_BIT_MASK` (0x01), `BALANCE_FLAG_BIT_MASK` (0x02).
     *                  Common values: `0` (pre-fee, returndata), `1` (post-fee, returndata),
     *                  `2` (pre-fee, balance delta), `3` (post-fee, balance delta).
     * @param fee       Set `amount` to 0 to skip fee collection.
     * @dev   `minOutput` is the minimum gross amount coming out of the swap (before any output-token fee).
     *        It is enforced immediately after `_execSwap`, then post-swap fee (if any) is collected.
     *        Pre-fee paths take the input-side fee before the swap; `minOutput` still guards the swap outcome.
     *        Bits are read with bitwise AND against each mask; omitting both masks ⇒ pre-fee + returndata.
     */
    function swap(
        bytes32 requestHash,
        InputData calldata input,
        address receiver,
        uint256 flags,
        FeeData calldata fee,
        SwapData calldata swapData,
        bytes calldata swapCallData
    ) external payable returns (uint256 finalAmount) {
        if (
            input.user == address(0) || input.inputToken == address(0) || swapData.target == address(0)
                || receiver == address(0)
        ) {
            revert InvalidExecution();
        }

        _pullFromUser(input.inputToken, input.user, input.inputAmount);

        // Check fee amount first: flag bit is only read when a fee is actually present.
        // FEE_FLAG_BIT_MASK: unset ⇒ collect fee from input before swap; set ⇒ swap first, fee from output
        bool hasFee = fee.amount != 0;
        /// @dev if hasFee is false, we short-circuit and flag check wont execute at runtime saving gas
        bool postFee = hasFee && flags & FEE_FLAG_BIT_MASK != 0;
        uint256 swapInput = input.inputAmount;

        // collect pre-swap fee
        if (hasFee && !postFee) {
            uint256 feeAmount = fee.amount;
            if (feeAmount > swapInput) revert InsufficientFunds();
            CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
            unchecked {
                swapInput -= feeAmount;
            }
        }

        // approve swap router
        if (swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, swapInput);
        }

        // Post-fee: swap output lands at this contract so the fee can be deducted before forwarding.
        // Pre-fee / no-fee: swap calldata encodes `receiver` as the output recipient; tokens never touch this contract.
        address outputReceiver = postFee ? address(this) : receiver;

        // BALANCE_FLAG_BIT_MASK: unset ⇒ decode output word from returndata; set ⇒ output = delta on outputToken
        finalAmount = _execSwap(swapData, swapCallData, flags & BALANCE_FLAG_BIT_MASK != 0, outputReceiver);
        if (finalAmount < swapData.minOutput) revert SwapOutputInsufficient();

        // collect post-swap fee and forward net to receiver
        if (postFee) {
            uint256 feeAmount = fee.amount;
            if (feeAmount > finalAmount) revert InsufficientFunds();
            CurrencyLib.transfer(swapData.outputToken, fee.receiver, feeAmount);
            unchecked {
                finalAmount -= feeAmount;
            }
            // Tokens are at this contract; transfer net output to receiver
            CurrencyLib.transfer(swapData.outputToken, receiver, finalAmount);
        }
        // Pre-fee / no-fee: tokens were sent directly to `receiver` by the swap router; nothing to transfer

        emit RequestExecuted(requestHash);
    }

    // =========================================================================
    // External: swap + bridge
    // =========================================================================

    /**
     * @notice Pull → optional pre/post swap fee → swap → bridge with runtime amount splicing.
     * @param requestHash Caller-defined correlation id logged in `RequestExecuted`.
     * @param flags     Same packing as `swap`; additionally bit 2 forwards final amount as bridge msg.value.
     * @param fee       Set `amount` to 0 to skip fee collection.
     * @dev   Same `minOutput` rule as `swap`: validated on gross `_execSwap` output, then optional output fee applies.
     */
    function swapAndBridge(
        bytes32 requestHash,
        InputData calldata input,
        uint256 flags,
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

        uint256 finalAmount = _swapAndBridgeSwap(input, flags, fee, swapData, swapCallData);

        _finishSwapAndBridge(swapData.outputToken, finalAmount, bridgeData, bridgeCallData, flags);
        emit RequestExecuted(requestHash);
    }

    function _swapAndBridgeSwap(
        InputData calldata input,
        uint256 flags,
        FeeData calldata fee,
        SwapData calldata swapData,
        bytes calldata swapCallData
    ) internal returns (uint256 finalAmount) {
        _pullFromUser(input.inputToken, input.user, input.inputAmount);
        bool postFee;
        {
            // Check fee amount first: flag bit is only read when a fee is actually present.
            // FEE_FLAG_BIT_MASK: same semantics as standalone `swap` (fee from input vs output token)
            uint256 feeAmount = fee.amount;
            postFee = feeAmount != 0 && flags & FEE_FLAG_BIT_MASK != 0;
            uint256 swapInput = input.inputAmount;

            if (feeAmount != 0 && !postFee) {
                if (feeAmount > swapInput) revert InsufficientFunds();
                CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
                unchecked {
                    swapInput -= feeAmount;
                }
            }

            if (swapData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
                SafeTransferLib.safeApproveWithRetry(input.inputToken, swapData.approvalSpender, swapInput);
            }
        }

        // BALANCE_FLAG_BIT_MASK: same returndata vs balance-delta measurement as `swap`
        // Swap output always lands at this contract regardless of fee timing — tokens must be here for bridging.
        bool useBalanceOf = flags & BALANCE_FLAG_BIT_MASK != 0;
        finalAmount = _execSwap(swapData, swapCallData, useBalanceOf, address(this));
        if (finalAmount < swapData.minOutput) revert SwapOutputInsufficient();

        if (postFee) {
            uint256 feeAmount = fee.amount;
            if (feeAmount > finalAmount) revert InsufficientFunds();
            CurrencyLib.transfer(swapData.outputToken, fee.receiver, feeAmount);
            unchecked {
                finalAmount -= feeAmount;
            }
        }
    }

    function _finishSwapAndBridge(
        address finalToken,
        uint256 finalAmount,
        BridgeData calldata bridgeData,
        bytes calldata bridgeCallData,
        uint256 flags
    ) internal {
        _doBridge(finalToken, finalAmount, bridgeData, bridgeCallData, flags);
    }

    // =========================================================================
    // External: simple bridge path (no swap)
    // =========================================================================

    /**
     * @notice Pull → optional pre-bridge fee → bridge, with no swap step.
     * @param requestHash Caller-defined correlation id logged in `RequestExecuted`.
     * @dev Because no swap is involved, `finalAmount = inputAmount - feeAmount` is
     *      fully knowable by the caller before signing.  The caller must therefore
     *      bake the correct amount directly into `bridgeCallData` and set
     *      `bridgeData.value` to the desired `msg.value` for the bridge call.
     *      No runtime calldata splicing is performed.
     *
     *      The caller MUST route through `AllowanceHolder.exec` for ERC-20
     *      inputs so that `_msgSender()` resolves to `input.user`.
     */
    function bridge(
        bytes32 requestHash,
        InputData calldata input,
        FeeData calldata fee,
        BridgeData calldata bridgeData,
        bytes calldata bridgeCallData
    ) external payable {
        if (bridgeData.target == address(0) || input.user == address(0) || input.inputToken == address(0)) {
            revert InvalidExecution();
        }

        // 1. pull funds from user via AllowanceHolder
        _pullFromUser(input.inputToken, input.user, input.inputAmount);

        // 2. optional pre-bridge fee; track net amount for approval
        uint256 feeAmount = fee.amount;
        if (feeAmount != 0) {
            if (feeAmount > input.inputAmount) {
                revert InsufficientFunds();
            }
            CurrencyLib.transfer(input.inputToken, fee.receiver, feeAmount);
        }

        // 3. optional approval to bridge spender for the net amount (inputAmount - feeAmount)
        if (bridgeData.approvalSpender != address(0) && input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            uint256 netAmount;
            unchecked {
                netAmount = input.inputAmount - feeAmount;
            }
            SafeTransferLib.safeApproveWithRetry(input.inputToken, bridgeData.approvalSpender, netAmount);
        }

        // 4. bridge call — data and value are pre-encoded by the caller
        _doCallCalldata(bridgeData.target, bridgeData.value, bridgeCallData, false);
        emit RequestExecuted(requestHash);
    }

    // =========================================================================
    // External: modular path
    // =========================================================================

    /**
     * @notice Runs a sequence of generic actions with optional returndata
     *         splicing between steps. No signature verification.
     * @param requestHash Caller-defined correlation id logged in `RequestExecuted`.
     */
    function performModularExecution(bytes32 requestHash, Action[] calldata actions)
        external
        payable
        returns (bytes[] memory results)
    {
        results = _performActions(actions);
        emit RequestExecuted(requestHash);
    }

    // =========================================================================
    // Internal: monolithic pipeline
    // =========================================================================

    function _runMonolithic(
        MonolithicExecution calldata exec,
        bytes calldata swapCallData,
        bytes calldata bridgeCallData
    ) internal {
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
            (finalToken, finalAmount) = _performSwap(exec, swapCallData);
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

        // 5. bridge: splice, approve, call
        _finishMonolithicBridge(exec, finalToken, finalAmount, bridgeCallData);
    }

    function _finishMonolithicBridge(
        MonolithicExecution calldata exec,
        address finalToken,
        uint256 finalAmount,
        bytes calldata bridgeCallData
    ) internal {
        _doBridge(finalToken, finalAmount, exec.bridge, bridgeCallData, exec.flags);
    }

    function _performSwap(MonolithicExecution calldata exec, bytes calldata swapCallData)
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

        // Monolithic path: only `BALANCE_FLAG_BIT_MASK` is read for `_execSwap`; fee uses `preFee` / `postFee`, not bit 0.
        // Swap output always lands at this contract; it feeds directly into the bridge step.
        finalAmount = _execSwap(exec.swap, swapCallData, exec.flags & BALANCE_FLAG_BIT_MASK != 0, address(this));
        if (finalAmount < exec.swap.minOutput) revert SwapOutputInsufficient();
        finalToken = exec.swap.outputToken;
    }

    // =========================================================================
    // Internal: swap / fee / bridge helpers
    // =========================================================================

    /// @dev Execute swap; output measured via returndata word or output-token balance delta.
    ///      useBalanceOf=true: measure output as (balance after - balance before) at `outputReceiver`.
    ///      useBalanceOf=false: decode output from returndata at swapData.returnDataWordOffset.
    ///      `outputReceiver` must be `address(this)` when tokens are expected at the contract
    ///      (post-swap fee path, bridge path) or `user` when the swap router sends directly to them
    ///      (pre-swap fee / no-fee standalone swap).
    function _execSwap(
        SwapData calldata swapData,
        bytes calldata swapCallData,
        bool useBalanceOf,
        address outputReceiver
    ) internal returns (uint256 finalAmount) {
        if (useBalanceOf) {
            // Balance delta mode: snapshot before, call, measure delta at the expected recipient
            uint256 before = CurrencyLib.balanceOf(swapData.outputToken, outputReceiver);
            _doCallCalldata(swapData.target, swapData.value, swapCallData, false);
            finalAmount = CurrencyLib.balanceOf(swapData.outputToken, outputReceiver) - before;
        } else {
            // Returndata mode: decode output from a specific word in returndata
            bytes memory ret = _doCallCalldata(swapData.target, swapData.value, swapCallData, true);
            finalAmount = _decodeReturnWord(ret, swapData.returnDataWordOffset);
        }
    }

    /// @dev Splice finalAmount into bridge calldata, approve, and call bridge target.
    function _doBridge(
        address token,
        uint256 amount,
        BridgeData calldata bd,
        bytes calldata bridgeCallData,
        uint256 flags
    ) internal {
        bytes memory bData = bridgeCallData;
        if (flags & BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK != 0) {
            uint256 position = flags >> BRIDGE_AMOUNT_POSITION_SHIFT & BRIDGE_AMOUNT_POSITION_MASK;
            BytesSpliceLib.spliceWord({data: bData, position: position, word: amount});
        }

        if (bd.approvalSpender != address(0) && token != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(token, bd.approvalSpender, amount);
        }

        // when set, forward amount as msg.value for native-token bridges
        uint256 bridgeValue = flags & BRIDGE_VALUE_FLAG_BIT_MASK != 0 ? amount + bd.value : bd.value;
        _doCall(bd.target, bridgeValue, bData);
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

    function _decodeReturnWord(bytes memory ret, uint256 wordOffset) internal pure returns (uint256 word) {
        uint256 offset = wordOffset * 32;
        if (offset + 32 > ret.length) revert ReturnDataOutOfBounds();

        assembly ("memory-safe") {
            word := mload(add(add(ret, 0x20), offset))
        }
    }

    /**
     * @notice Rescues funds from the contract if they are locked by mistake.
     * @param token_ The address of the token contract.
     * @param rescueTo_ The address where rescued tokens need to be sent.
     * @param amount_ The amount of tokens to be rescued.
     */
    function rescueFunds(address token_, address rescueTo_, uint256 amount_) external onlyOwner {
        RescueFundsLib.rescueFunds(token_, rescueTo_, amount_);
    }
}

