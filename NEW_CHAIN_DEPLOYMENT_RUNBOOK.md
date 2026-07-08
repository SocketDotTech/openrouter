# New Chain Deployment Runbook — AllowanceHolder + OpenRouter (CREATE3)

Canonical guide for deploying Socket's **AllowanceHolder** and **OpenRouter** to a **new EVM chain** using **CreateX CREATE3** with deterministic addresses matching all other production Cancun chains.

Also read:

| Doc | When |
|-----|------|
| [`ALLOWANCE_HOLDER_DEPLOYMENT.md`](ALLOWANCE_HOLDER_DEPLOYMENT.md) | AllowanceHolder bytecode variants, salts, verification source |
| [`OPENROUTER_CONTEXT.md`](OPENROUTER_CONTEXT.md) | Router integration context |
| [`OPENROUTER_ASSUMPTIONS.md`](OPENROUTER_ASSUMPTIONS.md) | Operational assumptions before enabling routes |
| [`deployments.csv`](deployments.csv) | Per-chain registry (addresses, initcode/runtime hashes) |

---

## For AI agents

**Load this file** when the user asks to deploy AllowanceHolder and/or OpenRouter on a new chain, wire a new Hardhat network, or validate a CREATE3 deployment before broadcast.

**Mandatory workflow:**

1. Confirm chain supports **CREATE3** via CreateX at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`.
2. Confirm **EVM variant** (`cancun` vs `shanghai`) — almost all Bungee chains use **cancun** (requires `TLOAD`/`TSTORE`; OpenRouter uses `MCOPY`).
3. Wire repo config (Hardhat network, `openRouterBuild.ts`, `scripts/e2e/config.ts`, verifier) — see [Repo wiring](#repo-wiring-new-chain).
4. Set env vars — see [Environment](#environment).
5. Run **dry run** before any live tx — see [Dry run](#dry-run-mandatory-before-broadcast).
6. Deploy **AllowanceHolder first**, then **OpenRouter** (OR deploy script requires AH live on-chain).
7. Verify on block explorer; update `deployments.csv`, backend, and e2e config.

**Do not:**

- Use direct CREATE / ad-hoc test addresses for production rollout (breaks address parity).
- Deploy OpenRouter before AllowanceHolder is live at the canonical AH address.
- Skip initcode hash checks — wrong bytecode deploys to the right address but wrong logic.
- Set `OWNER_ADDRESS` for OpenRouter — OpenRouter has **no owner** (that env is for BungeeReceiver / executors).

**Canonical CREATE3 addresses (same on every chain with default salts):**

| Contract | Address | CREATE3 salt text |
|----------|---------|-------------------|
| AllowanceHolder | `0x50c4E75a512F2A14A7b304787Adf79C4531A5909` | `AllowanceHolder50c4e7:5981577` |
| OpenRouter | `0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a` | `OpenRouter50cfe7:4030514` |

**Production Cancun initcode / runtime hashes** (must match on new chain — see `deployments.csv` row for Ethereum or any live Cancun chain):

| Artifact | Hash |
|----------|------|
| AH initcode | `0xe0afa70daed24ec949499638683365cbe4cbf097a1c8417a730e4b497cfb4610` |
| AH runtime | `0x0be5794255d21df0f4a10a516428f8d06805779d69b1714297bebcc18971e0b4` |
| OR initcode | `0x0e5ff42eb7810767de756c833a042818f95052b885634a3dc3adb679a4652f48` |
| OR runtime | `0xd1dbc2c8ca87939cadf58e4eb91832cbe44bd5d12e3a0a0d56c76928a818e26b` |

---

## Overview

```text
Prerequisites → Repo wiring → Env + AH bytecode → Dry run → AH deploy → OR deploy → Verify → Backend sync
```

Both contracts deploy through **CreateX CREATE3** (`scripts/deploy/create3.ts`). Deploy scripts:

- Resolve the deterministic address from salt + factory.
- Assert it equals the canonical Socket address.
- Run `deployCreate3.staticCall` on the target chain (constructor must succeed).
- Prompt for confirmation (`y/n`) before broadcast.
- Upsert `deployments.csv` after success.

**OpenRouter has no constructor and no owner.** It is compiled from `src/OpenRouter.sol` with the compile-time `ALLOWANCE_HOLDER` constant patched to `0x50c4E75…`.

---

## Prerequisites (target chain)

| Requirement | How to verify |
|-------------|---------------|
| **CreateX factory** | `cast code 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed --rpc-url $CHAIN_RPC` returns bytecode |
| **Cancun opcodes** (typical) | Chain supports `TLOAD`/`TSTORE` (EIP-1153) and `MCOPY` (EIP-5656). Chains on **Pectra** or later generally include Cancun; compile with Hardhat `evmVersion: cancun`. |
| **No Cancun** (rare) | Use `shanghai` AllowanceHolder bytecode only if chain lacks `TLOAD`. OpenRouter **cannot** deploy on no-Cancun chains until `mcopy` usage is replaced (`openRouterBuild.ts` blocks shanghai builds). |
| **Empty canonical slots** | `cast code 0x50c4E75…` and `cast code 0x50cFe7…` return `0x` before deploy |
| **Funded deployer** | Enough native gas for two CREATE3 txs (~0.000003–0.01 native depending on chain; estimate in dry run) |
| **Deployer key in shell** | Hardhat reads `DEPLOYER_PRIVATE_KEY` (not `PRIVATE_KEY` alone) |

### Pectra / zkEVM notes (example: Citrea 4114)

- Citrea advertises **Pectra** EVM; use **`cancun` variant** for AH bytecode and `OPENROUTER_EVM_VERSION=cancun`.
- Citrea does **not** support EIP-4844 blobs/KZG — OpenRouter/AH do not require them.
- Native gas token may use **18 decimals** (e.g. cBTC on Citrea) — fund deployer accordingly.

---

## Repo wiring (new chain)

Add the chain to these files before `--network <name>` works:

| File | What to add |
|------|-------------|
| [`hardhat.config.ts`](hardhat.config.ts) | `networks.<name>` (url, chainId, accounts), explorer `apiKey`, `customChains` entry for verify |
| [`scripts/e2e/config.ts`](scripts/e2e/config.ts) | `CHAIN_IDS.<NAME>`, `BLOCK_EXPLORER_TX_PREFIX`, `RPC.<NAME>`, `ALLOWANCE_HOLDER_VARIANT_BY_CHAIN_ID` if not default `cancun` |
| [`scripts/deploy/openRouterBuild.ts`](scripts/deploy/openRouterBuild.ts) | `OPENROUTER_NETWORK_CHAIN_IDS` + `OPENROUTER_DEPLOY_NETWORKS` |
| [`scripts/deploy/networks.ts`](scripts/deploy/networks.ts) | `RECEIVER_DEPLOY_NETWORKS` entry + RPC env alias if backend uses `*_RPC_URL` |
| [`scripts/deploy/verifyAllowanceHolderBatch.ts`](scripts/deploy/verifyAllowanceHolderBatch.ts) | Block explorer verifier for chainId (Blockscout / Etherscan v2 / Sourcify) |
| [`.env.example`](.env.example) | `<CHAIN>_RPC`, `<CHAIN>_ETHERSCAN_KEY` |

**After deploy (e2e / production routes):**

| File | What to add |
|------|-------------|
| [`scripts/e2e/config.ts`](scripts/e2e/config.ts) | `OPEN_ROUTER_CHAIN_IDS` — only after OR is live |
| **bungee-backend** | Chain RPC, router/AH addresses, route enablement (separate repo) |

---

## Environment

Copy [`.env.example`](.env.example) → `.env`. Minimum for a new **Cancun** chain deploy:

```bash
# Signer (Hardhat deploy scripts)
DEPLOYER_PRIVATE_KEY=...

# Target chain RPC (or rely on hardhat.config fallback)
<CHAIN>_RPC=https://...

# AllowanceHolder — REQUIRED for AH deploy (not for OR compile)
ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE=0x...
ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH=0xe0afa70daed24ec949499638683365cbe4cbf097a1c8417a730e4b497cfb4610

# Explorer verify (optional until verify step)
<CHAIN>_ETHERSCAN_KEY=...
# or ETHERSCAN_API_KEY=...
```

### AllowanceHolder bytecode — how to obtain

AH is **not** compiled at deploy time from `src/`. You must supply **pre-built creation bytecode**:

1. Source: [`verification/allowance-holder/`](verification/allowance-holder/) — patched 0x Cancun AllowanceHolder (constructor allows Socket CREATE3 address).
2. Build: Foundry, solc **0.8.25**, optimizer **1_000_000** runs, EVM **cancun** (see `verification/allowance-holder/foundry.toml`).
3. Export `bytecode.object` from `out/AllowanceHolder.sol/AllowanceHolder.json`.
4. **Important:** Local compile metadata may differ from production. The initcode hash **must** equal `0xe0afa70d…`. If a fresh compile hashes differently, use production bytecode (same artifact deployed on Ethereum) — see dry run cross-chain checks.

Set `ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH` so deploy aborts on wrong bytecode.

### Prod signer via 1Password (optional)

```bash
source /path/to/bungee-sandbox/setup-prod-env.sh
export DEPLOYER_PRIVATE_KEY="$PRIVATE_KEY"   # Hardhat expects this name
```

`setup-prod-env.sh` exports `PRIVATE_KEY` only; map to `DEPLOYER_PRIVATE_KEY` before Hardhat deploy.

### Not required for AH / OR deploy

| Env | Why ignored |
|-----|-------------|
| `OWNER_ADDRESS` | BungeeReceiver / RFQVaultExecutor only |
| `OPENROUTER_ADDRESS` | Override for checks only; production uses canonical CREATE3 address |
| `ALLOWANCE_HOLDER_SHANGHAI_*` | Only for no-TLOAD chains (e.g. Mantle) |

---

## Dry run (mandatory before broadcast)

### Citrea (chainId 4114)

Script: [`scripts/deploy/dryRunCitreaDeployment.ts`](scripts/deploy/dryRunCitreaDeployment.ts)

```bash
source ../bungee-sandbox/setup-prod-env.sh   # if using 1Password
export DEPLOYER_PRIVATE_KEY="$PRIVATE_KEY"

cd poc-openrouter
npx ts-node --transpile-only scripts/deploy/dryRunCitreaDeployment.ts
```

**What it validates (no broadcast):**

| Check | |
|-------|---|
| CreateX deployed on target chain | |
| Canonical AH/OR slots empty on target | |
| AH initcode hash vs env + `deployments.csv` reference | |
| OR initcode hash vs `deployments.csv` reference | |
| CREATE3 `staticCall` → canonical addresses on target | |
| **Cross-chain:** live runtime bytecode on reference chain (default Ethereum) at same addresses matches registry hashes | |
| Gas estimate + deployer balance | |

Optional: `DRY_RUN_REFERENCE_CHAIN_ID=8453` to use Base (or any chain with AH+OR in `deployments.csv`) as reference instead of Ethereum.

### Other new chains

Adapt `dryRunCitreaDeployment.ts` (change `CHAIN_ID` / deployer) or manually run the same checks:

```bash
# Empty slots
cast code 0x50c4E75a512F2A14A7b304787Adf79C4531A5909 --rpc-url $CHAIN_RPC
cast code 0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a --rpc-url $CHAIN_RPC

# Reference runtime hashes (Ethereum)
cast keccak $(cast code 0x50c4E75a512F2A14A7b304787Adf79C4531A5909 --rpc-url $ETH_RPC)
# expect 0x0be5794255d21df0f4a10a516428f8d06805779d69b1714297bebcc18971e0b4
```

---

## Live deployment

### Step 1 — AllowanceHolder

```bash
npm run deploy:allowance-holder -- <network>
# equivalent: npx hardhat run scripts/deploy/deployAllowanceHolder.ts --network <network>
```

Script: [`scripts/deploy/deployAllowanceHolder.ts`](scripts/deploy/deployAllowanceHolder.ts)

Flow:

1. Assert CreateX on chain.
2. Resolve AH bytecode + initcode hash from env.
3. Assert target address = `0x50c4E75…`.
4. `deployCreate3.staticCall` — constructor guard must pass on target chainId.
5. Print confirmation summary → **`Proceed with CREATE3 deployment? (y/n)`**.
6. Broadcast CREATE3 tx.
7. Upsert `deployments.csv`.

### Step 2 — OpenRouter

```bash
npm run deploy -- <network>
# runs scripts/deploy/deployOpenRouterPatched.ts
```

Script: [`scripts/deploy/deployOpenRouterPatched.ts`](scripts/deploy/deployOpenRouterPatched.ts) → [`deployOpenRouter.ts`](scripts/deploy/deployOpenRouter.ts)

Flow:

1. `prepareOpenRouterBuild(<network>)` — patches `ALLOWANCE_HOLDER` in `IAllowanceHolder.sol`, upserts build row in `deployments.csv`, sets `OPENROUTER_EVM_VERSION`.
2. Hardhat compiles OpenRouter (`evmVersion: cancun` typical).
3. Assert AH **deployed** on-chain at `0x50c4E75…`.
4. Assert OR target = `0x50cFe7…`.
5. `deployCreate3.staticCall` with compiled initcode.
6. Confirmation prompt → broadcast.
7. Upsert `deployments.csv`; optional inline `verify:verify` on explorer.

**Do not use** `npm run deploy:openrouter:raw` unless `IAllowanceHolder.sol` is already patched manually.

---

## Post-deploy verification

```bash
npm run check:allowance-holder -- --network <network>
npm run check:openrouter -- --network <network>

npm run verify:allowance-holder -- <network>
npm run verify:openrouter -- <network>
```

AH verification source: [`verification/allowance-holder/`](verification/allowance-holder/). Some explorers report partial match due to metadata hash differences — runtime logic still matches.

Confirm runtime hashes on new chain match reference:

```bash
cast keccak $(cast code 0x50c4E75a512F2A14A7b304787Adf79C4531A5909 --rpc-url $CHAIN_RPC)
cast keccak $(cast code 0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a --rpc-url $CHAIN_RPC)
```

---

## Backend and registry sync

| System | Action |
|--------|--------|
| `deployments.csv` | Auto-updated by deploy scripts; commit the new row |
| `scripts/e2e/config.ts` | Add chainId to `OPEN_ROUTER_CHAIN_IDS` when routes should use OR |
| **bungee-backend** | Add chain config, router address, AH address, enable bridge/DEX routes |
| **Loki / indexer** | Add chain + OpenRouter indexing if applicable |

Keep `deployments.csv`, e2e config, backend, and compiled OpenRouter `ALLOWANCE_HOLDER` constant in sync. Changing only backend config **does not** change already-deployed OpenRouter bytecode.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `DEPLOYER_PRIVATE_KEY` / no signer | Key not in `.env`; or only `PRIVATE_KEY` set from 1Password — export `DEPLOYER_PRIVATE_KEY` |
| Initcode hash mismatch | Wrong AH bytecode in env; rebuild or copy production artifact |
| `CreateX factory not deployed` | Chain missing CreateX at canonical address |
| OR deploy: AH not deployed | Run step 1 first; check `cast code 0x50c4E75…` |
| `staticCall` reverts on AH | Constructor guard / wrong chainId / wrong initcode |
| Shanghai build refused for OR | Chain needs Cancun; or replace `mcopy` in OpenRouter source |
| Insufficient balance | Fund deployer native token |
| Verify fails | Wrong explorer API / use Blockscout custom URL in `verifyAllowanceHolderBatch.ts` |

---

## Address safety (why you won't "lose" the slot)

CREATE3 with **fixed salts** always targets the same addresses. Deploy scripts:

- Reject CREATE3 address ≠ canonical expected address.
- Reject initcode hash ≠ production hash (when env hash set).
- Run `staticCall` before broadcast (constructor simulation).

If a tx fails, the canonical slot stays **empty** — retry with the same salt and bytecode. Wrong bytecode is caught by initcode hash check before broadcast.

**Never change CREATE3 salt text** for production without understanding you will get a **different** address.

---

## Quick reference commands

```bash
# Dry run (Citrea example)
npx ts-node --transpile-only scripts/deploy/dryRunCitreaDeployment.ts

# Deploy
npm run deploy:allowance-holder -- citrea
npm run deploy -- citrea

# Check + verify
npm run check:allowance-holder -- --network citrea
npm run check:openrouter -- --network citrea
npm run verify:allowance-holder -- citrea
npm run verify:openrouter -- citrea
```

---

## Related scripts

| Script | Purpose |
|--------|---------|
| [`scripts/deploy/deployAllowanceHolder.ts`](scripts/deploy/deployAllowanceHolder.ts) | AH CREATE3 deploy |
| [`scripts/deploy/deployOpenRouterPatched.ts`](scripts/deploy/deployOpenRouterPatched.ts) | Patch + OR deploy entrypoint |
| [`scripts/deploy/deployOpenRouter.ts`](scripts/deploy/deployOpenRouter.ts) | OR CREATE3 deploy (called by patched wrapper) |
| [`scripts/deploy/deployConfirm.ts`](scripts/deploy/deployConfirm.ts) | Address assert + interactive confirm |
| [`scripts/deploy/dryRunCitreaDeployment.ts`](scripts/deploy/dryRunCitreaDeployment.ts) | Citrea preflight + cross-chain bytecode parity |
| [`scripts/deploy/create3.ts`](scripts/deploy/create3.ts) | Salts, expected addresses, CreateX helpers |
| [`scripts/deploy/openRouterBuild.ts`](scripts/deploy/openRouterBuild.ts) | Per-network compile profile + AH constant patch |
