// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

error TransferFailed();

/// @title CurrencyLib
/// @notice Token transfer + balance helpers that treat the canonical native
///         pseudo-token (`0xEee...EEe`) the same way as the marketplace's
///         CurrencyLib. Backed by Solady SafeTransferLib for ERC20.
library CurrencyLib {
    /// @dev address used to identify native token
    address internal constant NATIVE_TOKEN_ADDRESS = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

    function balanceOf(address token, address addr) internal view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            balance = addr.balance;
        } else {
            balance = SafeTransferLib.balanceOf(token, addr);
        }
    }

    function transferFrom(address token, address from, address recipient, uint256 amount) internal {
        if (token == NATIVE_TOKEN_ADDRESS) {
            _transferNative(recipient, amount);
        } else {
            SafeTransferLib.safeTransferFrom(token, from, recipient, amount);
        }
    }

    function transfer(address token, address recipient, uint256 amount) internal {
        if (token == NATIVE_TOKEN_ADDRESS) {
            _transferNative(recipient, amount);
        } else {
            SafeTransferLib.safeTransfer(token, recipient, amount);
        }
    }

    function _transferNative(address recipient, uint256 amount) private {
        (bool success,) = recipient.call{value: amount, gas: 27_000}("");
        if (!success) {
            revert TransferFailed();
        }
    }
}
