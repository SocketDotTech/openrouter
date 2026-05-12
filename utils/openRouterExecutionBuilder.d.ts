export type Hex = `0x${string}`;
export type Address = Hex;
export type BigNumberish = bigint | number | string;

export interface ExecutionContext {
  [key: string]: unknown;
}

export interface ReturnSource {
  sourceActionIndex: number;
  srcOffset: number;
  length: number;
}

export interface Splice {
  sourceActionIndex: BigNumberish;
  srcOffset: BigNumberish;
  dstOffset: BigNumberish;
  length: BigNumberish;
}

export interface Action {
  callType: number;
  target: Address;
  data: Hex;
  splices: Splice[];
}

export declare const DUMMY_ROUTER_EXECUTE_SELECTOR: "0x8749f339";

export declare const CallType: Readonly<{
  CALL: 0;
  STATICCALL: 1;
  CALL_WITH_NATIVE: 2;
}>;

export declare const Offset: Readonly<{
  selectorArg(argIndex: BigNumberish): number;
  nativePayload(payloadOffset: BigNumberish): number;
}>;

export declare class OpenRouterExecution {
  context: ExecutionContext;
  constructor(context?: ExecutionContext);
  call(target: Address, data: Hex): ActionHandle;
  staticCall(target: Address, data: Hex): ActionHandle;
  callWithNative(target: Address, payload?: Hex, value?: BigNumberish): ActionHandle;
  nativeCall(target: Address, payload?: Hex, value?: BigNumberish): ActionHandle;
  action(action: { callType: BigNumberish; target: Address; data?: Hex; splices?: Splice[] }): ActionHandle;
  ref(labelOrIndex: string | BigNumberish): ActionRef;
  actionAt(index: BigNumberish): Action;
  toActions(): Action[];
  toJSON(): unknown;
  toDummyRouterCalldata(): Hex;
}

export declare class ActionHandle {
  readonly execution: OpenRouterExecution;
  readonly index: number;
  as(label: string): this;
  label(label: string): this;
  ref(): ActionRef;
  return(offset?: BigNumberish, length?: BigNumberish): ReturnSource;
  returnWord(offset?: BigNumberish): ReturnSource;
  splice(source: ReturnSource, dstOffset: BigNumberish, length?: BigNumberish): this;
  spliceWord(dstOffset: BigNumberish, source: ReturnSource): this;
  spliceArg(argIndex: BigNumberish, source: ReturnSource): this;
  spliceNativeValue(source: ReturnSource): this;
  valueFrom(source: ReturnSource): this;
  splicePayloadWord(payloadOffset: BigNumberish, source: ReturnSource): this;
  splicePayload(payloadOffset: BigNumberish, source: ReturnSource, length?: BigNumberish): this;
  patchWord(dstOffset: BigNumberish, source: ReturnSource): this;
}

export declare class ActionRef {
  readonly index: number;
  readonly label?: string;
  return(srcOffset?: BigNumberish, length?: BigNumberish): ReturnSource;
  returnWord(srcOffset?: BigNumberish): ReturnSource;
}

export declare function concatHex(values: Hex[]): Hex;
export declare function encodeDummyRouterExecuteArgs(actions: Action[]): Hex;
export declare function encodeWord(value: BigNumberish): Hex;
