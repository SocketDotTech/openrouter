// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/src/utils/ReentrancyGuard.sol";

import {IBungeeExecutor} from "../interfaces/IBungeeExecutor.sol";
import {AccessControl} from "../common/utils/AccessControl.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {RESCUE_ROLE} from "../common/AccessRoles.sol";

// ============ Interfaces ============ //

/// @notice Minimal interface for Hypercore's CoreDepositWallet.
interface ICoreDepositWallet {
    /**
     * @notice Deposits tokens to credit a specific recipient on Hypercore.
     * @param recipient The address receiving the tokens on Hypercore.
     * @param amount The amount of tokens being deposited.
     * @param destinationDex The destination dex on Hypercore (0 for Core Perps, uint32.max for Core Spot).
     */
    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external;
}

/// @title HypercoreDepositExecutor
/// @notice Destination-side IBungeeExecutor that forwards bridged USDC on HyperEVM into
///         Hypercore's CoreDepositWallet on behalf of the user.
/// @dev Single-output port of marketplace's HypercoreDepositBungeeExecutor.sol for the OpenRouter
///      BungeeReceiver/CalldataExecutor system. Only supports USDC on HyperEVM — the token accepted
///      by CoreDepositWallet. In case the destination execution reverts, there is an access-controlled
///      retry function as a fallback in the unlikely case funds are left stranded in this contract —
///      CalldataExecutor's `excessivelySafeCall` swallows executor reverts silently on-chain, so this
///      is load-bearing, not a nice-to-have.
contract HypercoreDepositExecutor is IBungeeExecutor, AccessControl, ReentrancyGuard {
    // ============ Errors ============

    /// @notice Thrown when a quote has already been executed
    error QuoteAlreadyExecuted();

    /// @notice Thrown when the payload cannot be decoded properly
    error InvalidPayload();

    /// @notice Thrown when the token provided doesn't match the expected deposit token
    error InvalidToken();

    /// @notice Thrown when the caller is not the OpenRouter CalldataExecutor
    error OnlyCalldataExecutor();

    // ============ Events ============

    /// @notice Emitted when a deposit to Hypercore is successfully executed
    /// @param quoteId The unique correlation ID of the OpenRouter quote
    /// @param recipient The address receiving tokens on Hypercore
    /// @param token The token deposited
    /// @param amount The amount deposited
    /// @param destinationDex The destination dex on Hypercore (0 for Core Perps, uint32.max for Core Spot)
    event DepositExecuted(
        bytes32 indexed quoteId,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint32 destinationDex
    );

    // ============ Constants ============

    /// @notice Role identifier for addresses authorized to manually execute deposits for recovery
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    // ============ State Variables ============ //

    /// @notice The address of the OpenRouter CalldataExecutor contract
    address public immutable CALLDATA_EXECUTOR;

    /// @notice The token accepted for deposits (USDC on HyperEVM)
    address public immutable DEPOSIT_TOKEN;

    /// @notice The CoreDepositWallet contract for depositing to Hypercore
    ICoreDepositWallet public coreDepositWallet;

    /// @notice Mapping to track executed quotes (prevents replay)
    mapping(bytes32 quoteId => bool executed) public quoteExecuted;

    // ============ Constructor ============ //

    /**
     * @param _owner The owner address with admin capabilities
     * @param _rescueAddress The address authorized to rescue stuck funds
     * @param _calldataExecutor The address of the OpenRouter CalldataExecutor contract
     * @param _coreDepositWallet The address of the CoreDepositWallet contract on HyperEVM
     * @param _depositToken The token accepted for deposits (USDC on HyperEVM)
     */
    constructor(
        address _owner,
        address _rescueAddress,
        address _calldataExecutor,
        address _coreDepositWallet,
        address _depositToken
    ) AccessControl(_owner) {
        CALLDATA_EXECUTOR = _calldataExecutor;
        coreDepositWallet = ICoreDepositWallet(_coreDepositWallet);
        DEPOSIT_TOKEN = _depositToken;

        _grantRole(EXECUTOR_ROLE, _owner);
        _grantRole(RESCUE_ROLE, _rescueAddress);
    }

    // ============ External Functions ============ //

    /// @inheritdoc IBungeeExecutor
    /// @dev Called by CalldataExecutor after BungeeReceiver forwards bridged USDC to this
    ///      contract. `callData` is expected to be `abi.encode(recipient, destinationDex)` — same
    ///      encoding the legacy marketplace-side HypercoreDepositBungeeExecutor already uses.
    function executeData(
        bytes32 quoteId,
        uint256 amount,
        address token,
        bytes calldata callData
    ) external payable override nonReentrant {
        if (msg.sender != CALLDATA_EXECUTOR) revert OnlyCalldataExecutor();
        if (quoteExecuted[quoteId]) revert QuoteAlreadyExecuted();
        if (token != DEPOSIT_TOKEN) revert InvalidToken();

        (address recipient, uint32 destinationDex) = _decodeAndValidatePayload(callData);
        quoteExecuted[quoteId] = true;

        _depositFor(recipient, amount, destinationDex);

        emit DepositExecuted(quoteId, recipient, token, amount, destinationDex);
    }

    /**
     * @notice Manually executes a deposit to Hypercore for recovery purposes
     * @dev Can only be called by addresses with EXECUTOR_ROLE. Used when executeData fails
     *      during fulfillment and funds are stuck in the contract.
     * @param quoteId Unique correlation ID of the OpenRouter quote (used for replay protection)
     * @param recipient The address to receive tokens on Hypercore
     * @param amount The amount to deposit
     * @param destinationDex The destination dex on Hypercore (0 for Core Perps, uint32.max for Core Spot)
     */
    function executeRequest(
        bytes32 quoteId,
        address recipient,
        uint256 amount,
        uint32 destinationDex
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant {
        if (quoteExecuted[quoteId]) revert QuoteAlreadyExecuted();
        quoteExecuted[quoteId] = true;

        _depositFor(recipient, amount, destinationDex);

        emit DepositExecuted(quoteId, recipient, DEPOSIT_TOKEN, amount, destinationDex);
    }

    // ============ Owner Only Functions ============ //

    /**
     * @notice Updates the CoreDepositWallet address
     * @dev Only callable by owner
     * @param _newCoreDepositWallet The new CoreDepositWallet address
     */
    function updateCoreDepositWallet(address _newCoreDepositWallet) external onlyOwner {
        coreDepositWallet = ICoreDepositWallet(_newCoreDepositWallet);
    }

    // ============ View Functions ============ //

    /**
     * @notice Checks if a quote has been executed
     * @param quoteId The quote ID to check
     * @return True if the quote has been executed
     */
    function isQuoteExecuted(bytes32 quoteId) external view returns (bool) {
        return quoteExecuted[quoteId];
    }

    // ============ Rescue Functions ============ //

    /**
     * @notice Rescues funds from the contract if they are stuck
     * @dev Can only be called by addresses with RESCUE_ROLE
     * @param token The address of the token to rescue
     * @param to The address to send rescued funds to
     * @param amount The amount to rescue
     */
    function rescueFunds(address token, address to, uint256 amount) external onlyRole(RESCUE_ROLE) {
        RescueFundsLib.rescueFunds(token, to, amount);
    }

    // ============ Internal Functions ============ //

    function _depositFor(address recipient, uint256 amount, uint32 destinationDex) internal {
        SafeTransferLib.safeApproveWithRetry(DEPOSIT_TOKEN, address(coreDepositWallet), amount);
        coreDepositWallet.depositFor(recipient, amount, destinationDex);
    }

    /**
     * @notice Decodes and validates the callData payload for a deposit request
     * @dev Reverts with InvalidPayload if callData is too short
     * @param callData The raw payload bytes expected to be abi.encode(address, uint32)
     * @return recipient The decoded recipient address
     * @return destinationDex The decoded destination dex on Hypercore
     */
    function _decodeAndValidatePayload(
        bytes calldata callData
    ) internal pure returns (address recipient, uint32 destinationDex) {
        if (callData.length < 64) revert InvalidPayload();
        (recipient, destinationDex) = abi.decode(callData, (address, uint32));
    }
}
