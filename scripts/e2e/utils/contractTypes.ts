/**
 * TypeScript interfaces mirroring BungeeOpenRouter Solidity structs.
 * Field names and order must match the compiler ABI encoding.
 */

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

export const POST_FEE_FLAG = 0x01n;
export const BALANCE_FLAG = 0x02n;
export const BRIDGE_VALUE_FLAG = 0x04n;
export const BRIDGE_AMOUNT_POSITION_FLAG = 0x08n;
export const BRIDGE_AMOUNT_POSITION_SHIFT = 16n;
export const MAX_BRIDGE_AMOUNT_POSITION = 0xffffn;

/** 32-byte zero; use as `quoteId` when scripts do not assign a correlation id. */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Convenience: empty fee (no fee taken) */
export const NO_FEE: FeeData = { receiver: ZERO_ADDRESS, amount: 0n };

export function bridgeAmountPositionFlag(position: bigint | number): bigint {
  const positionBigInt = BigInt(position);
  if (positionBigInt < 0n || positionBigInt > MAX_BRIDGE_AMOUNT_POSITION) {
    throw new Error(`bridge amount position exceeds uint16: ${positionBigInt}`);
  }
  return BRIDGE_AMOUNT_POSITION_FLAG | (positionBigInt << BRIDGE_AMOUNT_POSITION_SHIFT);
}

export function swapArgs(
  quoteId: string,
  flags: bigint,
  input: InputData,
  fee: FeeData,
  swapData: SwapData,
  swapCallData: string,
  receiver: string,
): readonly [string, bigint, InputData, FeeData, SwapData, string, string] {
  return [quoteId, flags, input, fee, swapData, swapCallData, receiver] as const;
}

export function swapAndBridgeArgs(
  quoteId: string,
  flags: bigint,
  input: InputData,
  fee: FeeData,
  swapData: SwapData,
  swapCallData: string,
  bridgeData: BridgeData,
  bridgeCallData: string,
): readonly [
  string,
  bigint,
  InputData,
  FeeData,
  SwapData,
  string,
  BridgeData,
  string,
] {
  return [quoteId, flags, input, fee, swapData, swapCallData, bridgeData, bridgeCallData] as const;
}

export function bridgeArgs(
  quoteId: string,
  input: InputData,
  fee: FeeData,
  bridgeData: BridgeData,
  bridgeCallData: string,
): readonly [string, InputData, FeeData, BridgeData, string] {
  return [quoteId, input, fee, bridgeData, bridgeCallData] as const;
}

export function performActionsArgs(
  quoteId: string,
  actions: { actionInfo: bigint | string; data: string; splices: (bigint | string)[] }[],
): readonly [string, typeof actions] {
  return [quoteId, actions] as const;
}
