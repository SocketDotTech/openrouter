// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

// @audit Audited before by Zellic: https://github.com/SocketDotTech/audits/blob/main/Socket-DL/07-2023%20-%20Data%20Layer%20-%20Zellic.pdf
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

error ZeroAddress();

/// @title RescueFundsLib
/// @notice Pull tokens or native ETH from the calling contract to a recipient.
library RescueFundsLib {
    address public constant ETH_ADDRESS = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

    error InvalidTokenAddress();

    /// @param token_ ERC20 token or `ETH_ADDRESS` for native balance.
    /// @param rescueTo_ Recipient; must not be zero.
    /// @param amount_ Amount to transfer out of `address(this)`.
    function rescueFunds(address token_, address rescueTo_, uint256 amount_) internal {
        if (rescueTo_ == address(0)) {
            revert ZeroAddress();
        }

        if (token_ == ETH_ADDRESS) {
            SafeTransferLib.safeTransferETH(rescueTo_, amount_);
        } else {
            if (token_.code.length == 0) {
                revert InvalidTokenAddress();
            }
            SafeTransferLib.safeTransfer(token_, rescueTo_, amount_);
        }
    }
}
