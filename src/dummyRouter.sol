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
        results = new bytes[](actions.length);

        for (uint256 i = 0; i < actions.length; i++) {
            bytes memory callData = actions[i].data;

            // Patch this action's calldata using earlier action results.
            for (uint256 j = 0; j < actions[i].splices.length; j++) {
                Splice calldata s = actions[i].splices[j];
                if (s.sourceActionIndex >= i) revert FutureSplice(i, s.sourceActionIndex);

                bytes memory source = results[s.sourceActionIndex];
                if (s.srcOffset + s.length > source.length || s.dstOffset + s.length > callData.length) {
                    revert SpliceOutOfBounds(i, j);
                }

                for (uint256 k = 0; k < s.length; k++) {
                    callData[s.dstOffset + k] = source[s.srcOffset + k];
                }
            }

            bool success;
            bytes memory ret;

            if (actions[i].callType == CallType.STATICCALL) {
                (success, ret) = actions[i].target.staticcall(callData);
            } else if (actions[i].callType == CallType.CALL_WITH_NATIVE) {
                if (callData.length < 32) revert MissingNativeValue(i);
                uint256 callValue;
                bytes memory payload = new bytes(callData.length - 32);
                assembly ("memory-safe") {
                    callValue := mload(add(callData, 0x20))
                    mcopy(add(payload, 0x20), add(callData, 0x40), mload(payload))
                }
                (success, ret) = actions[i].target.call{value: callValue}(payload);
            } else {
                (success, ret) = actions[i].target.call(callData);
            }

            if (!success) revert CallFailed(i, ret);

            results[i] = ret;
        }
    }

    receive() external payable {}
}
