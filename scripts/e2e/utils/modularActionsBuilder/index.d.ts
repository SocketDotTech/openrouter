export type Hex = string;
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

export interface LogicalAction {
  callType: number;
  target: Address;
  data: Hex;
  storeResult: boolean;
  splices: Splice[];
}

export interface ModularAction {
  actionInfo: BigNumberish;
  data: Hex;
  splices: BigNumberish[];
}

export type Action = LogicalAction;

export declare const PERFORM_MODULAR_EXECUTION_SELECTOR: "0x4f85c3a5";

export declare const CallType: Readonly<{
  CALL: 0;
  STATICCALL: 1;
  CALL_WITH_NATIVE: 2;
}>;

export declare const Offset: Readonly<{
  selectorArg(argIndex: BigNumberish): number;
  nativePayload(payloadOffset: BigNumberish): number;
}>;

export declare class ModularActionsBuilder {
  context: ExecutionContext;
  constructor(context?: ExecutionContext);
  call(target: Address, data: Hex): ActionHandle;
  staticCall(target: Address, data: Hex): ActionHandle;
  callWithNative(target: Address, payload?: Hex, value?: BigNumberish): ActionHandle;
  nativeCall(target: Address, payload?: Hex, value?: BigNumberish): ActionHandle;
  action(action: {
    callType: BigNumberish;
    target: Address;
    data?: Hex;
    splices?: Splice[];
    storeResult?: boolean;
  }): ActionHandle;
  ref(labelOrIndex: string | BigNumberish): ActionRef;
  actionAt(index: BigNumberish): LogicalAction;
  toActions(): ModularAction[];
  toLogicalActions(): LogicalAction[];
  toJSON(): unknown;
  toCalldata(): Hex;
}

export declare class ActionHandle {
  readonly execution: ModularActionsBuilder;
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
  storeResult(value?: boolean): this;
}

export declare class ActionRef {
  readonly index: number;
  readonly label?: string;
  return(srcOffset?: BigNumberish, length?: BigNumberish): ReturnSource;
  returnWord(srcOffset?: BigNumberish): ReturnSource;
}

export declare function concatHex(values: Hex[]): Hex;
export declare function encodePerformModularExecutionArgs(actions: Array<LogicalAction | ModularAction>): Hex;
export declare function encodeWord(value: BigNumberish): Hex;
export declare function packActionInfo(action: Pick<LogicalAction, "callType" | "target" | "storeResult">): bigint;
export declare function packSpliceInfo(splice: Splice): bigint;
export declare function toModularAction(action: LogicalAction): ModularAction;
