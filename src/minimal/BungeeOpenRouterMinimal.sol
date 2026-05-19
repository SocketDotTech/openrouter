// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {OpenRouterAuthBase} from "../common/OpenRouterAuthBase.sol";

/// @title BungeeOpenRouterMinimal (v3, modular w/o splicing)
/// @notice Smallest possible signed-action runner. Identical surface to
///         `BungeeOpenRouterModular` minus the splice mechanism: each
///         `Action` is dispatched standalone via `CALL`, `DELEGATECALL`, or
///         `STATICCALL`, and there is no plumbing of returndata into the
///         next action's calldata.
///
///         This relies on the assumption that whenever a step needs the
///         "real" amount produced by a previous step (typical for swap-then-
///         bridge flows), the next step's target can re-read that amount
///         itself - usually by calling `balanceOf(this)` at runtime, which
///         is exactly what `BaseRouterSingleOutput`-style pre/post balance
///         deltas do already.
///
/// @dev    Same signing scheme as the other variants: personal_sign over
///         keccak256(abi.encode(chainid, this, exec)). Caller cannot reorder
///         or retarget actions; only re-submission patterns are restricted.
contract BungeeOpenRouterMinimal is OpenRouterAuthBase {
    enum CallType {
        CALL,
        DELEGATECALL,
        STATICCALL
    }

    struct Action {
        CallType callType;
        address target;
        uint256 value; // forwarded ETH; must be zero for non-CALL types
        bytes data;
    }

    struct Execution {
        Action[] actions;
        uint256 nonce;
        uint256 deadline;
    }

    error ValueOnNonCall();
    error EmptyExecution();
    error UnknownCallType();

    constructor(address _owner, address _openRouterSigner) OpenRouterAuthBase(_owner, _openRouterSigner) {}

    receive() external payable {}

    function performExecution(Execution calldata exec, bytes calldata signature) external payable virtual {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _performActions(exec.actions);
    }

    /// @notice Internal action loop, exposed to subclasses.
    function _performActions(Action[] calldata actions) internal {
        uint256 actionsLen = actions.length;
        if (actionsLen == 0) {
            revert EmptyExecution();
        }

        for (uint256 i = 0; i < actionsLen;) {
            Action calldata a = actions[i];
            _performAction(a.callType, a.target, a.value, a.data);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Dispatches a single action; bubbles any revert.
    function _performAction(CallType callType, address target, uint256 value, bytes memory data) internal virtual {
        bool ok;
        bytes memory ret;
        if (callType == CallType.CALL) {
            (ok, ret) = target.call{value: value}(data);
        } else if (callType == CallType.DELEGATECALL) {
            if (value != 0) {
                revert ValueOnNonCall();
            }
            (ok, ret) = target.delegatecall(data);
        } else if (callType == CallType.STATICCALL) {
            if (value != 0) {
                revert ValueOnNonCall();
            }
            (ok, ret) = target.staticcall(data);
        } else {
            revert UnknownCallType();
        }

        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
