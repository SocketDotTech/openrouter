/**
 * ABI fragment for the combined unchecked router — only the two entrypoints
 * called from e2e scripts. Structs must exactly match the Solidity definitions.
 */
export const ROUTER_ABI = [
  // Monolithic path — `requestHash` is first for indexer-friendly calldata layout
  `function performExecution(
    bytes32 requestHash,
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
    bytes32 requestHash,
    (uint256 actionInfo, bytes data, uint256[] splices)[] actions
  ) external payable`,

  // Standalone swap — pull, optional fee, swap; returns finalAmount
  `function swap(
    bytes32 requestHash,
    (address user, address inputToken, uint256 inputAmount) input,
    uint256 flags,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, uint256 returnDataWordOffset) swapData,
    bytes swapCallData
  ) external payable returns (uint256)`,

  // Swap + bridge — pull, optional fee, swap, then bridge with optional amount splicing
  `function swapAndBridge(
    bytes32 requestHash,
    (address user, address inputToken, uint256 inputAmount) input,
    uint256 flags,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, address outputToken, uint256 value, uint256 minOutput, uint256 returnDataWordOffset) swapData,
    bytes swapCallData,
    (address target, address approvalSpender, uint256 value) bridgeData,
    bytes bridgeCallData
  ) external payable`,

  // Simple bridge path (no swap, no splicing — caller pre-encodes finalAmount into data)
  `function bridge(
    bytes32 requestHash,
    (address user, address inputToken, uint256 inputAmount) input,
    (address receiver, uint256 amount) fee,
    (address target, address approvalSpender, uint256 value) bridgeData,
    bytes bridgeCallData
  ) external payable`,
] as const;
