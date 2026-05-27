# OpenRouter

**Contract:** [`src/OpenRouter.sol`](src/OpenRouter.sol)

OpenRouter is a single on-chain executor that combines two earlier designs:

1. **Structured (monolithic) routes** — fixed pull → fee → swap → bridge semantics, exposed as separate entrypoints (`swap`, `swapAndBridge`, `bridge`) instead of one giant `Execution` struct and `performExecution`.
2. **Generic (modular) routes** — an ordered `performActions` loop with returndata splicing between steps, for flows that do not fit the structured pipeline.

There is **no backend signature verification**, **no nonce**, and **no deadline** on this contract. ERC-20 fund safety for structured pulls relies on [0x AllowanceHolder](https://github.com/0xProject/0x-settler) transient allowances plus `_msgSender() == input.user` in `_pullFromUser`. Native input uses `msg.value` on the outer call.

---

## Source layout

```text
src/
  OpenRouter.sol                    # ship target (contract OpenRouter)
  common/
    AccessRoles.sol
    allowance/AllowanceHolderContext.sol
    interfaces/IERC20.sol
    interfaces/IAllowanceHolder.sol
    lib/BytesSpliceLib.sol
    lib/CurrencyLib.sol
    lib/RescueFundsLib.sol
    utils/AccessControl.sol
  manipulators/                     # optional off-router helpers for PoCs (Across, math)
```

---

## How users call the router

ERC-20 inputs must be submitted through **AllowanceHolder**, not by calling OpenRouter directly:

1. User approves AllowanceHolder (not OpenRouter).
2. User calls `AllowanceHolder.exec(operator, token, amount, target, data)` with `target = OpenRouter` and `data` encoding one of the router entrypoints.
3. AllowanceHolder forwards the call and appends the user address to calldata (ERC-2771 style). OpenRouter’s `_msgSender()` resolves to that user.
4. `_pullFromUser` calls `AllowanceHolder.transferFrom` and reverts with `CallerNotSignedUser()` unless `_msgSender() == input.user`.

Native token input skips AllowanceHolder pull: the caller must forward sufficient `msg.value` on the outer transaction.

`AllowanceHolderContext` also implements a harmless `balanceOf` so AllowanceHolder’s confused-deputy probe succeeds (same pattern as 0x Settler + AH).

---

## External entrypoints

| Function | Purpose |
|----------|---------|
| `swap` | Same-chain: pull → optional pre/post fee → swap → deliver output to `receiver` |
| `swapAndBridge` | Cross-chain: pull → optional pre/post swap fee → swap (output stays on router) → bridge |
| `bridge` | Direct bridge: pull → optional pre-bridge fee → bridge (amount baked into calldata) |
| `performActions` | Generic action loop with optional returndata splices |
| `rescueFunds` | Owner `RESCUE_ROLE` recovery of stuck tokens (operational, not a security boundary) |

Each structured entrypoint emits `RequestExecuted(bytes32 quoteId)` for off-chain correlation. `quoteId` is caller-defined; the contract does not validate it.

Structured ABI parameter order (see [`scripts/e2e/utils/routerAbi.ts`](scripts/e2e/utils/routerAbi.ts)):

- `swap(quoteId, flags, input, fee, swapData, swapCallData, receiver)`
- `swapAndBridge(quoteId, flags, input, fee, swapData, swapCallData, bridgeData, bridgeCallData)`
- `bridge(quoteId, input, fee, bridgeData, bridgeCallData)`
- `performActions(quoteId, actions)`

---

## Structured routes — structs

```solidity
struct InputData {
    address user;
    address inputToken;
    uint256 inputAmount;
}

struct FeeData {
    address receiver;
    uint256 amount;   // 0 skips fee collection
}

struct SwapData {
    address target;
    address approvalSpender;
    address outputToken;
    uint256 value;
    uint256 minOutput;
    uint256 returnDataWordOffset;  // word index when using returndata output mode
}

struct BridgeData {
    address target;
    address approvalSpender;
    uint256 value;    // static msg.value addend (see BRIDGE_VALUE flag)
}
```

### `swap`

1. Pull `inputAmount` of `inputToken` from `user`.
2. If `fee.amount > 0` and **pre-fee** (`flags & 0x01 == 0`): transfer fee in input token, swap the remainder.
3. Approve `swapData.approvalSpender` when needed (max allowance, only if current allowance is insufficient).
4. Execute swap via `_execSwap` (see flags below).
5. Enforce `finalAmount >= swapData.minOutput` on **gross** swap output.
6. If **post-fee** (`flags & 0x01 != 0`): swap output lands on the router; fee is taken from output token; net is sent to `receiver`.
7. If **pre-fee / no fee**: swap calldata must send tokens **directly to `receiver`**; the router never holds swap output.

### `swapAndBridge`

Same pull / pre-fee / swap / post-fee logic as above, but swap output **always** remains on `address(this)` for bridging. Then `_execBridge` splices the post-fee amount into bridge calldata (when flagged), approves the bridge spender, and calls the bridge target.

### `bridge`

No swap. Pull → optional pre-bridge fee in input token → approve bridge spender → call bridge with `bridgeCallData` **unchanged**.

Because `finalAmount = inputAmount - fee` is known up front, the caller must **bake the bridge amount into `bridgeCallData`** before submission. There is no runtime calldata splice on this path.

---

## Packed `flags` (structured routes)

One `uint256` packs switches for `swap` and `swapAndBridge` (not used by `bridge` or `performActions`):

| Bits | Mask | Meaning |
|------|------|---------|
| 0 | `0x01` | Post-swap fee: fee taken from output token after swap. Clear = pre-swap fee from input. |
| 1 | `0x02` | Swap output via `balanceOf` delta on `outputToken`. Clear = decode return word at `swapData.returnDataWordOffset`. |
| 2 | `0x04` | Bridge `msg.value = finalAmount + bridgeData.value` (e.g. LayerZero `nativeFee` addend in `bridgeData.value`). Clear = `bridgeData.value` only. |
| 3 | `0x08` | Splice `finalAmount` into bridge calldata at byte offset `(flags >> 16) & 0xffff`. |
| 16–31 | — | Byte offset for bridge amount splice when bit 3 is set. |

Common combinations:

| `flags` | Fee | Swap output | Bridge `msg.value` |
|---------|-----|-------------|-------------------|
| `0x00` | pre | returndata | `bridgeData.value` |
| `0x01` | post | returndata | `bridgeData.value` |
| `0x02` | pre | balance delta | `bridgeData.value` |
| `0x03` | post | balance delta | `bridgeData.value` |
| `0x04` | pre | returndata | `finalAmount + bridgeData.value` |

Add `0x08` and set bits 16–31 when bridge calldata needs the live swap output at a fixed offset (same idea as `GenericStakedRoute` / `BytesSpliceLib.spliceWord`).

---

## Generic routes — `performActions`

For flows that need extra hops, manipulator contracts, or multiple splices into one calldata blob, use the modular path:

```solidity
struct Action {
    uint256 actionInfo;   // packed call metadata (see below)
    bytes data;           // calldata; patched by splices before the call
    uint256[] splices;    // packed splice descriptors (see below)
}

enum CallType { CALL, STATICCALL, CALL_WITH_NATIVE }
```

### `actionInfo` layout

One `uint256` per action. All fields are uint64-safe except `target` (uint160).

| Bits | Field | Type | Meaning |
|------|-------|------|---------|
| 0–2 | `callType` | `uint8` | `CallType`: `CALL` (0), `STATICCALL` (1), `CALL_WITH_NATIVE` (2) |
| 3–7 | — | — | reserved (0) |
| 8 | `storeResult` | `bool` | When set, returndata is saved to `results[i]` even on success so later actions can splice from it |
| 9–15 | — | — | reserved (0) |
| 16–175 | `target` | `address` | Callee address (`uint160`, shifted left 16) |
| 176–255 | — | — | reserved (0) |

Packing (matches `packActionInfo` in [`scripts/e2e/utils/modularActionsBuilder/index.js`](scripts/e2e/utils/modularActionsBuilder/index.js)):

```text
callType | (storeResult ? 1 << 8 : 0) | (uint160(target) << 16)
```

`CALL_WITH_NATIVE`: first 32 bytes of `data` are `msg.value`; remaining bytes are calldata.

### `splices[]` entry layout

Each `splices[j]` is one `uint256` describing a byte-range copy from a prior action’s returndata into this action’s `data`. Offsets are into the **payload** bytes (the bytes-array contents), not including Solidity’s 32-byte length prefix.

| Bits | Field | Type | Meaning |
|------|-------|------|---------|
| 0–63 | `sourceActionIndex` | `uint64` | Index of the prior action whose returndata is the copy source |
| 64–127 | `srcOffset` | `uint64` | Byte offset into `results[sourceActionIndex]` payload |
| 128–191 | `dstOffset` | `uint64` | Byte offset into this action’s `data` payload |
| 192–255 | `length` | `uint64` | Number of bytes to copy (must be > 0) |

Packing (matches `packSpliceInfo` in the modular actions builder):

```text
sourceActionIndex | (srcOffset << 64) | (dstOffset << 128) | (length << 192)
```

Before action `i` runs, each splice copies `length` bytes from `results[sourceActionIndex]` at `srcOffset` into this action’s `data` at `dstOffset` (via `mcopy`). Constraints enforced on-chain:

- `sourceActionIndex < i` — otherwise `FutureSplice`
- `srcOffset + length <= source.length` and `dstOffset + length <= data.length` — otherwise `SpliceOutOfBounds`
- The source action must have `storeResult` set (bit 8 of its `actionInfo`); the JS builder sets this automatically when a splice references that action

**Destination offset conventions** (builder helpers in `modularActionsBuilder/index.js`):

| Helper | `dstOffset` for… |
|--------|------------------|
| `spliceArg(n, source)` | ABI arg `n` in a normal call: `4 + n * 32` (past the 4-byte selector) |
| `valueFrom(source)` / `spliceNativeValue` | Leading value word of `CALL_WITH_NATIVE`: `0` |
| `splicePayloadWord(off, source)` | Payload of `CALL_WITH_NATIVE`: `32 + off` |
| `patchWord(off, source)` | Absolute payload offset `off` |

Example: splice the first 32 bytes of action 0’s returndata into byte offset 132 of action 2’s calldata:

```js
const { packSpliceInfo } = require("./scripts/e2e/utils/modularActionsBuilder/index");

packSpliceInfo({
  sourceActionIndex: 0,
  srcOffset: 0,
  dstOffset: 132,
  length: 32,
});
// => 0n | (0n << 64n) | (132n << 128n) | (32n << 192n)
```

There is **no built-in pull** in `performActions`. Compose AllowanceHolder `transferFrom` (or other setup) as ordinary actions in the signed/off-chain-built sequence.

---

## Internal helpers (shared behavior)

- **`_pullFromUser`** — AllowanceHolder ERC-20 pull or native `msg.value` check.
- **`_execSwap`** — balance-delta or returndata word decode; enforces `minOutput` at the entrypoint.
- **`_execBridge`** — optional `BytesSpliceLib.spliceWord` on bridge calldata, approval, then `_execCall`.
- **`_execCall` / `_execCallCalldata`** — low-level calls with bubbled revert data; calldata variant avoids an extra memory copy when returndata is not needed.
- **`_performActions`** — splice loop + low-level `call` / `staticcall` with bubbled revert data.

Approvals use Solady `safeApproveWithRetry` to `type(uint256).max` only when current allowance is below the needed amount.

---

## Choosing structured vs generic

| Use | When |
|-----|------|
| `swap` | Same-chain DEX with optional fee; output to a known `receiver`. |
| `swapAndBridge` | Swap then bridge; runtime bridge amount and/or native bridge value from swap output. |
| `bridge` | No swap; amount and calldata fixed before the tx. |
| `performActions` | Multi-step or integration-specific flows (e.g. swap → manipulator → splice into `SpokePool.deposit`). |

Structured entrypoints keep audit surface small: linear control flow and explicit preconditions. `performActions` is the escape hatch when the pipeline is not pull → fee → swap → bridge.

---

## Security model (summary)

| Enforced on-chain | Not enforced |
|-------------------|--------------|
| `_msgSender() == user` on ERC-20 pull | Backend signature / nonce / deadline |
| `minOutput` after swap | That calldata matches user intent |
| Splice bounds and `FutureSplice` | That `performActions` targets are benign |
| AllowanceHolder scoping for pulls | Router must not accumulate balances or receive direct user approvals |

`performActions` is **public**. Any caller can execute arbitrary action lists. Operational safety depends on users only approving AllowanceHolder, never OpenRouter directly, and on backend/frontend validating routes before `AllowanceHolder.exec`. See [`OPENROUTER_ASSUMPTIONS.md`](OPENROUTER_ASSUMPTIONS.md) for the full assumption set.

---

## Shared libraries (`src/common/`)

| Module | Role |
|--------|------|
| `CurrencyLib` | Native sentinel + transfers / `balanceOf` |
| `BytesSpliceLib` | `spliceWord` for bridge calldata; `mcopy`-based `spliceBytes` in modular path |
| `RescueFundsLib` | `rescueFunds` implementation |
| `AllowanceHolderContext` | `_msgSender()` / dummy `balanceOf` for AH |

`OpenRouterAuthBase` and signed-router variants are **not** used by this contract.

---

## Backend and tests

ABI encoders (update if the Solidity ABI changes):

- `bungee-backend/src/modules/dex/utils.ts` — `swap`, AllowanceHolder `exec`
- `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts` — `bridge`, `swapAndBridge`

Tests:

- `test/combined/OpenRouterV2Unchecked*.t.sol` — unit tests against `OpenRouter` (historical filenames; imports `src/OpenRouter.sol`)
- `test/poc/*OpenRouterPoC.t.sol` — fork PoCs using `performActions` + manipulators

Deploy: `scripts/deploy/deployOpenRouter.ts` (`constructor(address _owner)` grants `RESCUE_ROLE`).
