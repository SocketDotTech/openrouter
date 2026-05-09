// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

contract DummyRouter {

    enum CallType {
        CALL,
        STATICCALL
    }

    struct Splice {
        uint256 sourceActionIndex; // which previous return data to read from
        uint256 srcOffset;         // offset inside previous returndata
        uint256 dstOffset;         // offset inside current calldata
        uint256 length;            // bytes to copy
    }

    struct Action {
        CallType callType;
        address target;
        uint256 value;
        bytes data;
        Splice[] splices;
    }

    function execute(Action[] calldata actions) external payable returns (bytes[] memory results) {
        results = new bytes[](actions.length);

        for (uint256 i = 0; i < actions.length; i++) {
            bytes memory callData = actions[i].data;

            // Patch this action's calldata using earlier action results.
            for (uint256 j = 0; j < actions[i].splices.length; j++) {
                Splice calldata s = actions[i].splices[j];

                bytes memory source = results[s.sourceActionIndex];

                _copyBytes({
                    src: source,
                    dst: callData,
                    srcOffset: s.srcOffset,
                    dstOffset: s.dstOffset,
                    length: s.length
                });
            }

            bool success;
            bytes memory ret;

            if (actions[i].callType == CallType.STATICCALL) {
                (success, ret) = actions[i].target.staticcall(callData);
            } else {
                (success, ret) = actions[i].target.call{value: actions[i].value}(callData);
            }

            if (!success) revert CallFailed(i, ret);

            results[i] = ret;
        }
    }
}
