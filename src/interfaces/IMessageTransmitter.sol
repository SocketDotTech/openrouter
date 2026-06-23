// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @notice Minimal Circle CCTP v2 MessageTransmitter surface used by CctpClaimExecutor.
interface IMessageTransmitter {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);

    function usedNonces(bytes32 nonce) external view returns (uint256);
}
