// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {BungeeOpenRouter} from "./BungeeOpenRouter.sol";
import {AllowanceHolderContext} from "../common/allowance/AllowanceHolderContext.sol";
import {ALLOWANCE_HOLDER} from "../common/interfaces/IAllowanceHolder.sol";

/// @title BungeeOpenRouterAH
/// @notice AllowanceHolder variant of `BungeeOpenRouter`. Identical flow,
///         except that user funds are pulled via 0x's AllowanceHolder
///         (transient-storage allowance) rather than a persistent ERC20
///         allowance to this contract.
///
///         Expected flow:
///           1. user (off-chain) approves AllowanceHolder for `inputToken`.
///           2. backend signer signs the same `Execution` payload as v1.
///           3. user calls `AllowanceHolder.exec(operator=this, inputToken,
///              inputAmount, target=this, callData=this.execute(...))`.
///           4. AllowanceHolder writes a transient allowance and forwards the
///              call to this contract with the user's address appended to
///              calldata (ERC-2771 style).
///           5. this contract verifies the signature, then calls
///              `AllowanceHolder.transferFrom(inputToken, user, address(this),
///              inputAmount)` to pull the funds.
///           6. remaining steps are identical to v1.
///
/// @dev We enforce `_msgSender() == exec.user` so the AllowanceHolder
///      ephemeral allowance (keyed by `operator + owner + token`) actually
///      belongs to the user named in the signed payload.
contract BungeeOpenRouterAH is BungeeOpenRouter, AllowanceHolderContext {
    error CallerNotSignedUser();

    constructor(address _owner, address _openRouterSigner) BungeeOpenRouter(_owner, _openRouterSigner) {}

    /// @notice Override the v1 fund-pull hook to use AllowanceHolder.
    /// @dev    Assembly path mirrors `0x-settler/src/core/Permit2Payment.sol`
    ///         `_allowanceHolderTransferFrom`. AllowanceHolder's `transferFrom`
    ///         either reverts or returns true, so we don't bother decoding the
    ///         return value.
    function _pullFromUser(address token, address user, uint256 amount) internal override {
        // The signed user MUST equal the original AllowanceHolder.exec caller,
        // because AllowanceHolder writes the transient allowance for
        // (operator=this, owner=msg.sender_to_AH, token).
        if (_msgSender() != user) {
            revert CallerNotSignedUser();
        }

        address allowanceHolder = address(ALLOWANCE_HOLDER);
        // Build calldata for: AllowanceHolder.transferFrom(token, user, address(this), amount)
        // Selector: 0x15dacbea = bytes4(keccak256("transferFrom(address,address,address,uint256)"))
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(0x80, ptr), amount)
            mstore(add(0x60, ptr), address())
            mstore(add(0x4c, ptr), shl(0x60, user)) // clears `recipient`'s padding
            // `shl(0x60)` (96-bit), NOT `shl(0xa0)` (160-bit): 0xa0 here is literal 160, which
            // shifts the 20-byte address out of place and corrupts the calldata token. Same as
            // 0x-settler `Permit2Payment._allowanceHolderTransferFrom`.
            mstore(add(0x2c, ptr), shl(0x60, token)) // clears `owner`'s padding (settler wording)
            mstore(add(0x0c, ptr), 0x15dacbea000000000000000000000000) // selector + token padding

            if iszero(call(gas(), allowanceHolder, 0x00, add(0x1c, ptr), 0x84, 0x00, 0x00)) {
                let p := mload(0x40)
                returndatacopy(p, 0x00, returndatasize())
                revert(p, returndatasize())
            }
        }
    }
}
