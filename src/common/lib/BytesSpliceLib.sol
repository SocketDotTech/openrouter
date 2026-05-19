// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @title BytesSpliceLib
/// @notice Generalisation of the in-place calldata patching used in
///         GenericStakedRoute and BungeeApproveAndBridge. Supports patching
///         either a single 32-byte word (for `uint256` amount fields) or an
///         arbitrary length copy from one bytes blob to another.
library BytesSpliceLib {
    error SpliceLengthZero();
    error SpliceSrcOutOfBounds();
    error SpliceDstOutOfBounds();
    error SplicePositionOutOfBounds();

    /// @notice Overwrites a 32-byte word at `position` in `data` with `word`.
    /// @dev Mirrors the GenericStakedRoute amount patching pattern.
    function spliceWord(bytes memory data, uint256 position, uint256 word) internal pure {
        // Bounds check: position + 32 must fit in data
        if (position + 32 > data.length) {
            revert SplicePositionOutOfBounds();
        }
        // in-place mstore at data + 32 (skip length prefix) + position
        assembly ("memory-safe") {
            mstore(add(add(data, 0x20), position), word)
        }
    }

    /// @notice Overwrites a 32-byte word at every entry in `positions`.
    function spliceWords(bytes memory data, uint256[] memory positions, uint256 word) internal pure {
        uint256 len = positions.length;
        for (uint256 i = 0; i < len;) {
            spliceWord({data: data, position: positions[i], word: word});
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Copies `length` bytes from `src` at `srcOffset` into `dst` at `dstOffset`.
    /// @dev Uses Cancun's `mcopy`. Performs bounds checks on both blobs and
    ///      rejects zero-length splices to match the safety expectations on
    ///      the modular OpenRouter actions.
    function spliceBytes(bytes memory dst, uint256 dstOffset, bytes memory src, uint256 srcOffset, uint256 length)
        internal
        pure
    {
        if (length == 0) {
            revert SpliceLengthZero();
        }
        // unchecked: revert paths use checked add to keep things readable.
        if (srcOffset + length > src.length) {
            revert SpliceSrcOutOfBounds();
        }
        if (dstOffset + length > dst.length) {
            revert SpliceDstOutOfBounds();
        }
        assembly ("memory-safe") {
            mcopy(add(add(dst, 0x20), dstOffset), add(add(src, 0x20), srcOffset), length)
        }
    }
}
