// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @title AuthenticationLib
/// @notice Personal-sign style signature recovery, ported from
///         marketplace/src/lib/AuthenticationLib.sol so that the OpenRouter
///         contracts in this repo can share the same signing convention as
///         Solver / StakedRouterReceiver.
library AuthenticationLib {
    /// @notice authenticate a message hash signed by the OpenRouter signer
    /// @param messageHash hash of the message
    /// @param signature 65-byte (r,s,v) signature over `personal_sign(messageHash)`
    /// @return signer address recovered from the signature
    function authenticate(bytes32 messageHash, bytes calldata signature) internal pure returns (address) {
        bytes32 ethSignedMessageHash = getEthSignedMessageHash(messageHash);
        return recoverSigner(ethSignedMessageHash, signature);
    }

    /// @notice wraps the digest with the EIP-191 personal_sign prefix
    function getEthSignedMessageHash(bytes32 _messageHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
    }

    /// @notice ecrecover wrapper
    function recoverSigner(bytes32 _ethSignedMessageHash, bytes calldata _signature) internal pure returns (address) {
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(_signature);
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }

    /// @notice splits a 65-byte signature into r, s, v
    function splitSignature(bytes calldata sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "invalid signature length");
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }
}
