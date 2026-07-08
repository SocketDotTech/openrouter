# AllowanceHolder Deployment Runbook

> **Deploying to a new chain?** Start with [`NEW_CHAIN_DEPLOYMENT_RUNBOOK.md`](NEW_CHAIN_DEPLOYMENT_RUNBOOK.md) for the full AllowanceHolder + OpenRouter CREATE3 workflow, dry run, and backend sync.

This repo can deploy Socket-owned AllowanceHolder instances instead of relying
on 0x's deployed addresses.

## Upstream Model

0x-settler splits AllowanceHolder by EVM hardfork support:

- `cancun`: uses EIP-1153 transient storage (`tload` / `tstore`).
- `shanghai`: uses the `AllowanceHolderOld` storage-backed fallback for chains
  without `tload` / `tstore`.

Their deployment script pins Solidity `0.8.25`, optimizer runs `1000000`, and
checks an initcode hash before broadcasting.

References:

- https://github.com/0xProject/0x-settler#allowanceholder-addresses
- https://github.com/0xProject/0x-settler/blob/master/sh/deploy_allowanceholder.sh
- https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolder.sol
- https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderOld.sol

## Variant Selection

Variant resolution lives in `scripts/e2e/config.ts`.

- Default variant: `cancun`.
- Mantle: `shanghai`.
- Override all chains: `ALLOWANCE_HOLDER_VARIANT=cancun|shanghai`.
- Override one chain: `ALLOWANCE_HOLDER_VARIANT_CHAIN_<chainId>=cancun|shanghai`.

If adding a chain, verify opcode support before enabling ERC-20 routes. A chain
without `tload` / `tstore` must use `shanghai` bytecode.

## Address Selection

Runtime/e2e address resolution lives in `scripts/e2e/config.ts`. The deployment
script computes the holder address from CreateX and the configured CREATE3 salt.

- Default: Socket's mined CREATE3 holder address
  `0x50c4E75a512F2A14A7b304787Adf79C4531A5909`.
- Override all chains: `ALLOWANCE_HOLDER_ADDRESS=0x...`.
- Override one chain: `ALLOWANCE_HOLDER_CHAIN_<chainId>=0x...`.

`deploy:allowance-holder` uses CreateX CREATE3 with salt text
`AllowanceHolder50c4e7:5981577`, which hashes to
`0xa450483209637d11f92238066a6b1f405ae093536f02dda3b90a36d36f180570`
and resolves to `0x50c4E75a512F2A14A7b304787Adf79C4531A5909`:

```bash
export ALLOWANCE_HOLDER_CREATE3_SALT_TEXT=AllowanceHolder50c4e7:5981577
```

The raw bytes32 salt can be supplied instead:

```bash
export ALLOWANCE_HOLDER_CREATE3_SALT=0x...
```

When `ALLOWANCE_HOLDER_ADDRESS` or `ALLOWANCE_HOLDER_CHAIN_<chainId>` is set,
the script verifies that it equals the CreateX-computed address before
broadcasting.

CREATE3 deployment requires the canonical CreateX factory
`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` to exist on the target chain.
For a fixed factory and salt, Cancun and Shanghai holder variants resolve to
the same address on their respective chains even though their deployment
bytecode differs.

Important: unchanged upstream 0x holder bytecode checks `address(this)` in its
constructor against the 0x holder addresses. CREATE3 is intended for our own or
patched holder bytecode whose constructor permits the CreateX-computed address.

## Required Bytecode Inputs

Provide the deployment bytecode for each variant you intend to deploy:

```bash
export ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE=0x...
export ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE=0x...
```

Set expected initcode hashes to enforce reproducible builds before broadcasting:

```bash
export ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH=0x...
export ALLOWANCE_HOLDER_SHANGHAI_INITCODE_HASH=0x...
```

## CREATE3 Salt Reference

Salt constants live in `scripts/deploy/create3.ts`.

| Contract | Salt text | Raw bytes32 salt | CREATE3 address |
|----------|-----------|------------------|-----------------|
| OpenRouter | `OpenRouter50cfe7:4030514` | `0x4c57cf418d2865efb93a3c31021f230798eaca0458d188fbb593e329718139ab` | `0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a` |
| AllowanceHolder | `AllowanceHolder50c4e7:5981577` | `0xa450483209637d11f92238066a6b1f405ae093536f02dda3b90a36d36f180570` | `0x50c4E75a512F2A14A7b304787Adf79C4531A5909` |

## Current Cancun Deployment

The Cancun AllowanceHolder was deployed with CREATE3 on all configured Cancun
holder chains on 2026-06-09 UTC.

- Address: `0x50c4E75a512F2A14A7b304787Adf79C4531A5909`
- Salt text: `AllowanceHolder50c4e7:5981577`
- Raw salt:
  `0xa450483209637d11f92238066a6b1f405ae093536f02dda3b90a36d36f180570`
- Cancun initcode hash:
  `0xe0afa70daed24ec949499638683365cbe4cbf097a1c8417a730e4b497cfb4610`
- Runtime bytecode hash:
  `0x0be5794255d21df0f4a10a516428f8d06805779d69b1714297bebcc18971e0b4`
- Deployer: `0xB0BBff6311B7F245761A7846d3Ce7B1b100C1836`

`deployments.csv` contains the current per-chain AllowanceHolder address,
variant, CREATE3 salt, initcode hash when known, and runtime bytecode hash for:

```text
ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche
unichain berachain scroll hyperEvm plasma monad linea gnosis katana mode
megaeth robinhood plume blast soneium sei tempo
```

The Cancun OpenRouter was deployed with CREATE3 on all configured OpenRouter
Cancun chains on 2026-06-09 UTC.

- Address: `0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a`
- Salt text: `OpenRouter50cfe7:4030514`
- Raw salt:
  `0x4c57cf418d2865efb93a3c31021f230798eaca0458d188fbb593e329718139ab`
- Cancun initcode hash:
  `0x0e5ff42eb7810767de756c833a042818f95052b885634a3dc3adb679a4652f48`
- Runtime bytecode hash:
  `0xd1dbc2c8ca87939cadf58e4eb91832cbe44bd5d12e3a0a0d56c76928a818e26b`
- Deployer: `0xB0BBff6311B7F245761A7846d3Ce7B1b100C1836`

`deployments.csv` also contains the current per-chain OpenRouter address,
CREATE3 salt, initcode hash when known, and runtime bytecode hash for:

```text
ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche
unichain berachain scroll hyperEvm plasma monad linea gnosis katana mode
megaeth robinhood plume blast soneium sei
```

## Commands

Verify deployed AllowanceHolder instances:

```bash
ETHERSCAN_API_KEY=... npm run verify:allowance-holder
ETHERSCAN_API_KEY=... npm run verify:allowance-holder -- polygon base arbitrum
```

The verification source lives under `verification/allowance-holder/`. It is the
0x-settler Cancun AllowanceHolder with the constructor address guard patched to
Socket's CREATE3 address. The compiled bytecode body matches the deployed
initcode recovered from the CreateX deployment transaction. Some explorers
record this as a similar/partial match because the original deployment metadata
hash is not reproduced exactly.

Plume's legacy Etherscan-compatible API blocks source verification POSTs from
this environment, and Tempo does not expose an Etherscan-compatible verification
API. The batch verifier submits those two to Sourcify instead.

Deploy OpenRouter for one chain after patching the router-side
`ALLOWANCE_HOLDER` constant:

```bash
npm run deploy -- polygon
```

The wrapper upserts the chain row in `deployments.csv`, sets
`OPENROUTER_EVM_VERSION`, then invokes `scripts/deploy/deployOpenRouter.ts`.
It resolves the holder address in this priority order:

1. `ALLOWANCE_HOLDER_CHAIN_<chainId>` / `ALLOWANCE_HOLDER_ADDRESS`
2. `deployments.csv`
3. static defaults in `scripts/e2e/config.ts`

The raw OpenRouter deployment script does not patch source and should only be
used when the source constant has already been prepared:

```bash
npm run deploy:openrouter:raw -- polygon
```

Deploy selected networks in parallel by build profile:

```bash
npm run deploy:openrouter:batch -- --variant cancun
npm run deploy:openrouter:batch -- polygon base arbitrum
make deploy-openrouter-cancun
```

The batch deployer groups by `(EVM version, AllowanceHolder address)`, not only
by hardfork variant. For example, Cancun chains that use the default holder and
Cancun chains that use a Socket-owned holder are separate profiles: each profile
is patched and compiled once, then its networks deploy in parallel with
`--no-compile`.

Deploy one chain:

```bash
npm run deploy:allowance-holder -- polygon
```

Check one chain:

```bash
npm run check:allowance-holder -- --network polygon
```

Deploy all configured holder chains:

```bash
make deploy-allowance-holder
```

Check all configured holder chains:

```bash
make check-allowance-holder
```

## Tracking

Deploy/check scripts upsert rows in:

```text
deployments.csv
```

Each row records one variant per chain plus AllowanceHolder and OpenRouter
address, salt, salt text, initcode hash, and runtime bytecode hash. Missing
values are left as empty CSV cells.

Writers use a `deployments.csv.lock` directory plus atomic temp-file rename so
parallel deployment processes do not overwrite each other.

Keep `deployments.csv`, `scripts/e2e/config.ts`, backend config, and router bytecode
in sync. Existing OpenRouter bytecode calls the compile-time
`ALLOWANCE_HOLDER` constant, so changing only frontend/backend config is not
enough to switch an already deployed router to a new holder address.

## Shanghai / No-Cancun Chains

The holder deploy flow is hardfork-aware, but OpenRouter currently contains
`mcopy` in `src/OpenRouter.sol` and `src/common/lib/BytesSpliceLib.sol`.
`mcopy` is a Cancun opcode. The patched OpenRouter deploy wrapper refuses
Shanghai/no-Cancun builds until those copies are replaced with a
Shanghai-compatible implementation.
