// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {AllowanceHolderBase} from "./AllowanceHolderBase.sol";
import {TransientStorage} from "./TransientStorage.sol";

/// @custom:security-contact security@0x.org
contract AllowanceHolder is TransientStorage, AllowanceHolderBase {
    constructor() {
        require(address(this) == 0x50c4E75a512F2A14A7b304787Adf79C4531A5909 || block.chainid == 31337);
    }

    /// @inheritdoc AllowanceHolderBase
    function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)
        internal
        override
        returns (bytes memory)
    {
        (bytes memory result, address sender, TSlot allowance) = _exec(operator, token, amount, target, data);
        // EIP-3074 seems unlikely
        if (sender != tx.origin) {
            _set(allowance, 0);
        }
        return result;
    }
}
