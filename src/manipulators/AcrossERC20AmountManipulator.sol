// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.19;

import {ERC20} from "solady/src/tokens/ERC20.sol";

/// @title AcrossERC20AmountManipulator
/// @notice Stateless helper for OpenRouter-style batches that need Across deposit amounts after swap and fee transfer
contract AcrossERC20AmountManipulator {
    error InvalidAddress();
    error BridgeFeeExceedsInputAmount();
    error DecimalDiffTooLarge();

    uint256 internal constant MAX_SAFE_DECIMAL_DIFF = 77;

    /// @notice Reads the current ERC20 balance and derives Across input/output amounts.
    /// @dev Intended to be called after swap and fee-transfer actions have completed.
    ///      Returndata layout is two ABI words:
    ///      - offset 0: inputAmount
    ///      - offset 32: outputAmount
    /// @param token ERC20 token to bridge.
    /// @param balanceHolder Address whose post-fee balance should be used as Across inputAmount.
    /// @param bridgeFee Fee to subtract before deriving outputAmount, denominated in input token decimals.
    /// @param inputTokenDecimals Decimals of the source/input token.
    /// @param outputTokenDecimals Decimals of the destination/output token.
    function acrossAmounts(
        address token,
        address balanceHolder,
        uint256 bridgeFee,
        uint256 inputTokenDecimals,
        uint256 outputTokenDecimals
    ) external view returns (uint256 inputAmount, uint256 outputAmount) {
        if (token == address(0) || balanceHolder == address(0)) revert InvalidAddress();

        inputAmount = ERC20(token).balanceOf(balanceHolder);
        outputAmount = deriveOutputAmount(inputAmount, bridgeFee, inputTokenDecimals, outputTokenDecimals);
    }

    /// @notice Derives Across input/output amounts from a caller-provided input amount.
    /// @dev Use this when a previous OpenRouter action already returned the final post-fee amount.
    function acrossAmountsFromInput(
        uint256 inputAmount,
        uint256 bridgeFee,
        uint256 inputTokenDecimals,
        uint256 outputTokenDecimals
    ) external pure returns (uint256, uint256 outputAmount) {
        outputAmount = deriveOutputAmount(inputAmount, bridgeFee, inputTokenDecimals, outputTokenDecimals);
        return (inputAmount, outputAmount);
    }

    /// @notice Derives Across outputAmount from a runtime inputAmount.
    /// @dev bridgeFee is denominated in input token decimals.
    function deriveOutputAmount(
        uint256 inputAmount,
        uint256 bridgeFee,
        uint256 inputTokenDecimals,
        uint256 outputTokenDecimals
    ) public pure returns (uint256 outputAmount) {
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
