// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @notice Computes the Across output amount that must be spliced into SpokePool.deposit calldata.
contract AcrossERC20AmountManipulator {
    error BridgeFeeExceedsInputAmount();
    error DecimalDiffTooLarge();

    uint256 internal constant MAX_SAFE_DECIMAL_DIFF = 77;

    /// @dev bridgeFee is denominated in input token decimals.
    function deriveOutputAmount(
        uint256 inputAmount,
        uint256 bridgeFee,
        uint256 inputTokenDecimals,
        uint256 outputTokenDecimals
    ) external pure returns (uint256 outputAmount) {
        if (bridgeFee > inputAmount) revert BridgeFeeExceedsInputAmount();

        uint256 amountAfterFee = inputAmount - bridgeFee;
        if (inputTokenDecimals == outputTokenDecimals) return amountAfterFee;

        uint256 decimalDiff;
        if (outputTokenDecimals > inputTokenDecimals) {
            decimalDiff = outputTokenDecimals - inputTokenDecimals;
            if (decimalDiff > MAX_SAFE_DECIMAL_DIFF) revert DecimalDiffTooLarge();
            return amountAfterFee * (10 ** decimalDiff);
        }

        decimalDiff = inputTokenDecimals - outputTokenDecimals;
        if (decimalDiff > MAX_SAFE_DECIMAL_DIFF) revert DecimalDiffTooLarge();
        return amountAfterFee / (10 ** decimalDiff);
    }
}
