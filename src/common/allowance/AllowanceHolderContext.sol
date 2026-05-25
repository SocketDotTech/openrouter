// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ALLOWANCE_HOLDER} from "../interfaces/IAllowanceHolder.sol";

/// @title AllowanceHolderContext
/// @notice Self-contained port of 0x-settler's AllowanceHolderContext. Provides
///         `_msgSender()` that returns the original user when this contract is
///         called via `AllowanceHolder.exec(...)` (which appends the user's
///         address as the last 20 bytes of calldata, ERC-2771 style).
///         Also exposes the dummy `balanceOf(address)` so AllowanceHolder's
///         confused-deputy probe (it tries to call `balanceOf` on the target
///         to detect whether `target` looks like an ERC20) does not reject the
///         call.
abstract contract AllowanceHolderContext {
    /// @notice Returns the effective msg.sender. When the immediate caller is
    ///         `AllowanceHolder`, the trusted forwarder, the real user is
    ///         decoded from the last 20 bytes of calldata.
    function _msgSender() internal view virtual returns (address sender) {
        sender = msg.sender;
        if (sender == address(ALLOWANCE_HOLDER)) {
            // ERC-2771 style: AllowanceHolder appends the user's address as
            // the trailing 20 bytes of calldata after invoking target.
            assembly ("memory-safe") {
                sender := shr(0x60, calldataload(sub(calldatasize(), 0x14)))
            }
        }
    }

    /// @notice True if the call was forwarded by AllowanceHolder.
    function _isForwarded() internal view virtual returns (bool) {
        return msg.sender == address(ALLOWANCE_HOLDER);
    }

    /// @notice msg.data with the trailing 20-byte user address stripped when
    ///         the call was forwarded by AllowanceHolder.
    function _msgData() internal view virtual returns (bytes calldata) {
        if (msg.sender == address(ALLOWANCE_HOLDER)) {
            return msg.data[:msg.data.length - 20];
        }
        return msg.data;
    }

    /// @notice Dummy `balanceOf` implementation. AllowanceHolder probes its
    ///         `target` with `IERC20.balanceOf(...)` and reverts if the call
    ///         returns 32 bytes (i.e. target looks like an ERC20). We return
    ///         a single-byte return so the check passes, mirroring 0x-settler.
    function balanceOf(address) external pure {
        assembly ("memory-safe") {
            mstore8(0x00, 0x00)
            return(0x00, 0x01)
        }
    }
}
