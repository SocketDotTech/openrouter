/**
 * TypeScript interfaces that mirror every Solidity struct in
 * Combined unchecked router. The order and field names must match the ABI
 * produced by the compiler so that ethers.js can encode them correctly.
 */

// ─── Monolithic execution types ───────────────────────────────────────────────

export interface InputData {
  user: string;
  inputToken: string;
  inputAmount: bigint;
}

export interface FeeData {
  receiver: string;
  amount: bigint;
}

export interface SwapData {
  target: string;
  approvalSpender: string;
  outputToken: string;
  value: bigint;
  minOutput: bigint;
  returnDataWordOffset: bigint;
}

export interface BridgeData {
  target: string;
  approvalSpender: string;
  value: bigint;
}

export interface MonolithicExecution {
  input: InputData;
  preFee: FeeData;
  swap: SwapData;
  postFee: FeeData;
  bridge: BridgeData;
  flags: bigint;
}

export interface MonolithicExecutionCall {
  exec: MonolithicExecution;
  swapCallData: string;
  bridgeCallData: string;
}

export const BRIDGE_VALUE_FLAG = 4n;
export const BRIDGE_AMOUNT_POSITION_FLAG = 8n;
export const BRIDGE_AMOUNT_POSITION_SHIFT = 16n;
export const MAX_BRIDGE_AMOUNT_POSITION = 0xffffn;

/** 32-byte zero; use as `requestHash` when scripts do not assign a request id. */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export function bridgeAmountPositionFlag(position: bigint | number): bigint {
  const positionBigInt = BigInt(position);
  if (positionBigInt < 0n || positionBigInt > MAX_BRIDGE_AMOUNT_POSITION) {
    throw new Error(`bridge amount position exceeds uint16: ${positionBigInt}`);
  }
  return BRIDGE_AMOUNT_POSITION_FLAG | (positionBigInt << BRIDGE_AMOUNT_POSITION_SHIFT);
}

export function monolithicArgs(
  call: MonolithicExecutionCall,
  requestHash: string = ZERO_BYTES32,
): readonly [string, MonolithicExecution, string, string] {
  return [requestHash, call.exec, call.swapCallData, call.bridgeCallData] as const;
}

// ─── Sentinel / zero helpers ──────────────────────────────────────────────────

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Convenience: empty fee (no fee taken) */
export const NO_FEE: FeeData = { receiver: ZERO_ADDRESS, amount: 0n };

/** Convenience: empty swap (skip swap step) */
export const NO_SWAP: SwapData = {
  target: ZERO_ADDRESS,
  approvalSpender: ZERO_ADDRESS,
  outputToken: ZERO_ADDRESS,
  value: 0n,
  minOutput: 0n,
  returnDataWordOffset: 0n,
};
