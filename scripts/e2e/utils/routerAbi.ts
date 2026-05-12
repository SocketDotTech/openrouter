/**
 * ABI fragment for BungeeOpenRouterV2Unchecked — only the two entrypoints
 * called from e2e scripts. Structs must exactly match the Solidity definitions.
 */
export const ROUTER_ABI = [
  // Monolithic path
  `function performExecution(
    (
      (address user, address inputToken, uint256 inputAmount) input,
      (address receiver, uint256 amount) preFee,
      (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, bytes data) swap,
      (address receiver, uint256 amount) postFee,
      (address target, address approvalSpender, uint256 value, bytes data, uint256[] amountPositions, bool useFinalAmountAsValue) bridge
    ) exec
  ) external payable`,

  // Modular path
  `function performModularExecution(
    (uint8 callType, address target, uint256 value, bytes data, (uint256 srcOffset, uint256 dstOffset, uint256 length)[] splices)[] actions
  ) external payable`,
] as const;
