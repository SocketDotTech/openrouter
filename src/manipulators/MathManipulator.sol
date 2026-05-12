// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

/// @notice Generic arithmetic helpers for router calldata splicing.
contract MathManipulator {
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    function add(uint256 a, uint256 b) external pure returns (uint256) {
        return a + b;
    }

    function subtract(uint256 a, uint256 b) external pure returns (uint256) {
        return a - b;
    }

    function percent(uint256 amount, uint256 bps) external pure returns (uint256) {
        return amount * bps / BPS_DENOMINATOR;
    }
}
