# OpenRouter Execution Builder

Dependency-free helper for formatting `DummyRouter.execute(Action[])` payloads from provider SDK/API calldata.

```js
const { OpenRouterExecution } = require("./openRouterExecutionBuilder");

const exec = new OpenRouterExecution({
  routeId: "openocean-stargate-native",
  chainId: 42161,
});

exec.call(USDC, approveCalldata).as("approve");
exec.call(OPENOCEAN_EXCHANGE_V2, openOceanSwapCalldata).as("swap");

exec
  .staticCall(MATH_MANIPULATOR, percentCalldataWithZeroAmount)
  .as("routeFee")
  .spliceArg(0, exec.ref("swap").returnWord());

exec
  .nativeCall(FEE_RECIPIENT)
  .as("feeTransfer")
  .valueFrom(exec.ref("routeFee").returnWord());

const calldata = exec.toDummyRouterCalldata();
```

`toActions()` returns the current gas-golfed `DummyRouter.Action[]` ABI shape:

```js
[
  {
    actionInfo, // packed callType | storeResult << 8 | target << 16
    data,
    splices, // uint256[] packed as sourceActionIndex | srcOffset << 64 | dstOffset << 128 | length << 192
  },
];
```

Splice sources are marked as `storeResult` automatically. For an action whose returndata should be returned but is not used by a splice, call `.storeResult()` on the handle or pass `storeResult: true` to `action(...)`.

## Offset Helpers

- `spliceArg(argIndex, source)` writes a 32-byte source into a normal ABI calldata argument. It maps `argIndex` to `4 + argIndex * 32`.
- `valueFrom(source)` writes a 32-byte source into the leading value word used by `CALL_WITH_NATIVE`.
- `splicePayloadWord(payloadOffset, source)` writes into the payload of a `CALL_WITH_NATIVE`. It automatically adds the 32-byte value prefix.
- `splicePayload(payloadOffset, source, length)` does the same for non-word slices.
- `patchWord(dstOffset, source)` writes directly to an absolute calldata offset.

## Across Shape

```js
exec.call(ARBITRUM_USDC, approveOpenOcean).as("approve");
exec.call(OPENOCEAN_EXCHANGE_V2, openOceanSwapCalldata).as("swap");

exec
  .staticCall(ACROSS_AMOUNT_MANIPULATOR, deriveOutputAmountWithZeroInput)
  .as("acrossOutputAmount")
  .spliceArg(0, exec.ref("swap").returnWord());

exec.call(ARBITRUM_WETH, approveAcross).as("approveAcross");

exec
  .call(ACROSS_SPOKE_POOL, acrossDepositWithZeroAmounts)
  .as("acrossDeposit")
  .patchWord(132, exec.ref("swap").returnWord())
  .patchWord(164, exec.ref("acrossOutputAmount").returnWord());
```

## Stargate Native Shape

```js
exec.call(ARBITRUM_USDC, approveOpenOcean).as("approve");
exec.call(OPENOCEAN_EXCHANGE_V2, openOceanSwapCalldata).as("swap");

exec
  .staticCall(MATH_MANIPULATOR, percentCalldataWithZeroAmount)
  .as("routeFee")
  .spliceArg(0, exec.ref("swap").returnWord());

exec.nativeCall(FEE_RECIPIENT).as("feeTransfer").valueFrom(exec.ref("routeFee").returnWord());

exec
  .staticCall(MATH_MANIPULATOR, subtractWithZeroArgs)
  .as("postFeeAmount")
  .spliceArg(0, exec.ref("swap").returnWord())
  .spliceArg(1, exec.ref("routeFee").returnWord());

exec
  .staticCall(MATH_MANIPULATOR, subtractNativeFeeFromZeroAmount)
  .as("bridgeAmount")
  .spliceArg(0, exec.ref("postFeeAmount").returnWord());

exec
  .nativeCall(STARGATE_NATIVE_WRAPPER, stargateSendCalldata)
  .as("stargate")
  .valueFrom(exec.ref("postFeeAmount").returnWord())
  .splicePayloadWord(STARGATE_AMOUNT_OFFSET, exec.ref("bridgeAmount").returnWord());
```

Use `toActions()` when the caller already has an ABI encoder for the current packed `DummyRouter`. Use `toLogicalActions()` for the readable builder shape. Use `toDummyRouterCalldata()` when you need raw calldata for the current `DummyRouter`.
