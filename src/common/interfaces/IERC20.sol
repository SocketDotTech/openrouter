// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
}
