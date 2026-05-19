// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {BungeeOpenRouterModular} from "./BungeeOpenRouterModular.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";

/// @title BungeeOpenRouterModularAH
/// @notice AllowanceHolder variant of `BungeeOpenRouterModular`. The actual
///         AllowanceHolder pull is just one of the modular `Action`s (a
///         `CALL` to `ALLOWANCE_HOLDER` with `transferFrom(token, user, this,
///         amount)` calldata), so this contract adds very little on top of
///         the base modular contract:
///
///           - `AllowanceHolderContext` for the dummy `balanceOf` shim that
///             passes AllowanceHolder's confused-deputy probe.
///           - A new `performExecutionAH` entrypoint that takes an explicit
///             `signedUser` argument, includes it in the signed digest, and
///             enforces `_msgSender() == signedUser`. This stops a malicious
///             actor from wrapping someone else's signed payload inside their
///             own `AllowanceHolder.exec` to grief their nonce.
///
/// @dev    Even without the explicit `signedUser` check the AllowanceHolder
///         allowance scoping (`operator + owner + token`) prevents actual
///         fund theft - any pull whose `owner` differs from the AH.exec
///         caller will revert. The `signedUser` binding is purely to avoid
///         someone else burning a signed-but-unsubmitted payload.
contract BungeeOpenRouterModularAH is BungeeOpenRouterModular, AllowanceHolderContext {
    error CallerNotSignedUser();

    constructor(address _owner, address _openRouterSigner)
        BungeeOpenRouterModular(_owner, _openRouterSigner)
    {}

    /// @notice AllowanceHolder-aware entrypoint. Bind the signed payload to a
    ///         specific user so it can only be submitted via that user's
    ///         `AllowanceHolder.exec` call.
    function performExecutionAH(Execution calldata exec, address signedUser, bytes calldata signature) external payable {
        if (_msgSender() != signedUser) {
            revert CallerNotSignedUser();
        }
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), signedUser, exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _performActions(exec.actions);
    }
}
