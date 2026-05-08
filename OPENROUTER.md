# BungeeOpenRouter — Contract Variants

> **Monolithic** — non-generic; purpose-built with fees, swap, bridge functionality

> **Modular** — generic; supports arbitrary actions; uses returndata from previous calls and modifies parts of next calldata

> **Minimal** — generic; supports arbitrary actions; but no calldata modification; each subsequent action destination contract can read state eg. balanceOf() and uses them as needed; 

All versions uses signature verification.

Three versions of the OpenRouter contract exist, each making a different trade-off between rigidity and generality. All three share the same authentication model; they differ only in how the execution steps are expressed and how outputs flow between steps.

**Source layout** (under `src/`):

```text
src/
  Counter.sol                         # scaffold only
  common/                             # shared by every variant + AH offshoots
    OpenRouterAuthBase.sol
    lib/AuthenticationLib.sol
    lib/BytesSpliceLib.sol
    lib/CurrencyLib.sol
    utils/Ownable.sol
    interfaces/IAllowanceHolder.sol
    allowance/AllowanceHolderContext.sol
  monolithic/
    BungeeOpenRouter.sol
    BungeeOpenRouterAH.sol
  modular/
    BungeeOpenRouterModular.sol
    BungeeOpenRouterModularAH.sol
  minimal/
    BungeeOpenRouterMinimal.sol
    BungeeOpenRouterMinimalAH.sol
```

Each variant subdirectory holds the ERC20-facing contract and its AllowanceHolder sibling; imports reach into `../common/`.

---

## What is shared across all three

Every version inherits `OpenRouterAuthBase` from [`src/common/OpenRouterAuthBase.sol`](src/common/OpenRouterAuthBase.sol). The only things hard-wired in the contract are:

- **A single trusted signer** (`OPEN_ROUTER_SIGNER`), rotatable by the owner via two-step `Ownable`. This is the backend solver/orchestration service address.
- **Per-nonce replay protection.** A `nonceUsed` mapping is written with an assembly `sstore` the moment a valid signature is verified. Any attempt to resubmit the same nonce reverts with `InvalidNonce()` before touching any funds.
- **A deadline field.** The signature carries a `deadline` (unix timestamp). Expired payloads revert with `DeadlineExpired()`.
- **Chain + deployment binding.** The signed digest always includes `block.chainid` and `address(this)`. A payload signed for one deployment cannot be replayed on a different chain or a different deployment of the same contract.

The signature itself is a plain personal_sign (`\x19Ethereum Signed Message:\n32` prefix, 65-byte `r,s,v`) over `keccak256(abi.encode(chainid, address(this), executionPayload))`. This matches the scheme used in the marketplace `Solver` and `StakedRouterReceiver` contracts.

```solidity
// src/common/OpenRouterAuthBase.sol — `_verifyAndConsume`
if (AuthenticationLib.authenticate(digest, signature) != OPEN_ROUTER_SIGNER) {
    assembly {
        mstore(0x00, 0x815e1d64) // InvalidSigner()
        revert(0x1c, 0x04)
    }
}

assembly {
    mstore(0, nonce)
    mstore(0x20, nonceUsed.slot)
    let dataSlot := keccak256(0, 0x40)
    if and(sload(dataSlot), 0xff) {
        mstore(0x00, 0x756688fe) // InvalidNonce()
        revert(0x1c, 0x04)
    }
    sstore(dataSlot, 0x01)
}
```

The contract has no reentrancy guard, matching `Solver` and `StakedRouterReceiver`. The combination of a fresh nonce per call and a signature that covers the entire payload is the security boundary.

---

## v1 — BungeeOpenRouter (monolithic)

**File:** [`src/monolithic/BungeeOpenRouter.sol`](src/monolithic/BungeeOpenRouter.sol). AllowanceHolder variant: [`src/monolithic/BungeeOpenRouterAH.sol`](src/monolithic/BungeeOpenRouterAH.sol).

This version encodes the full execution pipeline directly in the contract. The steps are explicit, ordered, and named. The signed payload is a single `Execution` struct:

```solidity
struct Execution {
    address user;
    address inputToken;
    uint256 inputAmount;

    address preFeeReceiver;   // address(0) to skip
    uint256 preFeeAmount;     // taken in inputToken, before swap

    address swapTarget;       // address(0) to skip swap entirely
    address swapApprovalSpender;
    address swapOutputToken;
    uint256 swapValue;
    uint256 swapMinOutput;
    bytes   swapData;

    address postFeeReceiver;  // address(0) to skip
    uint256 postFeeAmount;    // taken in finalToken, after swap

    address bridgeTarget;
    address bridgeApprovalSpender;
    uint256 bridgeValue;
    bytes   bridgeData;
    uint256[] bridgeAmountPositions;  // byte offsets where finalAmount is written

    uint256 nonce;
    uint256 deadline;
}
```

The contract `performExecution` function walks through this struct in a fixed order:

1. Pull `inputAmount` of `inputToken` from `user` (ERC20 `transferFrom` into the contract).
2. If `preFeeAmount > 0`, send that amount to `preFeeReceiver` immediately.
3. If `swapTarget != address(0)`, take a pre-swap balance snapshot of `swapOutputToken`, call the swap target, measure the balance delta, enforce `delta >= swapMinOutput`. The delta becomes `finalAmount` and `swapOutputToken` becomes `finalToken`. If there is no swap, `finalToken = inputToken` and `finalAmount = inputAmount - preFeeAmount`.
4. If `postFeeAmount > 0`, send that amount from `finalToken` to `postFeeReceiver`.
5. Write `finalAmount` into `bridgeData` at every byte offset in `bridgeAmountPositions` using an in-place `mstore`. This is the same pattern as `GenericStakedRoute.executeData`:

```solidity
// src/common/lib/BytesSpliceLib.sol — `spliceWord`, called for each position
assembly ("memory-safe") {
    mstore(add(add(data, 0x20), position), word)
}
```

6. If `bridgeApprovalSpender != address(0)`, approve it for `finalAmount`.
7. Call `bridgeTarget` with the patched `bridgeData`, forwarding `bridgeValue` ETH. Any revert bubbles up with its original error data.

**When to use this.** Routes where the shape of the flow is always the same: pull → optional pre-fee → optional swap → optional post-fee → bridge. The contract knows the meaning of every field and enforces sensible preconditions (e.g. `finalAmount` cannot underflow below a fee). Adding a step that does not fit this shape — like a second bridge call, a pre-swap approval to a different address, or an intermediate hop — is not possible without deploying a new version of the contract.

**AllowanceHolder variant (`BungeeOpenRouterAH`).** Instead of pulling with ERC20 `transferFrom` from the user to the router, the pull step calls 0x `AllowanceHolder.transferFrom` so funds move under that contract’s transient allowance (user approves AllowanceHolder, user calls `AllowanceHolder.exec` with `target = this router` and calldata invoking `performExecution`). The AH entry decodes `_msgSender()` as the original user appended by AllowanceHolder; `_pullFromUser` requires `_msgSender() == user`, so only the signer-named user matches the ephemeral allowance binding. Like Settler + AH patterns, `AllowanceHolderContext` exposes a harmless `balanceOf` on the router so AllowanceHolder’s confused-deputy probe succeeds; the rest of the pipeline is unchanged.

---

## v2 — BungeeOpenRouterModular (generic actions + returndata splicing)

**File:** [`src/modular/BungeeOpenRouterModular.sol`](src/modular/BungeeOpenRouterModular.sol). AllowanceHolder variant: [`src/modular/BungeeOpenRouterModularAH.sol`](src/modular/BungeeOpenRouterModularAH.sol).

This version removes all domain-specific knowledge from the contract. The only signed payload is a list of `Action`s:

```solidity
struct Action {
    CallType callType;   // CALL, DELEGATECALL, or STATICCALL
    address  target;
    uint256  value;      // ETH forwarded; must be zero for non-CALL
    bytes    data;       // base calldata, may be partially overwritten by splices
    Splice[] splices;    // applied to data before this action runs
}

struct Splice {
    uint256 srcOffset;  // byte offset within the *previous* action's returndata
    uint256 dstOffset;  // byte offset within this action's data
    uint256 length;     // how many bytes to copy
}
```

The loop is:

```
prevReturn = empty bytes
for each action:
    apply all splices (copy ranges from prevReturn into action.data)
    dispatch the call
    prevReturn = returndata from this call
```

**How splicing works.** The problem it solves: after a swap, the exact output amount is not known until runtime. The signed `data` for the subsequent bridge call contains a placeholder value at some byte offset. A splice says "before you make this call, copy bytes `[srcOffset, srcOffset+length)` from what the previous call returned into `data[dstOffset, dstOffset+length)`". After the copy, the call is made with the updated data.

A concrete example: suppose action 0 is a STATICCALL to `balanceOf(address(this))` on the output token. Its returndata is 32 bytes encoding the current balance. Action 1 is the bridge call. Its `splices` list contains one entry: `{ srcOffset: 0, dstOffset: 68, length: 32 }`, which says "take the 32-byte balance from action 0's returndata and write it at byte 68 of the bridge calldata". When action 1 runs, its calldata already has the live balance written in.

Under the hood, the copy uses `mcopy` (Cancun, EIP-5656):

```solidity
// BytesSpliceLib.spliceBytes
assembly ("memory-safe") {
    mcopy(
        add(add(dst, 0x20), dstOffset),
        add(add(src, 0x20), srcOffset),
        length
    )
}
```

Both source and destination offsets are bounds-checked before the copy; zero-length splices are rejected.

**Security note on splices.** The base `data` for every action is part of the signed payload. A splice can only overwrite bytes within that signed data — it cannot change the call target, add extra function arguments, or replace the entire calldata. An adversarial return value can only influence the specific byte ranges the signer chose to splice. The signer controls which offsets are writable by choosing which splices to include.

**DELEGATECALL support.** When `callType == DELEGATECALL`, the call runs with this contract's storage and `address(this)`. This is how you plug in a separate implementation contract (analogous to how `BungeeGateway` delegates to its impl) without giving it the whitelist status required by the gateway. Caution applies: a delegatecall target can modify the contract's storage, so only trusted, audited implementation contracts should be used in this slot.

**When to use this.** Any route where the exact amount flowing between steps is not known until runtime and must be piped into the next step's calldata. The canonical motivating case is an integration like Across, where two separate fields in the bridge calldata both need to reflect the swap output amount. With `GenericStakedRoute` you can only patch one offset; with this contract you declare as many splices as needed, each targeting a different offset.

**AllowanceHolder variant (`BungeeOpenRouterModularAH`).** The action loop is identical after verification: no built-in pull. You choose how to compose an AllowanceHolder `transferFrom` (or delegatecall shim) as one or more ordinary `CALL` actions signed with everything else; `performExecutionAH` wraps that by binding the signature to `(chainId, this, signedUser, exec)` instead of omitting `signedUser`. It asserts `_msgSender() == signedUser` so nobody can burn another user’s nonce by submitting their payload inside a stranger’s `AH.exec`; real fund safety still comes from AllowanceHolder’s operator/owner/token scoping; `AllowanceHolderContext` only supplies the dummy `balanceOf` for AH’s probing.

---

## v3 — BungeeOpenRouterMinimal (generic actions, no splicing)

**File:** [`src/minimal/BungeeOpenRouterMinimal.sol`](src/minimal/BungeeOpenRouterMinimal.sol). AllowanceHolder variant: [`src/minimal/BungeeOpenRouterMinimalAH.sol`](src/minimal/BungeeOpenRouterMinimalAH.sol).

This version is the stripped-down sibling of v2. The `Action` struct has no `splices` field:

```solidity
struct Action {
    CallType callType;
    address  target;
    uint256  value;
    bytes    data;   // used exactly as signed; never mutated
}
```

The loop dispatches each action with its signed data verbatim and discards the return value. There is no mechanism to move output from one call into the input of the next.

```
for each action:
    dispatch the call (no splice step)
    discard returndata
```

**How steps communicate without splicing.** They don't — at least not through the router. Instead, the called contracts are responsible for reading whatever state they need at runtime. The most common pattern is pre/post balance accounting: the bridge target (e.g. a `GenericStakedRoute`-style contract or `BungeeApproveAndBridge`) calls `balanceOf(address(this))` itself to discover how much of the token it holds after the previous step deposited it, rather than receiving the amount as an argument.

This is exactly how `BaseRouterSingleOutput` works: it measures the swap output by comparing balances before and after the swap call, then passes the delta to `_execute`. With v3, that accounting logic lives inside the called contracts, not in the router.

**When to use this.** Routes where every action is self-contained — the called contracts know what token to look at, query their own balance, and use that as their amount. This covers most `GenericStakedRoute` flows today, since those contracts already contain the offset-patching and balance-reading logic. v3 is the right choice when you do not need cross-action data passing at the router layer, and you want the smallest possible trusted surface in the router contract itself.

**AllowanceHolder variant (`BungeeOpenRouterMinimalAH`).** Same idea as the modular AH: use `performExecutionAH` plus `AllowanceHolderContext`’s `balanceOf`; sign over `signedUser` and require `_msgSender() == signedUser` for nonce-binding; compose the AH pull as ordinary actions in `exec.actions`.

---

## Choosing between them

The three versions exist on a spectrum from "the contract knows everything" to "the contract knows nothing except who signed".

**v1** is the right choice when you want the router to be the authoritative record of what the flow does — you can read one struct and understand the entire execution. The cost is that every variant of the flow (different fee timing, multi-hop bridge, etc.) needs a new contract or a new version. It is also the easiest to audit because the control flow is linear and every named step has an explicit precondition check.

**v2** is the right choice when you need to pipe outputs between steps in ways the called contracts cannot handle themselves. The key example is when a bridge call has two separate amount fields that both need to reflect the swap output — one splice entry per field, both handled in one atomic execution. The contract becomes a thin orchestrator and the "business logic" of each step lives in the action targets.

**v3** is the right choice when the called contracts already handle their own amount discovery (balance-check style) and you just need a trusted sequencer that ensures the actions run in the signed order. It is the most gas-efficient version at the router layer because there is no splice computation overhead, and it is the easiest to build new action targets for because those targets do not need to conform to any returndata shape.

---

## Shared libraries

All live under `src/common/`.

**`OpenRouterAuthBase.sol`** — abstract base all three inherit. Owns the signer address, the nonce mapping, and `_verifyAndConsume`.

**`lib/AuthenticationLib.sol`** — personal_sign recovery (`\x19Ethereum Signed Message:\n32` + ecrecover). Matches `marketplace/src/lib/AuthenticationLib.sol` exactly.

**`lib/CurrencyLib.sol`** — wraps Solady `SafeTransferLib` with a native token shortcut (address `0xEee...EEe`), identical in spirit to the marketplace `CurrencyLib`.

**`lib/BytesSpliceLib.sol`** — used by v1 (writing `finalAmount` to multiple positions in bridge calldata) and v2 (the per-splice `mcopy`). Exposes `spliceWord` (32-byte in-place overwrite, same assembly as `GenericStakedRoute`), `spliceWords` (repeat for multiple positions), and `spliceBytes` (arbitrary-length copy via `mcopy`, bounds-checked).

**`allowance/AllowanceHolderContext.sol`**, **`interfaces/IAllowanceHolder.sol`** — imported only by the `*AH` contracts in each variant folder.
