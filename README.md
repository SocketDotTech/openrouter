# OpenRouter

OpenRouter is a Bungee on-chain executor for swap, bridge, and swap-and-bridge routes. It combines structured entrypoints (`swap`, `swapAndBridge`, `bridge`) with a generic `performActions` loop for multi-step flows that need returndata splicing.

**Ship target:** [`src/OpenRouter.sol`](src/OpenRouter.sol)

There is no backend signature verification, nonce, or deadline on this contract. ERC-20 fund safety depends on [0x AllowanceHolder](https://github.com/0xProject/0x-settler) transient approvals plus `_msgSender() == input.user` in `_pullFromUser`. See [`OPENROUTER_ASSUMPTIONS.md`](OPENROUTER_ASSUMPTIONS.md) before enabling production routes.

## Documentation

| Doc | Purpose |
|-----|---------|
| [`OPENROUTER.md`](OPENROUTER.md) | Contract API, flags, modular packing, structured vs generic routes |
| [`OPENROUTER_CONTEXT.md`](OPENROUTER_CONTEXT.md) | Integration context, PoCs, backend ABI pointers |
| [`OPENROUTER_ASSUMPTIONS.md`](OPENROUTER_ASSUMPTIONS.md) | Operational and business assumptions for the unchecked router |
| [`AGENTS.md`](AGENTS.md) | Agent/contributor notes (backend encoder paths) |

## Repository layout

```text
src/
  OpenRouter.sol                 # main contract
  common/                        # AllowanceHolder context, libs, access control
  manipulators/                  # optional helpers for fork PoCs (Across, math)
test/
  combined/                      # unit tests (OpenRouterV2Unchecked*.t.sol naming; tests OpenRouter)
  poc/                           # fork PoCs (use FOUNDRY_PROFILE=poc)
scripts/
  deploy/                        # CREATE3 deployment via Hardhat
  e2e/                           # live mainnet e2e scripts (swap, bridge, CCTP, Stargate, OFT, relay)
```

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, cast, anvil)
- Node.js 18+ and npm
- Git submodules: `git submodule update --init --recursive`

## Setup

```bash
npm install
cp .env.example .env   # fill DEPLOYER_PRIVATE_KEY, RPC URLs, API keys as needed
```

## Build and test

```bash
# Compile (Foundry)
forge build

# Unit tests (excludes test/poc/** by default)
forge test

# Fork PoCs (requires RPC env vars; may need pinned block numbers)
FOUNDRY_PROFILE=poc ARBITRUM_RPC=... forge test --match-path test/poc/OpenOceanAcrossOpenRouterPoC.t.sol -vv

# Format
forge fmt
```

Hardhat is wired for deployment and TypeScript e2e scripts:

```bash
npm run compile
npm run deploy -- polygon    # patches ALLOWANCE_HOLDER, then deploys OpenRouter
npm run deploy:openrouter:raw -- polygon
npm run deploy:allowance-holder -- polygon
npm run check:allowance-holder -- --network polygon
npm run slither              # static analysis via Docker
```

## E2E scripts

Live scripts under `scripts/e2e/` submit routes through AllowanceHolder against deployed routers. Shared config lives in [`scripts/e2e/config.ts`](scripts/e2e/config.ts) (chain IDs, token addresses, router addresses per chain).

```bash
PRIVATE_KEY=0x... ts-node scripts/e2e/swap/swap.preFee.balanceOf.ts
```

Override deployed router per chain with `ROUTER_CHAIN_<chainId>` or legacy `ROUTER_ADDRESS`. Override AllowanceHolder per chain with `ALLOWANCE_HOLDER_CHAIN_<chainId>` or globally with `ALLOWANCE_HOLDER_ADDRESS`. Override the holder variant with `ALLOWANCE_HOLDER_VARIANT_CHAIN_<chainId>` or global `ALLOWANCE_HOLDER_VARIANT` (`cancun` or `shanghai`). See `.env.example` for RPC and API key variables.

`deploy:allowance-holder` uses `ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE` on chains with EIP-1153 `TLOAD/TSTORE` and `ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE` on no-TLOAD chains. It deploys through CreateX CREATE3 with salt text `AllowanceHolder50c4e7:5981577`, resolving to `0x50c4E75a512F2A14A7b304787Adf79C4531A5909`; set `ALLOWANCE_HOLDER_CREATE3_SALT` for a raw bytes32 salt. CREATE3 requires the canonical CreateX factory on the target chain. Set `ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH` / `ALLOWANCE_HOLDER_SHANGHAI_INITCODE_HASH` to make the script enforce the exact compiled bytecode before sending a transaction.

Unchanged upstream 0x holder bytecode hard-checks `address(this)` against the 0x holder addresses in its constructor. CREATE3 deployments require our own or patched holder bytecode that permits the CreateX-computed address.

AllowanceHolder deploy/check scripts write records to `deployments/allowance-holder/<chainId>.json` with the resolved address, variant, CREATE3 salt, tx hash, block, and runtime bytecode hash.

OpenRouter deploys should go through `scripts/deploy/deployOpenRouterPatched.ts` (`npm run deploy -- <network>`). That wrapper patches `src/common/interfaces/IAllowanceHolder.sol` to the configured per-chain holder address before Hardhat compiles, sets `OPENROUTER_EVM_VERSION`, and writes `deployments/openrouter-build/<chainId>.json`. Holder address priority is env override, then `deployments/allowance-holder/<chainId>.json`, then static config. Do not use `deploy:openrouter:raw` for chain-specific holder deployments unless the source constant has already been prepared.

For multi-chain deploys, use `npm run deploy:openrouter:batch -- ...` or the Make targets. The batch deployer groups networks by build profile `(EVM version, AllowanceHolder address)`, compiles once per profile, then deploys matching networks in parallel with `--no-compile`. Use `make deploy-openrouter-cancun` to deploy only Cancun profiles.

Detailed runbook: [`ALLOWANCE_HOLDER_DEPLOYMENT.md`](ALLOWANCE_HOLDER_DEPLOYMENT.md).

Modular route packing helpers: [`scripts/e2e/utils/modularActionsBuilder/`](scripts/e2e/utils/modularActionsBuilder/).

## Backend integration

If the Solidity ABI changes, update encoders in:

- `bungee-backend/src/modules/dex/utils.ts` — `swap`, AllowanceHolder `exec`
- `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts` — `bridge`, `swapAndBridge`

Flag masks and deployed addresses must stay in sync with `bungee-backend` config (`dex.config.ts`, `router.config.ts`).

## External entrypoints (summary)

| Function | Purpose |
|----------|---------|
| `swap` | Same-chain pull → optional fee → swap → deliver to `receiver` |
| `swapAndBridge` | Pull → optional fee → swap (output on router) → bridge |
| `bridge` | Direct bridge; amount must be encoded in calldata |
| `performActions` | Generic action loop with returndata splices |
| `rescueFunds` | Owner recovery of stuck tokens |

Users must approve **AllowanceHolder**, not OpenRouter, and call `AllowanceHolder.exec` with the router as target. Details in [`OPENROUTER.md`](OPENROUTER.md).

## Deployed addresses

OpenRouter is deployed at **`0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a`** (CREATE3) on all supported mainnets below. Canonical config: [`scripts/e2e/config.ts`](scripts/e2e/config.ts) (`OPEN_ROUTER_ADDRESS`, `OPEN_ROUTER_CHAIN_IDS`).

| Chain | Chain ID |
|-------|----------|
| Ethereum | 1 |
| Optimism | 10 |
| BNB | 56 |
| Gnosis | 100 |
| Polygon | 137 |
| Unichain | 130 |
| Sonic | 146 |
| Monad | 143 |
| World Chain | 480 |
| Mantle | 5000 |
| Base | 8453 |
| HyperEVM | 999 |
| MegaETH | 4326 |
| Arbitrum | 42161 |
| Linea | 59144 |
| Ink | 57073 |
| Avalanche | 43114 |
| Scroll | 534352 |
| Mode | 34443 |
| Soneium | 1868 |
| Plasma | 9745 |
| Blast | 81457 |
| Berachain | 80094 |
| Sei | 1329 |
| Plume | 98866 |
| Katana | 747474 |

**AllowanceHolder** (users approve this contract, not OpenRouter):

| Address | Chains |
|---------|--------|
| `0x50c4E75a512F2A14A7b304787Adf79C4531A5909` | Socket CREATE3 holder for all configured holder chains |

0x uses two AllowanceHolder variants: a Cancun/EIP-1153 variant that uses transient storage, and a Shanghai/no-TLOAD variant for chains such as Mantle. The Socket holder uses the same CREATE3 address across variants/chains; the chosen variant controls bytecode, not address. If you deploy a new AllowanceHolder address, router bytecode must be compatible with that address. The OpenRouter deploy wrapper patches the hardcoded `ALLOWANCE_HOLDER` constant before compilation; existing OpenRouter deployments cannot be switched to a new holder only by changing frontend/backend config.
