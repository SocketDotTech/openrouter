// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @title IBungeeExecutor
/// @notice Interface for contracts that receive bridge output funds and execute destination calldata.
///         Implementors must have a simple `receive() external payable {}` when accepting native ETH.
interface IBungeeExecutor {
    /// @notice Called by BungeeReceiver after funds have been transferred to this contract.
    /// @param quoteId Correlation ID linking this execution to the original source-chain quote.
    /// @param amounts Token amounts transferred to this contract (one per token in `tokens`).
    /// @param tokens Token addresses corresponding to each entry in `amounts`
    ///               (use 0xEeee...EEeE sentinel for native ETH).
    /// @param callData Protocol-specific calldata encoding the final action (e.g. Aave deposit params).
    function executeData(
        bytes32 quoteId,
        uint256[] calldata amounts,
        address[] calldata tokens,
        bytes calldata callData
    ) external payable;
}
