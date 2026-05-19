# OpenRouter Contract Context

Last researched: 2026-05-18.

Main ship target:

- `src/combined/BungeeOpenRouterV2Unchecked.sol`

Use `src/combined/BungeeOpenRouterV2.sol` as the signed sibling/reference, but the backend branch researched here targets the unchecked ABI.

## V2Unchecked Surface

`BungeeOpenRouterV2Unchecked` removes backend signature verification, nonce, and deadline fields. Fund safety for ERC20 inputs depends on 0x AllowanceHolder transient approvals plus `_msgSender() == input.user` in `_pullFromUser`.

External entrypoints:

- `performExecution(bytes32 requestHash, MonolithicExecution exec, bytes swapCallData, bytes bridgeCallData)`
  - Pulls via AllowanceHolder.
  - Optional pre-fee, optional swap, optional post-fee.
  - Bridges with optional single amount-word splice controlled by flags.
  - Bit 0 fee flag is ignored here; fee placement comes from `preFee` and `postFee`.
- `swap(bytes32 requestHash, InputData input, address receiver, uint256 flags, FeeData fee, SwapData swapData, bytes swapCallData)`
  - Same-chain DEX path.
  - Pre-fee/no-fee swaps can send output directly to `receiver`.
  - Post-fee swaps send output to the router, then the router skims fee and forwards net.
- `swapAndBridge(bytes32 requestHash, InputData input, uint256 flags, FeeData fee, SwapData swapData, bytes swapCallData, BridgeData bridgeData, bytes bridgeCallData)`
  - Swap output always lands on the router so it can be bridged.
  - Supports runtime bridge amount splice and native bridge-value mode via flags.
- `bridge(bytes32 requestHash, InputData input, FeeData fee, BridgeData bridgeData, bytes bridgeCallData)`
  - Direct bridge, no swap.
  - No runtime splice; bridge amount must already be encoded in `bridgeCallData`.
- `performModularExecution(bytes32 requestHash, Action[] actions)`
  - Generic action loop with packed action metadata and packed splices.

## Flags

Flag constants in `BungeeOpenRouterV2Unchecked.sol`:

- `0x01` - post-swap fee for `swap` and `swapAndBridge`; clear means pre-fee from input. Ignored by `performExecution`.
- `0x02` - measure swap output by `balanceOf` delta; clear means decode return word at `SwapData.returnDataWordOffset`.
- `0x04` - bridge `msg.value = finalAmount + BridgeData.value`; used for native bridge assets.
- `0x08` - splice `finalAmount` into `bridgeCallData`.
- Bits `16..31` - byte offset for the bridge amount splice when `0x08` is set.

Backend constants live in both:

- `bungee-backend/src/modules/dex/dex.config.ts`
- `bungee-backend/src/modules/router/router.config.ts`

Keep those masks and deployed addresses in sync with this contract.

## Modular Packing

`Action.actionInfo` is packed as:

```text
uint8(callType) | (storeResult ? 1 << 8 : 0) | (uint160(target) << 16)
```

`Action.splices[]` entries are packed as:

```text
sourceActionIndex | (srcOffset << 64) | (dstOffset << 128) | (length << 192)
```

`CallType.CALL_WITH_NATIVE` treats the first 32 bytes of `action.data` as the call value and the remaining bytes as calldata. PoCs use this for native fee transfers and Stargate native sends.

## Current PoCs

- `test/poc/OpenOceanAcrossOpenRouterPoC.t.sol`
  - Modular OpenOcean USDC -> WETH swap.
  - `AcrossERC20AmountManipulator` derives the Across output amount.
  - Splices swap output and derived output into `SpokePool.deposit`.
- `test/poc/OpenOceanStargateNativeOpenRouterPoC.t.sol`
  - Modular OpenOcean USDC -> native ETH.
  - `MathManipulator` derives fee, post-fee amount, and bridge amount.
  - Uses `CALL_WITH_NATIVE` and splices Stargate `amountLD`.
- `test/poc/OneInchCctpOpenRouterPoC.t.sol`
  - CCTP-oriented PoC.

Fork tests need RPC env vars and sometimes block pins. Example:

```bash
ARBITRUM_RPC=... ARBITRUM_FORK_BLOCK=461716058 forge test --match-path test/poc/OpenOceanAcrossOpenRouterPoC.t.sol -vv
```

## Backend ABI Expectations

The backend encodes the unchecked ABI in:

- `bungee-backend/src/modules/dex/utils.ts`
  - `swap(...)`
  - `AllowanceHolder.exec(...)`
- `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts`
  - `bridge(...)`
  - `swapAndBridge(...)`
  - `AllowanceHolder.exec(...)`

If the Solidity ABI changes, update those hard-coded ABI strings first. Direct DEX and direct bridge quote builders depend on them.

## Gotchas

- ERC20 inputs must be submitted through 0x AllowanceHolder, not directly to the router, or `_msgSender() == user` fails.
- Native input paths send ETH with the outer `AllowanceHolder.exec` call; no ERC20 pull happens.
- `bridge()` cannot splice runtime amounts. Use `swapAndBridge()` when bridge calldata needs the live swap output.
- `swapAndBridge()` uses balance-delta output measurement in backend builders today.
- `performExecution` and `swapAndBridge` share helpers but have different fee semantics.
- Production use of `BungeeOpenRouterV2Unchecked` needs an operational access-control decision; the contract itself has no signature or nonce checks.
