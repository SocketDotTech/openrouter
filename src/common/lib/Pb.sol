// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @notice Runtime protobuf decoder for Celer withdraw messages.
library Pb {
    enum WireType {
        Varint,
        Fixed64,
        LengthDelim,
        StartGroup,
        EndGroup,
        Fixed32
    }

    struct Buffer {
        uint256 idx;
        bytes b;
    }

    function fromBytes(bytes memory raw) internal pure returns (Buffer memory buf) {
        buf.b = raw;
        buf.idx = 0;
    }

    function hasMore(Buffer memory buf) internal pure returns (bool) {
        return buf.idx < buf.b.length;
    }

    function decKey(Buffer memory buf) internal pure returns (uint256 tag, WireType wiretype) {
        uint256 v = decVarint(buf);
        tag = v / 8;
        wiretype = WireType(v & 7);
    }

    function decVarint(Buffer memory buf) internal pure returns (uint256 v) {
        bytes10 tmp;
        bytes memory bb = buf.b;
        v = buf.idx;
        assembly ("memory-safe") {
            tmp := mload(add(add(bb, 32), v))
        }
        uint256 b;
        v = 0;
        for (uint256 i = 0; i < 10; i++) {
            assembly ("memory-safe") {
                b := byte(i, tmp)
            }
            v |= (b & 0x7F) << (i * 7);
            if (b & 0x80 == 0) {
                buf.idx += i + 1;
                return v;
            }
        }
        revert();
    }

    function decBytes(Buffer memory buf) internal pure returns (bytes memory b) {
        uint256 len = decVarint(buf);
        uint256 end = buf.idx + len;
        require(end <= buf.b.length);
        b = new bytes(len);
        bytes memory bufB = buf.b;
        uint256 bStart;
        uint256 bufBStart = buf.idx;
        assembly ("memory-safe") {
            bStart := add(b, 32)
            bufBStart := add(add(bufB, 32), bufBStart)
        }
        for (uint256 i = 0; i < len; i += 32) {
            assembly ("memory-safe") {
                mstore(add(bStart, i), mload(add(bufBStart, i)))
            }
        }
        buf.idx = end;
    }

    function skipValue(Buffer memory buf, WireType wire) internal pure {
        if (wire == WireType.Varint) {
            decVarint(buf);
        } else if (wire == WireType.LengthDelim) {
            uint256 len = decVarint(buf);
            buf.idx += len;
            require(buf.idx <= buf.b.length);
        } else {
            revert();
        }
    }

    function _uint256(bytes memory b) internal pure returns (uint256 v) {
        require(b.length <= 32);
        assembly ("memory-safe") {
            v := mload(add(b, 32))
        }
        v = v >> (8 * (32 - b.length));
    }

    function _address(bytes memory b) internal pure returns (address v) {
        v = _addressPayable(b);
    }

    function _addressPayable(bytes memory b) internal pure returns (address payable v) {
        require(b.length == 20);
        assembly ("memory-safe") {
            v := div(mload(add(b, 32)), 0x1000000000000000000000000)
        }
    }

    function _bytes32(bytes memory b) internal pure returns (bytes32 v) {
        require(b.length == 32);
        assembly ("memory-safe") {
            v := mload(add(b, 32))
        }
    }
}
