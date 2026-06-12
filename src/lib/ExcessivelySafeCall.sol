// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.34;

// Ported from https://github.com/nomad-xyz/ExcessivelySafeCall (modified to remove msg.value transfers).
// Used by CalldataExecutor to cap returndata copy size and prevent return-data bomb attacks from
// untrusted destination contracts.
library ExcessivelySafeCall {
    uint256 constant LOW_28_MASK = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    /// @notice Low-level call that caps the number of returndata bytes copied to memory.
    ///         Prevents a malicious callee from causing OOG by returning a huge returndata payload.
    /// @param _target The address to call.
    /// @param _gas Gas forwarded to the callee.
    /// @param _maxCopy Maximum bytes of returndata to copy into memory.
    /// @param _calldata Calldata forwarded to the callee.
    /// @return success Whether the call succeeded.
    /// @return returnData Up to `_maxCopy` bytes of returndata.
    function excessivelySafeCall(
        address _target,
        uint256 _gas,
        uint16 _maxCopy,
        bytes calldata _calldata
    ) internal returns (bool success, bytes memory returnData) {
        uint256 _toCopy;
        returnData = new bytes(_maxCopy);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, _calldata.offset, _calldata.length)
            mstore(0x40, and(add(add(ptr, _calldata.length), 0x1f), not(0x1f)))
            success := call(_gas, _target, 0, ptr, _calldata.length, 0, 0)
            _toCopy := returndatasize()
            if gt(_toCopy, _maxCopy) { _toCopy := _maxCopy }
            mstore(returnData, _toCopy)
            returndatacopy(add(returnData, 0x20), 0, _toCopy)
        }
    }
}
