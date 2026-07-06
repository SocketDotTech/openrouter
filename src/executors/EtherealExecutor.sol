// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {ReentrancyGuard} from "solady/src/utils/ReentrancyGuard.sol";

import {IBungeeExecutor} from "../interfaces/IBungeeExecutor.sol";
import {AccessControl} from "../common/utils/AccessControl.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";
import {RESCUE_ROLE} from "../common/AccessRoles.sol";

// ============ Interfaces ============ //

/// @notice Minimal interface for ICollateralManager, used by IExchangeGateway.
interface ICollateralManager {
    struct DepositOnBehalfRequest {
        address account;
        bytes32 subaccount;
        bytes32 tokenName;
        uint256 amount;
    }
}

/// @notice Minimal interface for Ethereal's ExchangeGateway deposit entrypoint.
interface IExchangeGateway {
    function depositOnBehalf(
        ICollateralManager.DepositOnBehalfRequest[] calldata params,
        bytes32 referralCode
    ) external payable;
}

/// @title EtherealExecutor
/// @notice Destination-side IBungeeExecutor that deposits bridged USDe into Ethereal's
///         ExchangeGateway on behalf of the user.
/// @dev Single-output port of marketplace's EtherealDepositHandler.sol for the OpenRouter
///      BungeeReceiver/CalldataExecutor system. USDe is Ethereal's native gas token, so bridged
///      funds arrive here as native value and are forwarded via `depositOnBehalf{value: amount}`.
///      In case the destination execution reverts, there is an access-controlled retry function
///      as a fallback in the unlikely case funds are left stranded in this contract.
contract EtherealExecutor is IBungeeExecutor, AccessControl, ReentrancyGuard {
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

    /// @notice Emitted when a deposit to Ethereal is successfully executed
    /// @param quoteId The unique correlation ID of the OpenRouter quote
    /// @param recipient The address receiving tokens on Ethereal
    /// @param token The token deposited
    /// @param amount The amount deposited
    event DepositExecuted(
        bytes32 indexed quoteId,
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    // ============ Constants ============

    /// @notice Role identifier for addresses authorized to manually execute deposits
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @notice referralCode for Bungee
    bytes32 public constant BUNGEE_REFERRAL_CODE = bytes32("BUNGEE");

    /// @notice bytes32 identifier for primary account
    bytes32 public constant PRIMARY_SUB_ACCOUNT = bytes32("primary");

    /// @notice bytes32 identifier USDe token name
    bytes32 public constant USD_TOKEN_NAME = bytes32("USD");

    // ============ State Variables ============ //

    /// @notice The address of the OpenRouter CalldataExecutor contract
    address public immutable CALLDATA_EXECUTOR;

    /// @notice The token accepted for deposits (native sentinel — USDe is Ethereal's gas token)
    address public immutable DEPOSIT_TOKEN;

    /// @notice The ExchangeGateway contract for depositing to Ethereal
    IExchangeGateway public exchangeGateway;

    /// @notice Mapping to track executed quotes (prevents replay)
    mapping(bytes32 quoteId => bool executed) public quoteExecuted;

    // ============ Constructor ============ //

    /**
     * @param _owner The owner address with admin capabilities
     * @param _rescueAddress The address authorized to rescue stuck funds
     * @param _calldataExecutor The address of the OpenRouter CalldataExecutor contract
     * @param _exchangeGateway The address of the ExchangeGateway contract on Ethereal
     * @param _depositToken The token accepted for deposits (native sentinel for USDe on Ethereal)
     */
    constructor(
        address _owner,
        address _rescueAddress,
        address _calldataExecutor,
        address _exchangeGateway,
        address _depositToken
    ) AccessControl(_owner) {
        CALLDATA_EXECUTOR = _calldataExecutor;
        exchangeGateway = IExchangeGateway(_exchangeGateway);
        DEPOSIT_TOKEN = _depositToken;

        _grantRole(EXECUTOR_ROLE, _owner);
        _grantRole(RESCUE_ROLE, _rescueAddress);
    }

    // ============ External Functions ============ //

    /// @inheritdoc IBungeeExecutor
    /// @dev Called by CalldataExecutor after BungeeReceiver forwards bridged funds to this
    ///      contract. `callData` is expected to be `abi.encode(recipient)`.
    function executeData(
        bytes32 quoteId,
        uint256 amount,
        address token,
        bytes calldata callData
    ) external payable override nonReentrant {
        if (msg.sender != CALLDATA_EXECUTOR) revert OnlyCalldataExecutor();
        if (quoteExecuted[quoteId]) revert QuoteAlreadyExecuted();
        if (token != DEPOSIT_TOKEN) revert InvalidToken();

        address recipient = _decodeAndValidatePayload(callData);
        quoteExecuted[quoteId] = true;

        _depositOnBehalf(recipient, amount);

        emit DepositExecuted(quoteId, recipient, token, amount);
    }

    /**
     * @notice Manually executes a deposit to Ethereal for recovery purposes
     * @dev Can only be called by addresses with EXECUTOR_ROLE. Used when executeData fails
     *      during fulfillment and funds are stuck in the contract.
     * @param quoteId Unique correlation ID of the OpenRouter quote (used for replay protection)
     * @param recipient The address to receive tokens on Ethereal
     * @param amount The amount to deposit
     */
    function executeRequest(
        bytes32 quoteId,
        address recipient,
        uint256 amount
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant {
        if (quoteExecuted[quoteId]) revert QuoteAlreadyExecuted();
        quoteExecuted[quoteId] = true;

        _depositOnBehalf(recipient, amount);

        emit DepositExecuted(quoteId, recipient, DEPOSIT_TOKEN, amount);
    }

    // ============ Owner Only Functions ============ //

    /**
     * @notice Updates the ExchangeGateway address
     * @dev Only callable by owner
     * @param _newExchangeGateway The new ExchangeGateway address
     */
    function updateExchangeGateway(address _newExchangeGateway) external onlyOwner {
        exchangeGateway = IExchangeGateway(_newExchangeGateway);
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

    /// @notice receive native token (i.e USDe)
    receive() external payable {}

    // ============ Internal Functions ============ //

    function _depositOnBehalf(address recipient, uint256 amount) internal {
        ICollateralManager.DepositOnBehalfRequest[] memory requests = new ICollateralManager.DepositOnBehalfRequest[](
            1
        );

        requests[0] = ICollateralManager.DepositOnBehalfRequest({
            account: recipient,
            subaccount: PRIMARY_SUB_ACCOUNT,
            tokenName: USD_TOKEN_NAME,
            amount: amount
        });

        exchangeGateway.depositOnBehalf{value: amount}(requests, BUNGEE_REFERRAL_CODE);
    }

    /**
     * @notice Decodes and validates the callData payload for a deposit request
     * @dev Reverts with InvalidPayload if callData is too short
     * @param callData The raw payload bytes expected to be abi.encode(address)
     * @return recipient The decoded recipient address
     */
    function _decodeAndValidatePayload(bytes calldata callData) internal pure returns (address recipient) {
        if (callData.length < 32) revert InvalidPayload();
        recipient = abi.decode(callData, (address));
    }
}
