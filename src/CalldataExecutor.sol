// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {ICalldataExecutor} from "./interfaces/ICalldataExecutor.sol";
import {ExcessivelySafeCall} from "./lib/ExcessivelySafeCall.sol";

/// @title CalldataExecutor
/// @notice Satellite contract that executes arbitrary calldata on behalf of BungeeReceiver.
///         Separating execution from BungeeReceiver (the fund-holding contract) limits the attack
///         surface: a compromised or misbehaving destination target can only affect this stateless
///         proxy, not the contract holding bridged funds.
///
///         Uses `excessivelySafeCall` with MAX_COPY_BYTES = 0 to prevent return-data bomb attacks
///         from untrusted IBungeeExecutor implementations.
contract CalldataExecutor is ICalldataExecutor {
    using ExcessivelySafeCall for address;

    error OnlyBungeeReceiver();

    address public immutable BUNGEE_RECEIVER;

    /// @dev No returndata is copied — success/failure is all we need from the IBungeeExecutor call.
    uint16 public constant MAX_COPY_BYTES = 0;

    constructor(address _bungeeReceiver) {
        BUNGEE_RECEIVER = _bungeeReceiver;
    }

    /// @inheritdoc ICalldataExecutor
    function executeCalldata(address to, bytes memory encodedData, uint256 msgGasLimit) external returns (bool success) {
        if (msg.sender != BUNGEE_RECEIVER) {
            revert OnlyBungeeReceiver();
        }

        (success,) = to.excessivelySafeCall(msgGasLimit, MAX_COPY_BYTES, encodedData);
    }
}
