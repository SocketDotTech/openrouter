// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {BungeeOpenRouterMinimal} from "./BungeeOpenRouterMinimal.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";

/// @title BungeeOpenRouterMinimalAH
/// @notice AllowanceHolder variant of `BungeeOpenRouterMinimal`. Adds the
///         confused-deputy `balanceOf` shim and a user-bound entrypoint that
///         pins the signed payload to a specific `signedUser` (the AH.exec
///         caller). Apart from that, the action loop is identical to v3.
contract BungeeOpenRouterMinimalAH is BungeeOpenRouterMinimal, AllowanceHolderContext {
    error CallerNotSignedUser();

    constructor(address _owner, address _openRouterSigner)
        BungeeOpenRouterMinimal(_owner, _openRouterSigner)
    {}

    /// @notice AllowanceHolder-aware entrypoint. Same role as
    ///         `BungeeOpenRouterModularAH.performExecutionAH` - prevents a
    ///         signed payload meant for user A from being submitted via user
    ///         B's AllowanceHolder.exec to grief user A's nonce.
    function performExecutionAH(Execution calldata exec, address signedUser, bytes calldata signature) external payable {
        if (_msgSender() != signedUser) {
            revert CallerNotSignedUser();
        }
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), signedUser, exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _performActions(exec.actions);
    }
}
