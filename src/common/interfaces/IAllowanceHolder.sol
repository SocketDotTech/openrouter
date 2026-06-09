// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// @dev Socket CREATE3 AllowanceHolder address. Chain-specific OpenRouter builds
//      patch this constant before compilation when needed.
IAllowanceHolder constant ALLOWANCE_HOLDER = IAllowanceHolder(0x50c4E75a512F2A14A7b304787Adf79C4531A5909);

/// @title IAllowanceHolder
/// @notice External-facing interface of 0x's AllowanceHolder contract.
///         Mirrors `0x-settler/src/allowanceholder/IAllowanceHolder.sol`.
interface IAllowanceHolder {
    /// @notice The user calls `exec(operator, token, amount, target, data)` on
    ///         AllowanceHolder. AllowanceHolder writes a transient allowance for
    ///         `(operator, msgSender, token)` of `amount`, then calls `target`
    ///         with `data` and the user's address appended ERC-2771-style.
    function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)
        external
        payable
        returns (bytes memory result);

    /// @notice Counterpart to `exec`. Called by `operator` (the OpenRouter)
    ///         to consume the transient allowance and pull `amount` of
    ///         `token` from `owner` to `recipient`.
    function transferFrom(address token, address owner, address recipient, uint256 amount) external returns (bool);
}
