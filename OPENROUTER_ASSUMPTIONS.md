# OpenRouter Assumptions

Last reviewed: 2026-05-19.

Scope: `src/combined/OpenRouterV2Unchecked.sol`.

This document captures the assumptions that make the unchecked OpenRouter safe to operate. Many of these are business and integration assumptions, not guarantees enforced by the contract.

## Source Of Truth

`OpenRouterV2Unchecked` intentionally removes backend signature verification, nonces, and deadlines. Public entrypoints can be called by anyone.

Current checked-in public surface:

- `swap(...)`
- `swapAndBridge(...)`
- `bridge(...)`
- `performActions()(...)`
- `rescueFunds(...)`

`OPENROUTER_CONTEXT.md` and `scripts/e2e/utils/routerAbi.ts` may mention `performExecution(...)`; verify against the Solidity file before relying on that ABI.

## Enforcement Classes

Use this distinction when reviewing any route or integration:

- On-chain enforced: checked directly by the router.
- Operationally enforced: must be true because frontend, backend, deploy config, or runbooks enforce it.
- Policy assumption: not enforced by code. If it becomes false, the unchecked router can become unsafe.

## Critical Business Assumptions

### Router Never Holds Durable Funds

The router may temporarily hold funds during one transaction, but it should not end routes with meaningful token or native balances.

Failure mode: `performActions()` lets any caller make the router call arbitrary contracts. If the router holds ERC20s, native ETH, bridged refunds, swap dust, rebates, or protocol refunds, a public caller can move or approve those assets through modular actions before owner rescue.

Operational requirements:

- Do not use the router as a treasury, escrow, settlement account, refund address, or fee vault.
- Route calldata should send final assets to the user, bridge, or fee recipient in the same transaction.
- Monitor router token/native balances and treat non-zero balances as an incident or stuck-funds condition.
- Owner rescue is an operational recovery tool, not a security boundary.

### Users Never Directly Approve The Router

Users must not give persistent ERC20, Permit2, ERC721, ERC1155, or protocol-specific approvals directly to the router.

Failure mode: if a user directly approves the router, any caller can use `performActions()` to make the router call `transferFrom`, `approve`, or equivalent privileged token functions against that user allowance.

Operational requirements:

- User ERC20 approvals should go to 0x AllowanceHolder, not OpenRouter.
- UI copy and wallet flows must never ask users to approve OpenRouter directly.
- Monitoring should flag direct allowances from users to the router.
- If a direct approval is discovered, revoke it before treating that user as safe.

### Router Has No Privileged Role On Other Contracts

No external contract should treat OpenRouter as a privileged actor unless every public caller is allowed to exercise that privilege.

Failure mode: if another contract has `onlyRouter`, allowlists the router, grants it minter/burner/pauser/admin/operator/bridge-agent permissions, or keys permissions off `msg.sender == router`, any caller can exercise that role through modular execution.

Operational requirements:

- Do not grant OpenRouter roles in bridges, vaults, tokens, staking systems, receivers, relayers, or settlement contracts.
- Do not whitelist OpenRouter in downstream contracts as a trusted caller unless the called operation is safe for arbitrary public callers.
- Review new integrations for hidden trust checks against `msg.sender`.

### Router Is Not A User-Intent Authority

The unchecked router does not prove that a route reflects user intent. It only executes calldata.

Failure mode: a malicious UI or compromised backend can make the user call `AllowanceHolder.exec` with calldata that pays an attacker, charges an arbitrary fee, bridges to a wrong recipient, or approves a malicious spender.

Operational requirements:

- The frontend/backend must validate recipients, fee receivers, fee amounts, swap targets, bridge targets, approval spenders, destination chain/domain, bridge min amounts, and refund addresses before presenting a transaction.
- Wallet simulation and transaction review should show the actual route effects where possible.
- `requestHash` is only an event correlation id. It does not enforce uniqueness, replay protection, or user consent.

## Fund Pull Assumptions

### ERC20 Inputs Use AllowanceHolder

ERC20 input safety depends on 0x AllowanceHolder transient allowance scoping plus `_msgSender() == input.user`.

On-chain enforced:

- `_pullFromUser` reverts unless `_msgSender() == input.user` for ERC20 inputs.
- When called through AllowanceHolder, `_msgSender()` is decoded from the appended user address.

Operational assumptions:

- The user calls `AllowanceHolder.exec(operator, token, amount, target, data)`.
- `operator` is the router.
- `target` is the router.
- `token` and `amount` match the route input.
- The user has a persistent approval to AllowanceHolder, not to the router.

Failure modes:

- Direct ERC20 calls to the router fail because `_msgSender()` is not the user.
- Bad AH calldata can still execute a bad route if the user submits it.
- AH protects fund pulling for the route input, but it does not validate swap/bridge semantics.

### Native Inputs Are Not User-Bound

Native-token input routes only check that `msg.value >= inputAmount`.

Failure mode: `input.user` is not authenticated for native routes. Anyone can submit native routes if they provide the ETH. This is usually acceptable because the caller funds the transaction, but downstream analytics must not treat `input.user` as authenticated identity for native paths.

Operational requirements:

- Native route attribution should come from transaction signer / AH sender / product context, not only `input.user`.
- Excess `msg.value` is not automatically refunded by the router.

## Execution Assumptions

### External Targets Are Trusted Per Route

The router does not whitelist swap targets, bridge targets, approval spenders, manipulators, receivers, or fee recipients.

Failure modes:

- Malicious swap target can consume approved input and return misleading returndata.
- Malicious bridge target can consume approved output or native value.
- Malicious approval spender can use allowance after the route if allowance remains and the router later receives the same token.
- Malicious fee receiver can reject native fee transfers and revert the route.

Operational requirements:

- Backend/frontend must maintain target and spender allowlists or equivalent route validation.
- Approval spender should be the minimum necessary protocol spender.
- Prefer route patterns that leave no router balance and no meaningful residual allowance.

### Swap Output Measurement Matches The Aggregator

The router supports two output modes:

- Returndata mode: decode a 32-byte word at `swapData.returnDataWordOffset`.
- Balance-delta mode: measure `balanceOf(outputReceiver)` before and after the swap.

Failure modes:

- Returndata mode is unsafe if the target return word is not the actual output amount.
- Balance-delta mode is unsafe if unrelated balance changes occur during the call, or if the token has rebasing/fee-on-transfer behavior that breaks expected deltas.
- In standalone pre-fee/no-fee swaps, the swap calldata must send output directly to `receiver`; the router will not forward output afterward.
- In standalone post-fee swaps and all `swapAndBridge` paths, the swap output must land on the router.

Operational requirements:

- Choose output mode per aggregator and route.
- Verify `returnDataWordOffset` against the concrete swap target ABI.
- Verify output recipient encoded in `swapCallData` matches the router mode.
- Treat `minOutput` as gross swap output, not guaranteed net-to-user output after post-fee or bridge fees.

### Fee Semantics Are Caller-Defined

The router does not enforce fee policy.

Assumptions:

- Pre-fee amounts are denominated in the input token.
- Post-fee amounts are denominated in the output token.
- `fee.receiver` is trusted and product-approved.
- `fee.amount` is within product policy.

Failure modes:

- A malicious caller can set an arbitrary fee receiver and amount if the user submits the calldata.
- Post-fee is applied after gross `minOutput` validation, so net user proceeds can be lower than `minOutput`.

### Bridge Calldata Is Semantically Correct

The router does not understand bridge-specific fields.

Assumptions:

- Destination chain/domain is correct.
- Recipient is correct.
- Refund address is not the router unless intentionally safe.
- Bridge min amount / slippage fields are correct.
- Bridge fee quote and native fee buffer are current enough.
- Token and amount fields in calldata match the route.

Failure modes:

- `bridge()` performs no runtime amount splicing; the amount must already be encoded.
- `swapAndBridge()` can splice one 32-byte amount word only.
- The bridge-value flag forwards `finalAmount + bridgeData.value` as native value. It must only be used when the bridge expects the bridged asset itself as native value plus a static fee.
- Excess native fee behavior depends on the bridge target and refund address, not OpenRouter.

## Modular Execution Assumptions

`performActions()` is the broadest surface. It makes the router a public generic call executor.

Assumptions:

- The router has no durable funds.
- No user has directly approved the router.
- No external contract gives the router privileged rights.
- Each action target is safe for the router to call.
- Splice offsets and lengths are generated by trusted tooling.
- Actions that are splice sources store their returndata.

Failure modes:

- Any public caller can transfer, approve, or spend assets already held by the router.
- Any public caller can exercise downstream privileges granted to the router.
- `CALL_WITH_NATIVE` can spend native ETH already sitting in the router.
- Invalid `callType` values fall through to normal `CALL`; encoders must emit only known call types.
- Splices are bounds-checked but not semantically validated. A bad splice can write a valid but wrong bridge amount, recipient field, fee field, or payload word.

## Token Assumptions

Assumptions:

- ERC20s follow sane `transfer`, `transferFrom`, `approve`, and `balanceOf` behavior.
- The native token sentinel is exactly `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
- Tokens do not rebase or charge transfer fees in ways that invalidate route amounts, unless route tooling explicitly accounts for that.
- Approval reset/retry behavior in Solady `safeApproveWithRetry` is acceptable for the token.

Failure modes:

- Fee-on-transfer tokens can cause bridge approvals or calldata amounts to exceed actual received balances.
- Rebasing tokens can corrupt balance-delta output measurement.
- Non-standard tokens can revert, return false, or have allowance quirks.

## Operational Checklist

Before enabling a route or integration, confirm:

- Users approve AllowanceHolder only.
- The router has no direct user allowances.
- The router has no privileged roles on any touched contract.
- The router is not used as recipient, refund address, treasury, or settlement vault unless public draining is acceptable.
- Swap target, bridge target, approval spenders, manipulators, fee receiver, and receiver are validated.
- Swap output mode and `returnDataWordOffset` are correct for the aggregator.
- Standalone swap recipient is correct for pre-fee/no-fee versus post-fee mode.
- Bridge calldata encodes the correct recipient, destination, min amount, refund address, and fees.
- Bridge amount splice offset is correct for the exact calldata shape.
- Native `msg.value` covers input amount plus all downstream native call values.
- Excess native value and bridge refunds do not end up on the router.
- Monitoring exists for router balances, direct allowances to router, and unexpected downstream roles.

If any critical business assumption is false, do not rely on `OpenRouterV2Unchecked` as-is. Add access control, use a signed variant, or remove the downstream privilege/funds/allowance that makes the public call surface dangerous.
