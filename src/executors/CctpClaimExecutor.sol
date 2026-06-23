// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {AccessControl} from "../common/utils/AccessControl.sol";
import {AuthenticationLib} from "../common/lib/AuthenticationLib.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {RESCUE_ROLE} from "../common/AccessRoles.sol";
import {IMessageTransmitter} from "../interfaces/IMessageTransmitter.sol";

/// @title CctpClaimExecutor
/// @notice Destination-side CCTP v2 claim executor that receives attested messages,
///         mints USDC via Circle MessageTransmitter, deducts a relay fee, and forwards net USDC.
/// @dev Source burns must set `mintRecipient` and `destinationCaller` to this contract.
///      Claim execution is gated by a SOLVER_SIGNER ECDSA signature over all claim parameters.
///      Replay protection is delegated to Circle MessageTransmitter `usedNonces`.
contract CctpClaimExecutor is AccessControl {
    error InvalidSigner();
    error ZeroAddress();

    event SolverSignerUpdated(address indexed newSigner);

    IMessageTransmitter public immutable MESSAGE_TRANSMITTER;
    address public immutable USDC;
    address public SOLVER_SIGNER;

    /**
     * @param _owner Admin; also granted RESCUE_ROLE.
     * @param _messageTransmitter Circle CCTP v2 MessageTransmitter on this chain.
     * @param _solverSigner Transmitter/backend signer that authorises claim calls.
     * @param _usdc Native Circle USDC on this chain (minted by receiveMessage).
     */
    constructor(
        address _owner,
        address _messageTransmitter,
        address _solverSigner,
        address _usdc
    ) AccessControl(_owner) {
        if (
            _messageTransmitter == address(0) ||
            _solverSigner == address(0) ||
            _usdc == address(0)
        ) {
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
        if (
            SOLVER_SIGNER !=
            AuthenticationLib.authenticate(
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
            )
        ) {
            revert InvalidSigner();
        }

        uint256 balanceBefore = SafeTransferLib.balanceOf(USDC, address(this));

        MESSAGE_TRANSMITTER.receiveMessage(message, attestation);

        uint256 mintedAmount = SafeTransferLib.balanceOf(USDC, address(this)) -
            balanceBefore;

        unchecked {
            SafeTransferLib.safeTransfer(USDC, feeTaker, quotedRelayFee);
            SafeTransferLib.safeTransfer(
                USDC,
                recipient,
                mintedAmount - quotedRelayFee
            );
        }
    }

    /**
     * @notice Rescue funds locked in the contract by mistake.
     */
    function rescueFunds(
        address token,
        address rescueTo,
        uint256 amount
    ) external onlyRole(RESCUE_ROLE) {
        RescueFundsLib.rescueFunds(token, rescueTo, amount);
    }
}
