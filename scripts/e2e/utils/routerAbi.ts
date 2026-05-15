/**
 * ABI fragment for the combined unchecked router — only the two entrypoints
 * called from e2e scripts. Structs must exactly match the Solidity definitions.
 */
export const ROUTER_ABI = [
  // Monolithic path
  `function performExecution(
    (
      (address user, address inputToken, uint256 inputAmount) input,
      (address receiver, uint256 amount) preFee,
      (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, uint256 returnDataWordOffset) swap,
      (address receiver, uint256 amount) postFee,
      (address target, address approvalSpender, uint256 value) bridge,
      uint256 flags
    ) exec,
    bytes swapCallData,
    bytes bridgeCallData
  ) external payable`,

  // Modular path
  `function performModularExecution(
    (uint256 actionInfo, bytes data, uint256[] splices)[] actions
  ) external payable`,

  // Simple bridge path (no swap, no splicing — caller pre-encodes finalAmount into data)
  `function bridge(
    (address user, address inputToken, uint256 inputAmount) input,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, uint256 value) bridgeData,
    bytes bridgeCallData
  ) external payable`,
] as const;
