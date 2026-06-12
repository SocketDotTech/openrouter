// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

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
///           4. Output token + amount are transferred to the IBungeeExecutor target.
///           5. `CalldataExecutor.executeCalldata` is called, which invokes
///              `IBungeeExecutor.executeData` on the target via excessivelySafeCall.
///
///         Security: all execution paths are gated behind an ECDSA signature from `SOLVER_SIGNER`
///         combined with a one-time nonce. Funds never leave the contract without a valid sig.
///         Arbitrary calldata execution is delegated to `CalldataExecutor` (a separate stateless
///         proxy) so that a misbehaving destination cannot affect funds still held here.
contract BungeeReceiver is AccessControl {
    // =========================================================================
    // Structs
    // =========================================================================

    /// @dev All fields covered by the SOLVER_SIGNER signature.
    ///      Kept as fixed-size fields only — `executionCallData` is passed as a separate
    ///      parameter and included in the signature hash via keccak256, avoiding the ABI
    ///      overhead (offset word + length prefix) that a `bytes` field inside a struct would add.
    struct DestPayload {
        uint256 nonce;
        /// @dev Caller-defined correlation ID for cross-chain tracking.
        bytes32 quoteId;
        /// @dev Token delivered by the bridge to this contract.
        address bridgedToken;
        /// @dev IBungeeExecutor target — always required; funds are sent here then executeData is called.
        address target;
        /// @dev Net token amount to forward. Backend derives this from the bridge tx receipt.
        uint256 outputAmount;
        /// @dev Gas forwarded to the CalldataExecutor → IBungeeExecutor call.
        uint256 gasLimit;
    }

    // =========================================================================
    // Errors
    // =========================================================================

    error InvalidSigner();
    error InvalidNonce();
    error InvalidExecution();
    error ZeroAddress();
    error QuoteAlreadyExecuted();

    // =========================================================================
    // Events
    // =========================================================================

    /// @param quoteId Correlation ID of the executed quote.
    /// @param success Whether the IBungeeExecutor.executeData call succeeded.
    event DestPayloadExecuted(bytes32 indexed quoteId, bool success);

    event SolverSignerUpdated(address indexed newSigner);

    // =========================================================================
    // State
    // =========================================================================

    address public SOLVER_SIGNER;
    address public immutable CALLDATA_EXECUTOR;

    mapping(uint256 => bool) public nonceUsed;
    mapping(bytes32 => bool) public quoteIdExecuted;

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @param _owner Initial owner; also granted RESCUE_ROLE.
     * @param _solverSigner Address whose ECDSA signatures authorise `executeDestPayload` calls.
     * @param _calldataExecutor Address of the CalldataExecutor satellite contract.
     */
    constructor(address _owner, address _solverSigner, address _calldataExecutor) AccessControl(_owner) {
        if (_solverSigner == address(0) || _calldataExecutor == address(0)) {
            revert ZeroAddress();
        }
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
        if (_solverSigner == address(0)) {
            revert ZeroAddress();
        }
        SOLVER_SIGNER = _solverSigner;
        emit SolverSignerUpdated(_solverSigner);
    }

    /**
     * @notice Execute destination payload after bridge funds have landed in this contract.
     *
     * @dev The backend constructs this call after reading the exact received amount from the bridge
     *      tx receipt. Every field of `payload` plus `executionCallData` is covered by the
     *      SOLVER_SIGNER signature — modifying any field invalidates the signature.
     *
     *      `executionCallData` is passed separately (not embedded in the struct) so that
     *      `abi.encode(payload)` remains a flat fixed-size blob; the bytes field is committed
     *      to via its keccak256 hash in the signature preimage instead.
     *
     * @param payload            All signed execution parameters.
     * @param executionCallData  Protocol-specific calldata forwarded to IBungeeExecutor.executeData.
     * @param signature          SOLVER_SIGNER personal-sign signature.
     */
    function executeDestPayload(
        DestPayload calldata payload,
        bytes calldata executionCallData,
        bytes calldata signature
    ) external {
        if (payload.target == address(0)) {
            revert InvalidExecution();
        }

        _verifySignature(
            keccak256(abi.encode(block.chainid, address(this), payload, keccak256(executionCallData))),
            signature
        );

        _useNonce(payload.nonce);

        if (quoteIdExecuted[payload.quoteId]) {
            revert QuoteAlreadyExecuted();
        }
        quoteIdExecuted[payload.quoteId] = true;

        // Transfer bridged funds to the IBungeeExecutor target before calling it (CEI).
        CurrencyLib.transfer(payload.bridgedToken, payload.target, payload.outputAmount);

        bool success = _callExecutor(payload.quoteId, payload.bridgedToken, payload.outputAmount, payload.target, payload.gasLimit, executionCallData);

        emit DestPayloadExecuted(payload.quoteId, success);
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
     * @dev Encodes and dispatches IBungeeExecutor.executeData via CalldataExecutor.
     *      CalldataExecutor uses excessivelySafeCall so a revert in the target does NOT revert here;
     *      `success` is emitted in the event for the backend to detect and handle.
     */
    function _callExecutor(
        bytes32 quoteId,
        address token,
        uint256 amount,
        address target,
        uint256 gasLimit,
        bytes calldata executionCallData
    ) internal returns (bool success) {
        bytes memory executeDataCalldata = abi.encodeCall(
            IBungeeExecutor.executeData,
            (quoteId, amount, token, executionCallData)
        );

        success = ICalldataExecutor(CALLDATA_EXECUTOR).executeCalldata(target, executeDataCalldata, gasLimit);
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
     * @dev Marks `nonce` as used; reverts with InvalidNonce() if already consumed.
     *      Uses assembly for direct mapping slot computation, avoiding the Solidity keccak256
     *      call overhead and a redundant SLOAD for the bool-to-uint cast.
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
}
