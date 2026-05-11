// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

contract SwapFeeBridgeRouter {
    bytes4 internal constant APPROVE_SELECTOR = 0x095ea7b3;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    struct SwapFeeBridgeParams {
        address inputToken;
        address approveTarget;
        uint256 inputAmount;
        address swapTarget;
        bytes swapData;
        address bridgeTarget;
        bytes bridgeData;
        uint256 bridgeAmountOffset;
        address feeRecipient;
        uint256 feeBps;
        uint256 nativeFee;
    }

    error ApproveFailed(bytes returndata);
    error SwapFailed(bytes returndata);
    error FeeTransferFailed(bytes returndata);
    error BridgeCalldataOutOfBounds(uint256 offset, uint256 length);
    error BridgeFailed(bytes returndata);

    function swapFeeBridge(SwapFeeBridgeParams calldata params)
        external
        payable
        returns (uint256 swapOutput, uint256 routeFee, uint256 postFeeAmount, uint256 bridgeAmount)
    {
        bool success;
        bytes memory returndata;

        (success, returndata) =
            params.inputToken.call(abi.encodeWithSelector(APPROVE_SELECTOR, params.approveTarget, params.inputAmount));
        if (!success) revert ApproveFailed(returndata);

        (success, returndata) = params.swapTarget.call(params.swapData);
        if (!success) revert SwapFailed(returndata);

        swapOutput = abi.decode(returndata, (uint256));
        routeFee = swapOutput * params.feeBps / BPS_DENOMINATOR;
        postFeeAmount = swapOutput - routeFee;
        bridgeAmount = postFeeAmount - params.nativeFee;

        (success, returndata) = params.feeRecipient.call{value: routeFee}("");
        if (!success) revert FeeTransferFailed(returndata);

        bytes memory bridgeData = params.bridgeData;
        uint256 bridgeAmountOffset = params.bridgeAmountOffset;
        if (bridgeData.length < 32 || bridgeAmountOffset > bridgeData.length - 32) {
            revert BridgeCalldataOutOfBounds(bridgeAmountOffset, bridgeData.length);
        }

        assembly ("memory-safe") {
            mstore(add(add(bridgeData, 0x20), bridgeAmountOffset), bridgeAmount)
        }

        (success, returndata) = params.bridgeTarget.call{value: postFeeAmount}(bridgeData);
        if (!success) revert BridgeFailed(returndata);
    }

    receive() external payable {}
}
