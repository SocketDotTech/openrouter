// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {AccessControl} from "../common/utils/AccessControl.sol";
import {AuthenticationLib} from "../common/lib/AuthenticationLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {RESCUE_ROLE} from "../common/AccessRoles.sol";
import {IMessageTransmitter} from "../interfaces/IMessageTransmitter.sol";

/// @title CctpClaimExecutor
/// @notice Destination-side CCTP v2 claim executor that receives attested messages,
///         mints USDC via Circle MessageTransmitter, deducts a relay fee, and forwards net USDC.
/// @dev Source burns must set `mintRecipient` and `destinationCaller` to this contract.
///      Claim execution is gated by a SOLVER_SIGNER ECDSA signature over all claim parameters.
contract CctpClaimExecutor is AccessControl {
    error InvalidSigner();
    error ZeroAddress();
    error MessageAlreadyClaimed();
    error InsufficientMintedAmount();
    error ReceiveMessageFailed();

    /// @dev Byte offset of the bytes32 nonce in a CCTP v2 message header.
    uint256 internal constant MESSAGE_NONCE_BYTE_OFFSET = 12;

    event CctpClaimExecuted(
        bytes32 indexed messageNonce,
        address indexed recipient,
        address indexed feeTaker,
        uint256 relayFee,
        uint256 netAmount
    );

    event SolverSignerUpdated(address indexed newSigner);

    IMessageTransmitter public immutable MESSAGE_TRANSMITTER;
    address public immutable USDC;
    address public SOLVER_SIGNER;

    mapping(bytes32 => bool) public messageNonceClaimed;

    /**
     * @param _owner Admin; also granted RESCUE_ROLE.
     * @param _messageTransmitter Circle CCTP v2 MessageTransmitter on this chain.
     * @param _solverSigner Transmitter/backend signer that authorises claim calls.
     * @param _usdc Native Circle USDC on this chain (minted by receiveMessage).
     */
    constructor(address _owner, address _messageTransmitter, address _solverSigner, address _usdc) AccessControl(_owner) {
        if (_messageTransmitter == address(0) || _solverSigner == address(0) || _usdc == address(0)) {
            revert ZeroAddress();
        }

        _grantRole(RESCUE_ROLE, _owner);
        MESSAGE_TRANSMITTER = IMessageTransmitter(_messageTransmitter);
        SOLVER_SIGNER = _solverSigner;
        USDC = _usdc;
    }

    /**
     * @notice Update the signer address used to authorise claim calls.
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
     * @notice Claim a CCTP v2 attested message, take relay fee in USDC, and forward net to recipient.
     * @param message Circle attestation message bytes.
     * @param attestation Circle attestation signature bytes.
     * @param recipient End-user USDC recipient.
     * @param feeTaker Relay fee recipient (e.g. protocol treasury).
     * @param quotedRelayFee USDC amount (6 decimals) to deduct as relay fee.
     * @param signature SOLVER_SIGNER personal-sign signature over all parameters.
     */
    function claim(
        bytes calldata message,
        bytes calldata attestation,
        address recipient,
        address feeTaker,
        uint256 quotedRelayFee,
        bytes calldata signature
    ) external {
        if (recipient == address(0) || feeTaker == address(0)) {
            revert ZeroAddress();
        }

        _verifySignature(
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    message,
                    attestation,
                    recipient,
                    feeTaker,
                    quotedRelayFee
                )
            ),
            signature
        );

        bytes32 messageNonce = _extractMessageNonce(message);
        if (messageNonceClaimed[messageNonce]) {
            revert MessageAlreadyClaimed();
        }
        messageNonceClaimed[messageNonce] = true;

        uint256 balanceBefore = CurrencyLib.balanceOf(USDC, address(this));

        bool success = MESSAGE_TRANSMITTER.receiveMessage(message, attestation);
        if (!success) {
            revert ReceiveMessageFailed();
        }

        uint256 mintedAmount = CurrencyLib.balanceOf(USDC, address(this)) - balanceBefore;
        if (mintedAmount < quotedRelayFee) {
            revert InsufficientMintedAmount();
        }

        uint256 netAmount = mintedAmount - quotedRelayFee;

        CurrencyLib.transfer(USDC, feeTaker, quotedRelayFee);
        CurrencyLib.transfer(USDC, recipient, netAmount);

        emit CctpClaimExecuted(messageNonce, recipient, feeTaker, quotedRelayFee, netAmount);
    }

    /**
     * @notice Rescue funds locked in the contract by mistake.
     */
    function rescueFunds(address token, address rescueTo, uint256 amount) external onlyRole(RESCUE_ROLE) {
        RescueFundsLib.rescueFunds(token, rescueTo, amount);
    }

    function _verifySignature(bytes32 messageHash, bytes calldata signature) internal view {
        if (SOLVER_SIGNER != AuthenticationLib.authenticate(messageHash, signature)) {
            revert InvalidSigner();
        }
    }

    function _extractMessageNonce(bytes calldata message) internal pure returns (bytes32 messageNonce) {
        require(message.length >= MESSAGE_NONCE_BYTE_OFFSET + 32, "invalid message length");

        assembly {
            messageNonce := calldataload(add(message.offset, MESSAGE_NONCE_BYTE_OFFSET))
        }
    }
}
