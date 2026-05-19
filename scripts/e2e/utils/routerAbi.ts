/**
 * ABI fragments for OpenRouter entrypoints used by e2e scripts.
 * Struct field order must match the Solidity definitions.
 */
export const ROUTER_ABI = [
  `function performActions(
    bytes32 quoteId,
    (uint256 actionInfo, bytes data, uint256[] splices)[] actions
  ) external payable`,

  `function swap(
    bytes32 quoteId,
    uint256 flags,
    (address user, address inputToken, uint256 inputAmount) input,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, uint256 returnDataWordOffset) swapData,
    bytes swapCallData,
    address receiver
  ) external payable returns (uint256)`,

  `function swapAndBridge(
    bytes32 quoteId,
    uint256 flags,
    (address user, address inputToken, uint256 inputAmount) input,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, uint256 returnDataWordOffset) swapData,
    bytes swapCallData,
    (address target, address approvalSpender, uint256 value) bridgeData,
    bytes bridgeCallData
  ) external payable`,

  `function bridge(
    bytes32 quoteId,
    (address user, address inputToken, uint256 inputAmount) input,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, uint256 value) bridgeData,
    bytes bridgeCallData
  ) external payable`,
] as const;
