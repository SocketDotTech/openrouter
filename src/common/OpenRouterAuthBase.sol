// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {Ownable} from "./utils/Ownable.sol";
import {AuthenticationLib} from "./lib/AuthenticationLib.sol";

/// @title OpenRouterAuthBase
/// @notice Shared signer + nonce machinery for the OpenRouter contract family.
///         Mirrors the `Solver` / `StakedRouterReceiver` model:
///           - single rotatable backend signer (`OPEN_ROUTER_SIGNER`)
///           - personal-sign signature recovery via `AuthenticationLib`
///           - single-use nonces marked via the same assembly pattern
///         No reentrancy guard: protection is signature + single-use nonce
///         scoped to one transaction, identical to the marketplace solver
///         family. Callers (the Bungee backend) MUST sign over a payload that
///         binds chainId and `address(this)` so a leaked signature cannot be
///         replayed across chains or sister deployments.
abstract contract OpenRouterAuthBase is Ownable {
    error InvalidSigner();
    error InvalidNonce();
    error DeadlineExpired();

    /// @notice Address that signs the execution payload on behalf of the
    ///         backend solver / router orchestration service.
    address internal OPEN_ROUTER_SIGNER;

    /// @notice Tracks consumed nonces. We don't use a bitmap because the
    ///         marketplace solvers don't either, and per-tx nonce churn is
    ///         small relative to a typical user flow.
    mapping(uint256 nonce => bool isNonceUsed) public nonceUsed;

    event OpenRouterSignerUpdated(address indexed previousSigner, address indexed newSigner);

    constructor(address _owner, address _openRouterSigner) Ownable(_owner) {
        OPEN_ROUTER_SIGNER = _openRouterSigner;
        emit OpenRouterSignerUpdated(address(0), _openRouterSigner);
    }

    /// @notice Rotates the trusted signer.
    function setOpenRouterSigner(address _openRouterSigner) external onlyOwner {
        emit OpenRouterSignerUpdated(OPEN_ROUTER_SIGNER, _openRouterSigner);
        OPEN_ROUTER_SIGNER = _openRouterSigner;
    }

    function openRouterSigner() external view returns (address) {
        return OPEN_ROUTER_SIGNER;
    }

    /// @notice Verifies a signature over `digest` was produced by the trusted
    ///         signer, marks `nonce` as consumed, and enforces `deadline`.
    /// @dev Uses the exact assembly pattern from `Solver.sol` to mark the
    ///      nonce as used and revert with `InvalidNonce()` if already used.
    function _verifyAndConsume(bytes32 digest, uint256 nonce, uint256 deadline, bytes memory signature) internal {
        if (block.timestamp > deadline) {
            revert DeadlineExpired();
        }

        if (AuthenticationLib.authenticate(digest, signature) != OPEN_ROUTER_SIGNER) {
            assembly {
                mstore(0x00, 0x815e1d64) // revert InvalidSigner();
                revert(0x1c, 0x04)
            }
        }

        // verify and consume nonce
        assembly {
            mstore(0, nonce)
            mstore(0x20, nonceUsed.slot)
            let dataSlot := keccak256(0, 0x40)

            if and(sload(dataSlot), 0xff) {
                mstore(0x00, 0x756688fe) // revert InvalidNonce();
                revert(0x1c, 0x04)
            }

            // mark as used; not cleaning all bits, just setting first bit to 1
            sstore(dataSlot, 0x01)
        }
    }

    /// @notice Performs a single low-level call and bubbles any revert.
    function _performAction(address target, uint256 value, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
