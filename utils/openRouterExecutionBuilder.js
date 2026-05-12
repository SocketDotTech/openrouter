"use strict";

const DUMMY_ROUTER_EXECUTE_SELECTOR = "0x8749f339";
const WORD_BYTES = 32;
const WORD_HEX_CHARS = WORD_BYTES * 2;
const UINT256_MAX = (1n << 256n) - 1n;

const CallType = Object.freeze({
  CALL: 0,
  STATICCALL: 1,
  CALL_WITH_NATIVE: 2,
});

const Offset = Object.freeze({
  selectorArg: (argIndex) => 4 + WORD_BYTES * checkedIndex(argIndex, "argIndex"),
  nativePayload: (payloadOffset) => WORD_BYTES + checkedIndex(payloadOffset, "payloadOffset"),
});

class OpenRouterExecution {
  constructor(context = {}) {
    this.context = { ...context };
    this._actions = [];
    this._labels = new Map();
  }

  call(target, data) {
    return this.action({ callType: CallType.CALL, target, data });
  }

  staticCall(target, data) {
    return this.action({ callType: CallType.STATICCALL, target, data });
  }

  callWithNative(target, payload = "0x", value = 0n) {
    return this.action({
      callType: CallType.CALL_WITH_NATIVE,
      target,
      data: concatHex([encodeWord(value), payload]),
    });
  }

  nativeCall(target, payload = "0x", value = 0n) {
    return this.callWithNative(target, payload, value);
  }

  action({ callType, target, data = "0x", splices = [] }) {
    const actionIndex = this._actions.length;
    const action = {
      callType: checkedCallType(callType),
      target: normalizeAddress(target),
      data: normalizeHex(data, "data"),
      splices: splices.map((splice, index) => normalizeSplice(splice, `splices[${index}]`)),
    };
    for (const splice of action.splices) {
      validateSpliceForAction(actionIndex, action, splice);
    }
    this._actions.push(action);
    return new ActionHandle(this, this._actions.length - 1);
  }

  ref(labelOrIndex) {
    if (typeof labelOrIndex === "string") {
      if (!this._labels.has(labelOrIndex)) {
        throw new Error(`Unknown action label: ${labelOrIndex}`);
      }
      return new ActionRef(this._labels.get(labelOrIndex), labelOrIndex);
    }
    return new ActionRef(checkedIndex(labelOrIndex, "actionIndex"));
  }

  actionAt(index) {
    const checked = checkedIndex(index, "actionIndex");
    const action = this._actions[checked];
    if (!action) throw new Error(`Unknown action index: ${checked}`);
    return action;
  }

  toActions() {
    return this._actions.map(cloneAction);
  }

  toJSON() {
    return this._actions.map((action) => ({
      callType: action.callType,
      target: action.target,
      data: action.data,
      splices: action.splices.map((splice) => ({
        sourceActionIndex: String(splice.sourceActionIndex),
        srcOffset: String(splice.srcOffset),
        dstOffset: String(splice.dstOffset),
        length: String(splice.length),
      })),
    }));
  }

  toDummyRouterCalldata() {
    return concatHex([DUMMY_ROUTER_EXECUTE_SELECTOR, encodeDummyRouterExecuteArgs(this._actions)]);
  }

  _label(index, label) {
    if (!label || typeof label !== "string") throw new Error("Action label must be a non-empty string");
    if (this._labels.has(label)) throw new Error(`Duplicate action label: ${label}`);
    this._labels.set(label, index);
    return new ActionRef(index, label);
  }

  _splice(index, splice) {
    const action = this.actionAt(index);
    const normalized = normalizeSplice(splice, "splice");
    validateSpliceForAction(index, action, normalized);
    action.splices.push(normalized);
  }
}

class ActionHandle {
  constructor(execution, index) {
    this.execution = execution;
    this.index = index;
  }

  as(label) {
    this.execution._label(this.index, label);
    return this;
  }

  label(label) {
    return this.as(label);
  }

  ref() {
    return new ActionRef(this.index);
  }

  return(offset = 0, length = WORD_BYTES) {
    return this.ref().return(offset, length);
  }

  returnWord(offset = 0) {
    return this.ref().returnWord(offset);
  }

  splice(source, dstOffset, length = source.length) {
    this.execution._splice(this.index, {
      sourceActionIndex: source.sourceActionIndex,
      srcOffset: source.srcOffset,
      dstOffset,
      length,
    });
    return this;
  }

  spliceWord(dstOffset, source) {
    return this.splice(source, dstOffset, WORD_BYTES);
  }

  spliceArg(argIndex, source) {
    return this.spliceWord(Offset.selectorArg(argIndex), source);
  }

  spliceNativeValue(source) {
    return this.spliceWord(0, source);
  }

  valueFrom(source) {
    return this.spliceNativeValue(source);
  }

  splicePayloadWord(payloadOffset, source) {
    return this.spliceWord(Offset.nativePayload(payloadOffset), source);
  }

  splicePayload(payloadOffset, source, length = source.length) {
    return this.splice(source, Offset.nativePayload(payloadOffset), length);
  }

  patchWord(dstOffset, source) {
    return this.spliceWord(dstOffset, source);
  }
}

class ActionRef {
  constructor(index, label) {
    this.index = index;
    this.label = label;
  }

  return(srcOffset = 0, length = WORD_BYTES) {
    return {
      sourceActionIndex: this.index,
      srcOffset: checkedIndex(srcOffset, "srcOffset"),
      length: checkedIndex(length, "length"),
    };
  }

  returnWord(srcOffset = 0) {
    return this.return(srcOffset, WORD_BYTES);
  }
}

function encodeDummyRouterExecuteArgs(actions) {
  return concatHex([encodeWord(WORD_BYTES), encodeActionArray(actions)]);
}

function encodeActionArray(actions) {
  const encodedActions = actions.map(encodeActionTuple);
  let nextOffset = WORD_BYTES * actions.length;
  const offsets = [];
  for (const encodedAction of encodedActions) {
    offsets.push(encodeWord(nextOffset));
    nextOffset += hexByteLength(encodedAction);
  }
  return concatHex([encodeWord(actions.length), ...offsets, ...encodedActions]);
}

function encodeActionTuple(action) {
  const encodedData = encodeBytes(action.data);
  const encodedSplices = encodeSpliceArray(action.splices);
  const dataOffset = WORD_BYTES * 4;
  const splicesOffset = dataOffset + hexByteLength(encodedData);

  return concatHex([
    encodeWord(action.callType),
    encodeAddressWord(action.target),
    encodeWord(dataOffset),
    encodeWord(splicesOffset),
    encodedData,
    encodedSplices,
  ]);
}

function encodeSpliceArray(splices) {
  const encodedSplices = splices.flatMap((splice) => [
    encodeWord(splice.sourceActionIndex),
    encodeWord(splice.srcOffset),
    encodeWord(splice.dstOffset),
    encodeWord(splice.length),
  ]);
  return concatHex([encodeWord(splices.length), ...encodedSplices]);
}

function encodeBytes(value) {
  const hex = strip0x(normalizeHex(value, "bytes"));
  const byteLength = hex.length / 2;
  const paddedLength = Math.ceil(byteLength / WORD_BYTES) * WORD_HEX_CHARS;
  return `0x${strip0x(encodeWord(byteLength))}${hex.padEnd(paddedLength, "0")}`;
}

function encodeAddressWord(value) {
  return `0x${strip0x(normalizeAddress(value)).padStart(WORD_HEX_CHARS, "0")}`;
}

function encodeWord(value) {
  const bigint = toBigInt(value);
  if (bigint < 0n || bigint > UINT256_MAX) throw new Error(`uint256 out of range: ${value}`);
  return `0x${bigint.toString(16).padStart(WORD_HEX_CHARS, "0")}`;
}

function concatHex(values) {
  return `0x${values.map((value) => strip0x(normalizeHex(value, "hex"))).join("")}`;
}

function normalizeSplice(splice, label) {
  if (!splice || typeof splice !== "object") throw new Error(`${label} must be an object`);
  const length = checkedIndex(splice.length, `${label}.length`);
  if (length === 0) throw new Error(`${label}.length must be greater than zero`);
  return {
    sourceActionIndex: checkedIndex(splice.sourceActionIndex, `${label}.sourceActionIndex`),
    srcOffset: checkedIndex(splice.srcOffset, `${label}.srcOffset`),
    dstOffset: checkedIndex(splice.dstOffset, `${label}.dstOffset`),
    length,
  };
}

function validateSpliceForAction(actionIndex, action, splice) {
  if (splice.sourceActionIndex >= actionIndex) {
    throw new Error(`Invalid future splice: action ${actionIndex} cannot read action ${splice.sourceActionIndex}`);
  }
  if (splice.dstOffset + splice.length > hexByteLength(action.data)) {
    throw new Error(
      `Splice destination exceeds action ${actionIndex} data length: ${splice.dstOffset} + ${splice.length}`,
    );
  }
}

function checkedCallType(callType) {
  const value = checkedIndex(callType, "callType");
  if (![CallType.CALL, CallType.STATICCALL, CallType.CALL_WITH_NATIVE].includes(value)) {
    throw new Error(`Unsupported callType: ${callType}`);
  }
  return value;
}

function checkedIndex(value, label) {
  const bigint = toBigInt(value);
  if (bigint < 0n || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must fit in a safe non-negative integer`);
  }
  return Number(bigint);
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`Expected integer, got ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (value.startsWith("0x") || value.startsWith("0X")) return BigInt(value);
    return BigInt(value);
  }
  throw new Error(`Expected bigint, number, or numeric string, got ${typeof value}`);
}

function normalizeAddress(value) {
  const hex = strip0x(normalizeHex(value, "address"));
  if (hex.length !== 40) throw new Error(`Invalid address length: ${value}`);
  return `0x${hex.toLowerCase()}`;
}

function normalizeHex(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a hex string`);
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} must be 0x-prefixed hex`);
  if (value.length % 2 !== 0) throw new Error(`${label} must contain whole bytes`);
  return value.toLowerCase();
}

function strip0x(value) {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function hexByteLength(value) {
  return strip0x(normalizeHex(value, "hex")).length / 2;
}

function cloneAction(action) {
  return {
    callType: action.callType,
    target: action.target,
    data: action.data,
    splices: action.splices.map((splice) => ({ ...splice })),
  };
}

module.exports = {
  ActionHandle,
  ActionRef,
  CallType,
  DUMMY_ROUTER_EXECUTE_SELECTOR,
  Offset,
  OpenRouterExecution,
  concatHex,
  encodeDummyRouterExecuteArgs,
  encodeWord,
};
