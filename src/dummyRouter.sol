// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

contract DummyRouter {
    enum CallType {
        CALL,
        STATICCALL,
        CALL_WITH_NATIVE
    }

    struct Action {
        uint256 actionInfo;
        bytes data;
        uint256[] splices;
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
                uint256 spliceInfo = action.splices[j];
                uint256 sourceActionIndex = uint64(spliceInfo);
                if (sourceActionIndex >= i) revert FutureSplice(i, sourceActionIndex);

                uint256 srcOffset = uint64(spliceInfo >> 64);
                uint256 dstOffset = uint64(spliceInfo >> 128);
                uint256 length = spliceInfo >> 192;
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
            uint256 actionInfo = action.actionInfo;
            bool storeResult = (actionInfo & 0xff00) != 0;
            uint256 callType = actionInfo & 0xff;
            address target = address(uint160(actionInfo >> 16));

            if (callType == uint256(CallType.STATICCALL)) {
                assembly ("memory-safe") {
                    success := staticcall(gas(), target, add(callData, 0x20), mload(callData), 0, 0)
                }
            } else if (callType == uint256(CallType.CALL_WITH_NATIVE)) {
                if (callData.length < 32) revert MissingNativeValue(i);
                uint256 callValue;
                uint256 payloadLength = callData.length - 32;
                assembly ("memory-safe") {
                    callValue := mload(add(callData, 0x20))
                    success := call(gas(), target, callValue, add(callData, 0x40), payloadLength, 0, 0)
                }
            } else {
                assembly ("memory-safe") {
                    success := call(gas(), target, 0, add(callData, 0x20), mload(callData), 0, 0)
                }
            }

            if (!success || storeResult) {
                bytes memory ret;
                assembly ("memory-safe") {
                    let returnDataSize := returndatasize()
                    ret := mload(0x40)
                    mstore(ret, returnDataSize)
                    returndatacopy(add(ret, 0x20), 0, returnDataSize)
                    mstore(0x40, and(add(add(add(ret, 0x20), returnDataSize), 0x1f), not(0x1f)))
                }
                if (!success) revert CallFailed(i, ret);
                results[i] = ret;
            }
            unchecked {
                ++i;
            }
        }
    }

    receive() external payable {}
}
