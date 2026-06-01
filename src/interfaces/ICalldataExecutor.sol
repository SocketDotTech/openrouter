// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @title ICalldataExecutor
/// @notice Interface for the CalldataExecutor satellite contract.
///         Kept separate from BungeeReceiver to reduce the attack surface of the fund-holding contract.
interface ICalldataExecutor {
    /// @notice Executes encoded calldata on a destination contract using a gas-capped safe call.
    /// @param to The target contract address (must implement IBungeeExecutor).
    /// @param encodedData ABI-encoded calldata forwarded to `to`.
    /// @param msgGasLimit Gas forwarded to the call; prevents unbounded gas consumption.
    /// @return success Whether the call succeeded.
    function executeCalldata(address to, bytes calldata encodedData, uint256 msgGasLimit) external returns (bool success);
}
