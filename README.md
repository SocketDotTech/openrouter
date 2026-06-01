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
npm run deploy -- polygon    # scripts/deploy/deployOpenRouter.ts
npm run slither              # static analysis via Docker
```

## E2E scripts

Live scripts under `scripts/e2e/` submit routes through AllowanceHolder against deployed routers. Shared config lives in [`scripts/e2e/config.ts`](scripts/e2e/config.ts) (chain IDs, token addresses, router addresses per chain).

```bash
PRIVATE_KEY=0x... ts-node scripts/e2e/swap/swap.preFee.balanceOf.ts
```

Override deployed router per chain with `ROUTER_CHAIN_<chainId>` or legacy `ROUTER_ADDRESS`. See `.env.example` for RPC and API key variables.

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

OpenRouter is deployed at **`0x1Cb8E88afDe521aaA0108F2b788D467C286ABAe7`** (CREATE3) on all supported mainnets below. Canonical config: [`scripts/e2e/config.ts`](scripts/e2e/config.ts) (`OPEN_ROUTER_ADDRESS`, `OPEN_ROUTER_CHAIN_IDS`).

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
| `0x0000000000001fF3684f28c67538d4D072C22734` | Default (0x CREATE2): Ethereum, Polygon, Base, Optimism, Arbitrum, BNB, World Chain, Sonic, Ink, Avalanche, Unichain, Berachain, Scroll, HyperEVM, Plasma, Monad, Linea, Tempo, Blast, Gnosis, Katana, Mode |
| `0x0000000000005E88410CcDFaDe4a5EfaE4b49562` | Mantle |
| `0x105F1403277E737b312214DdE8067E9ffBCf7F12` | Sei, MegaETH, Plume, Soneium (Socket-deployed) |

