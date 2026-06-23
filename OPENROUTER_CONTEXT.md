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

## Deployment addresses

Canonical source: [`scripts/e2e/config.ts`](scripts/e2e/config.ts) — keep in sync with `bungee-backend/src/modules/directQuote/directQuote.config.ts` and `directQuote.constants.ts`.

**OpenRouter** (CREATE3, all supported chains): `0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a`

**AllowanceHolder** (chain-specific; users approve this, not OpenRouter):

| Address | Chains |
|---------|--------|
| `0x50c4E75a512F2A14A7b304787Adf79C4531A5909` | Socket CREATE3 holder for all configured holder chains |

Resolve at runtime with `allowanceHolderForChain(chainId)` in e2e scripts. On-chain, `OpenRouter` hardcodes the holder address in `IAllowanceHolder.sol`; chains with a non-canonical AllowanceHolder require a chain-specific router build or backend-only routing — confirm deployment parity before enabling those chains in production.

Deployment helpers:

- 0x has two AllowanceHolder hardfork variants: Cancun/EIP-1153 uses transient `tload/tstore`; Shanghai/no-TLOAD uses the storage-backed `AllowanceHolderOld` pattern.
- `scripts/deploy/checkAllowanceHolderDeployment.ts` checks bytecode at the configured holder address and upserts the chain row in `deployments.csv`.
- `scripts/deploy/deployAllowanceHolder.ts` deploys holder bytecode from `ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE` or `ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE`, checks optional initcode hashes, and uses CreateX CREATE3 with salt text `AllowanceHolder50c4e7:5981577`.
- CREATE3 deployment requires the canonical CreateX factory at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` on the target chain.
- Unchanged upstream 0x holder bytecode checks `address(this)` against 0x's addresses in its constructor, so CREATE3 requires our own or patched holder bytecode that permits the CreateX-computed address.
- Override holder config with `ALLOWANCE_HOLDER_CHAIN_<chainId>` / global `ALLOWANCE_HOLDER_ADDRESS`; override hardfork variant with `ALLOWANCE_HOLDER_VARIANT_CHAIN_<chainId>` / global `ALLOWANCE_HOLDER_VARIANT`.
- `scripts/deploy/deployOpenRouterPatched.ts` must be used for chain-specific router deploys. It patches `src/common/interfaces/IAllowanceHolder.sol` before compilation and upserts build data in `deployments.csv`; `deployOpenRouter.ts` upserts OpenRouter deployment fields after the CREATE3 tx is confirmed. Holder address priority is env override, then `deployments.csv`, then static config.
- `scripts/deploy/deployOpenRouterByBuildProfile.ts` batches router deploys by `(EVM version, AllowanceHolder address)`, compiles once per profile, then deploys matching networks in parallel with `--no-compile`.
- OpenRouter currently uses Cancun `mcopy` in `src/OpenRouter.sol` and `src/common/lib/BytesSpliceLib.sol`; the patched deploy wrapper refuses Shanghai/no-Cancun OpenRouter builds until those copies are made fork-compatible.

## CctpClaimExecutor (destination CCTP v2 claim)

Contract: [`src/executors/CctpClaimExecutor.sol`](src/executors/CctpClaimExecutor.sol)

- CREATE3 salt: `CctpClaimExecutorV2` (see [`scripts/deploy/create3.ts`](scripts/deploy/create3.ts))
- Expected address (canonical CreateX): `0x424a31A57F7C63918eCaA2Fac38016A8af5A6eC2` on all deployed chains
- Deploy: `scripts/deploy/deployCctpClaimExecutor.ts` (single chain) or `deployCctpClaimExecutorAllChains.ts`
- Required env: `DEPLOYER_PRIVATE_KEY`, `SOLVER_SIGNER_ADDRESS` (must match transmitter `SignerService` / `BungeeReceiver.SOLVER_SIGNER`)
- Source `depositForBurn` must set `mintRecipient` and `destinationCaller` to the claim executor
- Transmitter signs and calls `claim(message, attestation, recipient, feeTaker, quotedRelayFee, signature)`; relay fee is collected in USDC on destination
- Replay protection is on Circle `MessageTransmitter.usedNonces` (no local nonce map); fee split uses minted balance delta minus `quotedRelayFee`

Sync deployed address into:

- `bungee-backend/src/modules/router/routers/cctp-v2/cctp-v2.config.ts` → `CCTP_CLAIM_EXECUTOR_ADDRESSES`
- `new-bungee-transmitter/src/shared/cctp-v2/constants.ts` → `CCTP_CLAIM_EXECUTOR_ADDRESSES`

## Gotchas

- ERC-20 inputs must be submitted through 0x AllowanceHolder, not directly to the router, or `_msgSender() == user` fails.
- Native input paths send ETH with the outer `AllowanceHolder.exec` call; no ERC-20 pull happens.
- `bridge()` cannot splice runtime amounts. Use `swapAndBridge()` when bridge calldata needs the live swap output.
- `swapAndBridge()` often uses balance-delta output measurement in backend builders.
- Production use of `OpenRouter` needs an operational access-control decision at the product layer; the contract itself has no signature or nonce checks.
- Legacy e2e script filenames may still say `performExecution`; many of those scripts now call `swapAndBridge` or modular `performActions` — read each script before running.
