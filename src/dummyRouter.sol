// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

contract DummyRouter {
    enum CallType {
        CALL,
        STATICCALL,
        CALL_WITH_NATIVE
    }

    struct Splice {
        uint256 sourceActionIndex; // which previous return data to read from
        uint256 srcOffset; // offset inside previous returndata
        uint256 dstOffset; // offset inside current calldata
        uint256 length; // bytes to copy
    }

    struct Action {
        CallType callType;
        address target;
        bytes data;
        Splice[] splices;
    }

    error FutureSplice(uint256 actionIndex, uint256 sourceActionIndex);
    error SpliceOutOfBounds(uint256 actionIndex, uint256 spliceIndex);
    error CallFailed(uint256 actionIndex, bytes returndata);
    error MissingNativeValue(uint256 actionIndex);

    function execute(Action[] calldata actions) external payable returns (bytes[] memory results) {
        uint256 actionsLength = actions.length;
        results = new bytes[](actionsLength);

        for (uint256 i; i < actionsLength;) {
            Action calldata action = actions[i];
            bytes memory callData = action.data;

            // Patch this action's calldata using earlier action results.
            uint256 splicesLength = action.splices.length;
            for (uint256 j; j < splicesLength;) {
                Splice calldata s = action.splices[j];
                uint256 sourceActionIndex = s.sourceActionIndex;
                if (sourceActionIndex >= i) revert FutureSplice(i, sourceActionIndex);

                uint256 length = s.length;
                uint256 srcOffset = s.srcOffset;
                uint256 dstOffset = s.dstOffset;
                bytes memory source = results[sourceActionIndex];
                if (srcOffset + length > source.length || dstOffset + length > callData.length) {
                    revert SpliceOutOfBounds(i, j);
                }

                assembly ("memory-safe") {
                    mcopy(add(add(callData, 0x20), dstOffset), add(add(source, 0x20), srcOffset), length)
                }

                unchecked {
                    ++j;
                }
            }

            bool success;
            bytes memory ret;
            CallType callType = action.callType;
            address target = action.target;

            if (callType == CallType.STATICCALL) {
                (success, ret) = target.staticcall(callData);
            } else if (callType == CallType.CALL_WITH_NATIVE) {
                if (callData.length < 32) revert MissingNativeValue(i);
                uint256 callValue;
                uint256 payloadLength = callData.length - 32;
                assembly ("memory-safe") {
                    callValue := mload(add(callData, 0x20))
                    success := call(gas(), target, callValue, add(callData, 0x40), payloadLength, 0, 0)

                    let returnDataSize := returndatasize()
                    ret := mload(0x40)
                    mstore(ret, returnDataSize)
                    returndatacopy(add(ret, 0x20), 0, returnDataSize)
                    mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f)))
                }
            } else {
                (success, ret) = target.call(callData);
            }

            if (!success) revert CallFailed(i, ret);

            results[i] = ret;
            unchecked {
                ++i;
            }
        }
    }

    receive() external payable {}
}
