# InstantPayouts security review

## Current source changes

The current source adds owner-only native rescue, a payable receive function and a mutable payout signer. Customer payments remain Base native USDC. The EIP-712 domain stays `DTF Instant Payouts`, version `1`; the signed fields remain `payoutId`, `recipient`, `amount` and `deadline`.

- `setPayoutSigner` rejects the zero address and emits the previous and new signer. It does not clear paid IDs.
- There is no epoch or authorization cancellation counter. Old signatures fail while another signer is active. Selecting an old signer again restores its unused, unexpired authorizations. The regression test covers this exact behavior.
- `rescueNative` is owner-only, rejects a zero receiver, checks the native transfer result and emits a receipt only after success. Native rescue does not consume payout IDs. A rejecting receiver or insufficient balance reverts the rescue.
- ERC-20 rescue remains the approved exception to payout-ID protection. The owner can transfer USDC outside the customer payout path. Native rescue is also an owner recovery operation. Manual customer payments must use `payout`.
- Each nonzero payout ID can pay once per deployment. Signed recipient, amount and inclusive deadline cannot be changed by a relayer. Chain and contract are part of the EIP-712 domain. The ID is set before USDC transfer; failed transfer reverts it.
- The backend must assign one permanent ID per claim, preserve the ID and saved contract on every retry, and reconcile receipts before retry or cutover. The contract cannot identify duplicate business claims with distinct IDs. A new deployment starts with an empty ID map.
- Treasury manually prefunds the contract with Base native USDC and pays relayer gas. Insufficient USDC waits for funding. There is no automatic Lighter withdrawal, bridge or replenishment in this scope.

The focused local suite now includes native deposits/rescue, rescue access and transfer failure, signer-change access, new signer payment, preserved paid IDs and A-to-B-to-A signature restoration. Existing tests cover signed-field changes, replay, expiry, malformed/high-s signatures, failed-transfer retry, ownership and token reentry. Tests use local mocks; they do not exercise live USDC, KMS, RPC, treasury funding or backend activation. On November 4, all 29 local Solidity tests passed, including 512 generated fuzz cases. Formatting, offline compilation and offline TypeScript script checks passed. This custom contract has no independent audit.

## Prior deployment evidence

The November 3 review covered the previous immutable-signer source with 23 passing local tests and 512 generated fuzz cases. All 22 vendored OpenZeppelin Contracts v5.6.1 files matched their manifest hashes. These results and component audit references do not qualify the changed source or its backend integration.

Prior reviewed contract SHA-256:

```text
5a48e782bf11d40f648ebb13d3ec3cbe9b7304e43e42efc4f3cc6803a6f31054
```

That prior source was deployed on Base at [`0xA734D3837f0eb87Bca3cDF7C3dfE70422F2877Dd`](https://basescan.org/address/0xA734D3837f0eb87Bca3cDF7C3dfE70422F2877Dd#code). Its public [deployment record](deployments/base.json) retains the source, transaction, runtime and verification evidence. It has no native rescue or signer rotation. The record is unchanged. The changed source was deployed on November 4 at [`0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8`](https://basescan.org/address/0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8). The [new public record](deployments/base-2026-11-04.json) retains the matched source, runtime and constructor checks. Sourcify confirmed exact creation and runtime matches. The mined receipt does not assert finality. No customer payout or treasury funding transfer was part of qualification; backend activation remains separate.
