// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {AccessControl} from "./common/utils/AccessControl.sol";
import {CurrencyLib} from "./common/lib/CurrencyLib.sol";
import {RescueFundsLib} from "./common/lib/RescueFundsLib.sol";
import {AuthenticationLib} from "./common/lib/AuthenticationLib.sol";
import {RESCUE_ROLE} from "./common/AccessRoles.sol";
import {ICalldataExecutor} from "./interfaces/ICalldataExecutor.sol";
import {IBungeeExecutor} from "./interfaces/IBungeeExecutor.sol";

/// @title BungeeReceiver
/// @notice Destination-side contract for the OpenRouter system.
///
///         Flow per execution:
///           1. Bridge transfers output token(s) to this contract.
///           2. Backend reads the tx receipt to get the exact received amount.
///           3. Backend constructs and signs a `DestPayload`, then calls `executeDestPayload`.
///           4. Contract optionally runs preActions (e.g. approve a swap router).
///           5. Contract optionally swaps the bridged token to the desired output token,
///              measuring the actual output via balance delta.
///           6. Output token + amount are transferred to the IBungeeExecutor target (or directly
///              to a recipient address when no protocol execution is needed).
///           7. If a target is set, `CalldataExecutor.executeCalldata` is called, which invokes
///              `IBungeeExecutor.executeData` on the target via excessivelySafeCall.
///
///         Security: all execution paths are gated behind an ECDSA signature from `SOLVER_SIGNER`
///         combined with a one-time nonce. Funds never leave the contract without a valid sig.
///         Arbitrary calldata execution is delegated to `CalldataExecutor` (a separate stateless
///         proxy) so that a misbehaving destination cannot affect funds still held here.
contract BungeeReceiver is AccessControl {
    using SafeTransferLib for address;

    // =========================================================================
    // Structs
    // =========================================================================

    /// @dev Generic action used in `preActions` (e.g. set approvals for the swap router).
    struct Action {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev Token delivered by the bridge to this contract.
    struct BridgedFunds {
        address token;
    }

    /// @dev Optional destination swap config. Set `target == address(0)` to skip the swap.
    struct DstSwapData {
        address target;
        /// @dev Spender to approve with max allowance before calling the swap router.
        ///      Set to address(0) to skip approval (e.g. native input or already approved).
        address approvalSpender;
        address outputToken;
        /// @dev Minimum acceptable swap output; reverts if balance delta falls below this.
        uint256 minOutput;
        /// @dev msg.value forwarded to the swap router call (for native-token input swaps).
        uint256 value;
    }

    /// @dev Fee collection config. Set `feeType == NO_FEE` or `amount == 0` to skip.
    struct DstFeeData {
        FeeType feeType;
        /// @dev Token the fee is collected in.
        ///      For POST_SWAP fees this should equal `DstSwapData.outputToken`.
        address token;
        address collector;
        uint256 amount;
    }

    /// @dev Final execution config: either invoke an IBungeeExecutor or forward directly to a recipient.
    struct DstExecutionData {
        /// @dev IBungeeExecutor target. Set to address(0) for a plain token transfer to `recipient`.
        address target;
        /// @dev Recipient used when `target == address(0)`.
        address recipient;
        /// @dev Explicit output amount for the no-swap path (net of fee). Unused when a swap is present.
        uint256 outputAmount;
        /// @dev Gas limit forwarded to CalldataExecutor → IBungeeExecutor call.
        uint256 gasLimit;
    }

    enum FeeType {
        NO_FEE,
        PRE_SWAP,
        POST_SWAP
    }

    /// @dev Single calldata struct covering every field that the SOLVER_SIGNER signs over.
    ///      Bundling into one struct reduces `executeDestPayload`'s stack depth: a `bytes` or array
    ///      field inside a calldata struct is accessed via the struct's single calldata pointer
    ///      (1 stack slot) rather than a separate offset+length pair (2 slots each).
    struct DestPayload {
        uint256 nonce;
        bytes32 quoteId;
        BridgedFunds funds;
        Action[] preActions;
        DstFeeData feeData;
        DstSwapData swapData;
        bytes swapCallData;
        DstExecutionData execution;
        bytes executionCallData;
    }

    // =========================================================================
    // Errors
    // =========================================================================

    error InvalidSigner();
    error InvalidNonce();
    error InvalidExecution();
    error PreActionFailed(uint256 index);
    error SwapFailed();
    error SwapOutputInsufficient();

    // =========================================================================
    // Events
    // =========================================================================

    /// @param quoteId Correlation ID of the executed quote.
    /// @param success Whether the IBungeeExecutor.executeData call succeeded.
    event DestPayloadExecuted(bytes32 indexed quoteId, bool success);

    /// @param quoteId Correlation ID of the executed quote.
    /// @param recipient Address that received the funds directly (no IBungeeExecutor involved).
    event FundsForwarded(bytes32 indexed quoteId, address indexed recipient, address token, uint256 amount);

    event SolverSignerUpdated(address indexed newSigner);

    // =========================================================================
    // State
    // =========================================================================

    address public SOLVER_SIGNER;
    address public immutable CALLDATA_EXECUTOR;

    mapping(uint256 => bool) public nonceUsed;

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @param _owner Initial owner; also granted RESCUE_ROLE.
     * @param _solverSigner Address whose ECDSA signatures authorise `executeDestPayload` calls.
     * @param _calldataExecutor Address of the CalldataExecutor satellite contract.
     */
    constructor(address _owner, address _solverSigner, address _calldataExecutor) AccessControl(_owner) {
        _grantRole(RESCUE_ROLE, _owner);
        SOLVER_SIGNER = _solverSigner;
        CALLDATA_EXECUTOR = _calldataExecutor;
    }

    receive() external payable {}
    fallback() external payable {}

    // =========================================================================
    // External functions
    // =========================================================================

    /**
     * @notice Update the signer address used to authorise `executeDestPayload` calls.
     * @param _solverSigner New signer address.
     */
    function setSolverSigner(address _solverSigner) external onlyOwner {
        SOLVER_SIGNER = _solverSigner;
        emit SolverSignerUpdated(_solverSigner);
    }

    /**
     * @notice Execute destination payload after bridge funds have landed in this contract.
     *
     * @dev The backend constructs this call after reading the exact received amount from the bridge
     *      tx receipt. Every field of `payload` is covered by the SOLVER_SIGNER signature —
     *      modifying any field invalidates the signature.
     *
     * @param payload   All signed execution parameters bundled into a single calldata struct.
     * @param signature SOLVER_SIGNER personal-sign signature over `payload`.
     */
    function executeDestPayload(DestPayload calldata payload, bytes calldata signature) external {
        // At least one of target or recipient must be set.
        if (payload.execution.target == address(0) && payload.execution.recipient == address(0)) {
            revert InvalidExecution();
        }

        _verifySignature(
            keccak256(abi.encode(block.chainid, address(this), payload)),
            signature
        );

        _useNonce(payload.nonce);

        // Run pre-actions (e.g. set ERC-20 approval for the swap router).
        for (uint256 i; i < payload.preActions.length;) {
            if (!_performAction(payload.preActions[i])) {
                revert PreActionFailed(i);
            }
            unchecked { ++i; }
        }

        address outputToken;
        uint256 outputAmount;

        if (payload.swapData.target != address(0)) {
            (outputToken, outputAmount) = _executeSwap(
                payload.funds.token, payload.swapData, payload.swapCallData, payload.feeData
            );
        } else {
            (outputToken, outputAmount) = _applyNoSwapFee(
                payload.funds.token, payload.execution.outputAmount, payload.feeData
            );
        }

        // Funds leave the receiver here — all checks complete before this point (CEI).
        address dest = payload.execution.target != address(0)
            ? payload.execution.target
            : payload.execution.recipient;
        CurrencyLib.transfer(outputToken, dest, outputAmount);

        if (payload.execution.target != address(0)) {
            _callExecutor(payload.quoteId, outputToken, outputAmount, payload.execution, payload.executionCallData);
        } else {
            emit FundsForwarded(payload.quoteId, payload.execution.recipient, outputToken, outputAmount);
        }
    }

    /**
     * @notice Rescue funds locked in the contract by mistake.
     * @param token    ERC-20 address or 0xEeee...EEeE for native ETH.
     * @param rescueTo Recipient of the rescued funds.
     * @param amount   Amount to rescue.
     */
    function rescueFunds(address token, address rescueTo, uint256 amount) external onlyRole(RESCUE_ROLE) {
        RescueFundsLib.rescueFunds(token, rescueTo, amount);
    }

    // =========================================================================
    // Internal functions
    // =========================================================================

    /**
     * @dev Handles the swap path: optional pre-swap fee → approval → swap → balance delta → optional post-swap fee.
     * @return outputToken Token coming out of the swap (swapData.outputToken).
     * @return outputAmount Net swap output after any post-swap fee.
     */
    function _executeSwap(
        address inputToken,
        DstSwapData calldata swapData,
        bytes calldata swapCallData,
        DstFeeData calldata feeData
    ) internal returns (address outputToken, uint256 outputAmount) {
        // Collect pre-swap fee from the bridged input token.
        if (feeData.feeType == FeeType.PRE_SWAP && feeData.amount != 0) {
            CurrencyLib.transfer(feeData.token, feeData.collector, feeData.amount);
        }

        // Approve the swap router to spend input token (max allowance, USDT-safe retry pattern).
        if (swapData.approvalSpender != address(0) && inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(inputToken, swapData.approvalSpender, type(uint256).max);
        }

        // Measure swap output via balance delta — avoids relying on swap router return values.
        outputToken = swapData.outputToken;
        uint256 balanceBefore = CurrencyLib.balanceOf(outputToken, address(this));

        if (!_execSwapCalldata(swapData.target, swapData.value, swapCallData)) {
            revert SwapFailed();
        }

        outputAmount = CurrencyLib.balanceOf(outputToken, address(this)) - balanceBefore;

        if (outputAmount < swapData.minOutput) {
            revert SwapOutputInsufficient();
        }

        // Collect post-swap fee from the swap output.
        // Assumes feeData.token == outputToken; enforced by the signed payload.
        if (feeData.feeType == FeeType.POST_SWAP && feeData.amount != 0) {
            CurrencyLib.transfer(feeData.token, feeData.collector, feeData.amount);
            unchecked { outputAmount -= feeData.amount; }
        }
    }

    /**
     * @dev Handles the no-swap path: apply fee if set, return bridged token + explicit output amount.
     *      The backend derives `outputAmount` from the bridge tx receipt; the contract trusts the
     *      signed value. If the bridge sent less, the subsequent `CurrencyLib.transfer` will revert.
     */
    function _applyNoSwapFee(
        address bridgedToken,
        uint256 outputAmount,
        DstFeeData calldata feeData
    ) internal returns (address, uint256) {
        // PRE_SWAP and POST_SWAP both mean "collect fee" when there is no swap.
        if (feeData.feeType != FeeType.NO_FEE && feeData.amount != 0) {
            CurrencyLib.transfer(feeData.token, feeData.collector, feeData.amount);
        }
        return (bridgedToken, outputAmount);
    }

    /**
     * @dev Builds IBungeeExecutor.executeData calldata and dispatches it via CalldataExecutor.
     *      CalldataExecutor uses excessivelySafeCall so a revert in the target does NOT revert here;
     *      instead, `success = false` is emitted in the event for the backend to detect and handle.
     */
    function _callExecutor(
        bytes32 quoteId,
        address outputToken,
        uint256 outputAmount,
        DstExecutionData calldata execution,
        bytes calldata executionCallData
    ) internal {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = outputAmount;
        address[] memory tokens = new address[](1);
        tokens[0] = outputToken;

        bytes memory executeDataCalldata = abi.encodeCall(
            IBungeeExecutor.executeData,
            (quoteId, amounts, tokens, executionCallData)
        );

        bool success = ICalldataExecutor(CALLDATA_EXECUTOR).executeCalldata(
            execution.target,
            executeDataCalldata,
            execution.gasLimit
        );

        emit DestPayloadExecuted(quoteId, success);
    }

    /**
     * @dev Recovers the signer from a personal-sign signature and reverts if it does not match SOLVER_SIGNER.
     */
    function _verifySignature(bytes32 messageHash, bytes calldata signature) internal view {
        if (SOLVER_SIGNER != AuthenticationLib.authenticate(messageHash, signature)) {
            revert InvalidSigner();
        }
    }

    /**
     * @dev Marks `nonce` as used in a gas-efficient assembly block; reverts with InvalidNonce() if already used.
     *      Uses the same pattern as StakedRouterReceiver for consistency.
     */
    function _useNonce(uint256 nonce) internal {
        assembly {
            mstore(0, nonce)
            mstore(0x20, nonceUsed.slot)
            let dataSlot := keccak256(0, 0x40)

            if and(sload(dataSlot), 0xff) {
                mstore(0x00, 0x756688fe) // InvalidNonce()
                revert(0x1c, 0x04)
            }

            sstore(dataSlot, 0x01)
        }
    }

    /**
     * @dev Executes a single pre-action from calldata.
     *      Assembly reads the Action struct fields directly from calldata to avoid a memory copy.
     *      Does NOT revert on call failure — caller must check the return value.
     *
     *      Action calldata layout (ABI-encoded struct):
     *        action + 0  : address target (32 bytes, right-aligned)
     *        action + 32 : uint256 value
     *        action + 64 : uint256 offset to `data` field (relative to struct start = 96)
     *        action + 96 : uint256 data.length
     *        action + 128: data bytes
     */
    function _performAction(Action calldata action) internal returns (bool success) {
        assembly ("memory-safe") {
            let dataLength := calldataload(add(action, 96))
            let ptr := mload(0x40)
            // data starts at: action + 32 + data_offset = action + 32 + 96 = action + 128
            calldatacopy(ptr, add(add(action, 32), calldataload(add(action, 64))), dataLength)
            mstore(0x40, and(add(add(ptr, dataLength), 0x1f), not(0x1f)))
            success := call(gas(), calldataload(action), calldataload(add(action, 32)), ptr, dataLength, 0, 0)
        }
    }

    /**
     * @dev Executes the swap call by copying calldata directly to memory.
     *      More gas-efficient than a memory-based approach: avoids the Solidity `bytes memory` overhead.
     */
    function _execSwapCalldata(address target, uint256 value, bytes calldata data) internal returns (bool success) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            mstore(0x40, and(add(add(ptr, data.length), 0x1f), not(0x1f)))
            success := call(gas(), target, value, ptr, data.length, 0, 0)
        }
    }
}
