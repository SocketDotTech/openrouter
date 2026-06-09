# AllowanceHolder Deployment Runbook

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

## Commands

Deploy OpenRouter for one chain after patching the router-side
`ALLOWANCE_HOLDER` constant:

```bash
npm run deploy -- polygon
```

The wrapper writes `deployments/openrouter-build/<chainId>.json`, sets
`OPENROUTER_EVM_VERSION`, then invokes `scripts/deploy/deployOpenRouter.ts`.
It resolves the holder address in this priority order:

1. `ALLOWANCE_HOLDER_CHAIN_<chainId>` / `ALLOWANCE_HOLDER_ADDRESS`
2. `deployments/allowance-holder/<chainId>.json`
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

Deploy/check scripts write manifests to:

```text
deployments/allowance-holder/<chainId>.json
```

Each manifest records the resolved holder address, variant, CREATE3 salt,
runtime bytecode hash, and deployment tx metadata when available.

OpenRouter build manifests are written to:

```text
deployments/openrouter-build/<chainId>.json
```

Each OpenRouter build manifest records the network, chain ID, patched
AllowanceHolder address, holder variant, and EVM version used for compilation.

Keep the manifest, `scripts/e2e/config.ts`, backend config, and router bytecode
in sync. Existing OpenRouter bytecode calls the compile-time
`ALLOWANCE_HOLDER` constant, so changing only frontend/backend config is not
enough to switch an already deployed router to a new holder address.

## Shanghai / No-Cancun Chains

The holder deploy flow is hardfork-aware, but OpenRouter currently contains
`mcopy` in `src/OpenRouter.sol` and `src/common/lib/BytesSpliceLib.sol`.
`mcopy` is a Cancun opcode. The patched OpenRouter deploy wrapper refuses
Shanghai/no-Cancun builds until those copies are replaced with a
Shanghai-compatible implementation.
