# OpenRouter Contract Context

Last reviewed: 2026-05-27.

Main ship target:

- [`src/OpenRouter.sol`](src/OpenRouter.sol) — contract `OpenRouter`

There is no separate signed router in this repo. Backend and e2e tooling target the unchecked `OpenRouter` ABI (no backend signature, nonce, or deadline).

## Surface

`OpenRouter` removes backend signature verification, nonce, and deadline fields. Fund safety for ERC-20 inputs depends on 0x AllowanceHolder transient approvals plus `_msgSender() == input.user` in `_pullFromUser`.

External entrypoints (first parameter is always `quoteId` for `RequestExecuted` correlation):

- `swap(bytes32 quoteId, uint256 flags, InputData input, FeeData fee, SwapData swapData, bytes swapCallData, address receiver)`
  - Same-chain DEX path.
  - Pre-fee / no-fee: swap calldata must send output directly to `receiver`.
  - Post-fee: output lands on the router; fee is skimmed, net is forwarded to `receiver`.
- `swapAndBridge(bytes32 quoteId, uint256 flags, InputData input, FeeData fee, SwapData swapData, bytes swapCallData, BridgeData bridgeData, bytes bridgeCallData)`
  - Swap output always lands on the router for bridging.
  - Supports runtime bridge amount splice and native bridge-value mode via `flags`.
- `bridge(bytes32 quoteId, InputData input, FeeData fee, BridgeData bridgeData, bytes bridgeCallData)`
  - Direct bridge, no swap.
  - No runtime splice; bridge amount must already be encoded in `bridgeCallData`.
- `performActions(bytes32 quoteId, Action[] actions)`
  - Generic action loop with packed `actionInfo` and `splices[]`.
- `rescueFunds(address token, address rescueTo, uint256 amount)` — `RESCUE_ROLE` only.

The monolithic `performExecution(...)` entrypoint from earlier designs was removed. Use `swap`, `swapAndBridge`, `bridge`, or `performActions` instead.

E2e ABI fragments: [`scripts/e2e/utils/routerAbi.ts`](scripts/e2e/utils/routerAbi.ts).

## Flags

Flag constants in [`src/OpenRouter.sol`](src/OpenRouter.sol):

- `0x01` — post-swap fee for `swap` and `swapAndBridge`; clear = pre-fee from input.
- `0x02` — measure swap output by `balanceOf` delta; clear = decode return word at `SwapData.returnDataWordOffset`.
- `0x04` — bridge `msg.value = finalAmount + BridgeData.value` (native bridged asset paths).
- `0x08` — splice `finalAmount` into `bridgeCallData` at byte offset `(flags >> 16) & 0xffff`.
- Bits `16..31` — uint16 byte offset for the bridge amount splice when `0x08` is set.

Backend constants live in:

- `bungee-backend/src/modules/dex/dex.config.ts`
- `bungee-backend/src/modules/router/router.config.ts`

Keep those masks and deployed addresses in sync with this contract.

## Modular packing

`Action.actionInfo` is packed as:

```text
callType | (storeResult ? 1 << 8 : 0) | (uint160(target) << 16)
```

`Action.splices[]` entries are packed as:

```text
sourceActionIndex | (srcOffset << 64) | (dstOffset << 128) | (length << 192)
```

`CallType.CALL_WITH_NATIVE` treats the first 32 bytes of `action.data` as the call value and the remaining bytes as calldata. PoCs use this for native fee transfers and Stargate native sends.

Builder helpers: [`scripts/e2e/utils/modularActionsBuilder/`](scripts/e2e/utils/modularActionsBuilder/).

## Current PoCs

- [`test/poc/OpenOceanAcrossOpenRouterPoC.t.sol`](test/poc/OpenOceanAcrossOpenRouterPoC.t.sol)
  - Modular OpenOcean USDC → WETH swap.
  - `AcrossERC20AmountManipulator` derives the Across output amount.
  - Splices swap output and derived output into `SpokePool.deposit`.
- [`test/poc/OpenOceanStargateNativeOpenRouterPoC.t.sol`](test/poc/OpenOceanStargateNativeOpenRouterPoC.t.sol)
  - Modular OpenOcean USDC → native ETH.
  - `MathManipulator` derives fee, post-fee amount, and bridge amount.
  - Uses `CALL_WITH_NATIVE` and splices Stargate `amountLD`.
- [`test/poc/OneInchCctpOpenRouterPoC.t.sol`](test/poc/OneInchCctpOpenRouterPoC.t.sol)
  - CCTP-oriented PoC.
- [`test/poc/OpenRouterAllowanceHolderFork.t.sol`](test/poc/OpenRouterAllowanceHolderFork.t.sol)
  - Polygon fork: AllowanceHolder `exec` → router pull.

Fork tests need RPC env vars and sometimes block pins. Example:

```bash
ARBITRUM_RPC=... ARBITRUM_FORK_BLOCK=461716058 forge test --match-path test/poc/OpenOceanAcrossOpenRouterPoC.t.sol -vv
```

Use `FOUNDRY_PROFILE=poc` to run only `test/poc/**` (see `foundry.toml`).

## Unit tests

Structured-route tests live under `test/combined/` and import [`src/OpenRouter.sol`](src/OpenRouter.sol). File names still use the historical `OpenRouterV2Unchecked*` prefix; the contract under test is `OpenRouter`.

## Backend ABI expectations

The backend encodes the router ABI in:

- `bungee-backend/src/modules/dex/utils.ts` — `swap`, AllowanceHolder `exec`
- `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts` — `bridge`, `swapAndBridge`

Solidity uses `quoteId`; some backend helpers still name the same bytes32 `requestHash` in TypeScript. The encoded value is the correlation id only — not a replay guard.

If the Solidity ABI changes, update those hard-coded ABI strings first. Direct DEX and direct bridge quote builders depend on them.

## Deployed addresses

Canonical source: [`scripts/e2e/config.ts`](scripts/e2e/config.ts) — keep in sync with `bungee-backend/src/modules/directQuote/directQuote.config.ts` and `directQuote.constants.ts`.

**OpenRouter** (CREATE3, all supported chains): `0x1Cb8E88afDe521aaA0108F2b788D467C286ABAe7`

**AllowanceHolder** (chain-specific; users approve this, not OpenRouter):

| Address | Chains |
|---------|--------|
| `0x0000000000001fF3684f28c67538d4D072C22734` | Default 0x CREATE2 holder |
| `0x0000000000005E88410CcDFaDe4a5EfaE4b49562` | Mantle |
| `0x105F1403277E737b312214DdE8067E9ffBCf7F12` | Sei, MegaETH, Plume, Soneium |

Resolve at runtime with `allowanceHolderForChain(chainId)` in e2e scripts. On-chain, `OpenRouter` hardcodes the canonical CREATE2 address in `IAllowanceHolder.sol`; chains with a non-canonical AllowanceHolder require a chain-specific router build or backend-only routing — confirm deployment parity before enabling those chains in production.

## Gotchas

- ERC-20 inputs must be submitted through 0x AllowanceHolder, not directly to the router, or `_msgSender() == user` fails.
- Native input paths send ETH with the outer `AllowanceHolder.exec` call; no ERC-20 pull happens.
- `bridge()` cannot splice runtime amounts. Use `swapAndBridge()` when bridge calldata needs the live swap output.
- `swapAndBridge()` often uses balance-delta output measurement in backend builders.
- Production use of `OpenRouter` needs an operational access-control decision at the product layer; the contract itself has no signature or nonce checks.
- Legacy e2e script filenames may still say `performExecution`; many of those scripts now call `swapAndBridge` or modular `performActions` — read each script before running.
