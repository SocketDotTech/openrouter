// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {OpenRouterAuthBase} from "../common/OpenRouterAuthBase.sol";
import {BytesSpliceLib} from "../common/lib/BytesSpliceLib.sol";

/// @title BungeeOpenRouterModular (v2, modular + returndata splicing)
/// @notice Lightweight, generic open-router. Only signature verification is
///         hard-wired into the contract; every other step (token pull, pre-
///         swap fee, swap, post-swap fee, bridge call) is just an `Action`
///         executed via `CALL`, `DELEGATECALL`, or `STATICCALL`.
///
///         To plumb the *output of a previous step into the input calldata
///         of the next*, each `Action` carries a list of `Splice`s. Each
///         splice copies a slice of the previous action's returndata into a
///         specific byte offset of this action's calldata. This generalises
///         the single-position `mstore` patching used in `GenericStakedRoute`
///         and `BungeeApproveAndBridge` to multiple positions of any length.
///
/// @dev    The base calldata for every action comes from the caller (and is
///         therefore covered by the signature). Splices only mutate parts of
///         that base calldata - they cannot replace it wholesale, so even if
///         one of the actions returns adversarial bytes, an attacker can only
///         move signed amount-shaped data, not redirect the call target or
///         alter unrelated fields.
contract BungeeOpenRouterModular is OpenRouterAuthBase {
    enum CallType {
        CALL,
        DELEGATECALL,
        STATICCALL
    }

    /// @notice Describes a single byte-range copy from the previous action's
    ///         returndata into this action's calldata.
    struct Splice {
        uint256 srcOffset; // offset within the previous returndata
        uint256 dstOffset; // offset within this action's `data`
        uint256 length; // number of bytes to copy
    }

    /// @notice One step in the execution pipeline.
    struct Action {
        CallType callType;
        address target;
        uint256 value; // forwarded ETH; must be zero for non-CALL types
        bytes data; // mutable in memory: splices may patch parts of it
        Splice[] splices; // applied BEFORE this action runs
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

    /// @notice Executes a signed sequence of actions.
    /// @dev The signed digest binds chainId, this contract, and the entire
    ///      action set, so the caller cannot reorder, retarget, or strip
    ///      splices from any action.
    function performExecution(Execution calldata exec, bytes calldata signature) external payable virtual {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);
        _performActions(exec.actions);
    }

    /// @notice Internal executor for the action loop. Split out so variants
    ///         (e.g. the AllowanceHolder variant) can add bindings on top of
    ///         the base signature check without duplicating the loop.
    function _performActions(Action[] calldata actions) internal {
        uint256 actionsLen = actions.length;
        if (actionsLen == 0) {
            revert EmptyExecution();
        }

        bytes memory prevReturn; // empty for the first action; splices on action 0 are illegal
        for (uint256 i = 0; i < actionsLen;) {
            Action calldata a = actions[i];

            // Copy the action's data into memory so we can splice it in-place.
            bytes memory data = a.data;

            // Apply splices: copy slices from prevReturn into data.
            uint256 spLen = a.splices.length;
            for (uint256 j = 0; j < spLen;) {
                Splice calldata sp = a.splices[j];
                BytesSpliceLib.spliceBytes({
                    dst: data, // this action's calldata (base is signed; patched before dispatch)
                    dstOffset: sp.dstOffset, // write `length` bytes into `dst` starting here
                    src: prevReturn, // read from the previous action's returndata
                    srcOffset: sp.srcOffset, // copy slice starting at this offset in `src`
                    length: sp.length // number of bytes to copy (overwrites same span in `dst`)
                });
                unchecked {
                    ++j;
                }
            }

            prevReturn = _performAction(a.callType, a.target, a.value, data);

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Dispatches a single action and returns its returndata. Reverts
    ///         are bubbled with the underlying revert data.
    function _performAction(CallType callType, address target, uint256 value, bytes memory data)
        internal
        virtual
        returns (bytes memory ret)
    {
        bool ok;
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
