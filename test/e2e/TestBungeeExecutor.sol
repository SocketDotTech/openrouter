// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {RescueFundsLib} from "../../src/common/lib/RescueFundsLib.sol";
import {Ownable} from "../../src/common/utils/Ownable.sol";

/// @notice Test implementation of IBungeeExecutor. Decodes a uint256 from callData and stores it.
/// @dev Deploy on destination chain. Use abi.encode(uint256) as executionCallData in scripts.
contract TestBungeeExecutor is Ownable {
    uint256 public counter;
    bytes32 public lastQuoteId;
    uint256 public lastAmount;
    address public lastToken;

    event Executed(bytes32 indexed quoteId, uint256 amount, address token, uint256 counterValue);

    constructor() Ownable(msg.sender) {}

    receive() external payable {}

    function executeData(bytes32 quoteId, uint256 amount, address token, bytes calldata callData) external payable {
        uint256 counterValue = callData.length >= 32 ? abi.decode(callData, (uint256)) : 0;
        counter = counterValue;
        lastQuoteId = quoteId;
        lastAmount = amount;
        lastToken = token;
        emit Executed(quoteId, amount, token, counterValue);
    }

    function rescueFunds(address token, address rescueTo, uint256 amount) external onlyOwner {
        RescueFundsLib.rescueFunds(token, rescueTo, amount);
    }
}
