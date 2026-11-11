# Instant payouts on Base

`InstantPayouts` holds native Base USDC and pays one trader share per permanent payout ID. It is a separate contract. It does not use OpenRouter, grant OpenRouter a role, or approve OpenRouter to spend funds.

## Contract rules

- Network: Base mainnet, chain ID `8453`.
- Customer payout token: native USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Amounts use integer USDC units with six decimal places. For example, 80 USDC is `80000000`.
- Initial owner: `0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53`.
- The constructor takes `initialOwner` and the current payout KMS key's public EVM address. The KMS key stays in KMS. The owner can change the payout signer with `setPayoutSigner(address)`; the address must be nonzero.
- Anyone can relay a signed payout. A relayer cannot change the receiver, amount, ID, or deadline. Treasury pays the relayer's Base ETH gas cost.
- Manual and automatic customer payments must use `payout`. Each ID can succeed once across all receivers and amounts. A failed transfer reverts the ID update and can be retried.
- There are no application amount caps, fees, approval reviews, or fixed payment delays in this contract. It must hold enough USDC to pay the full signed amount.
- The owner can nominate a new owner with `transferOwnership`; the nominee must call `acceptOwnership`. The old owner keeps control until acceptance. OpenZeppelin's inherited `renounceOwnership` permanently removes owner access if used.
- The owner can call `rescueToken` for **any ERC-20 token, to any nonzero address**, without a KMS signature. Rescue does not consume a payout ID. This is the explicit exception to customer duplicate-payment protection. Rescue can also transfer USDC to a trader again. It must not serve as the normal manual-payout path.

The owner can recover native ETH with `rescueNative(recipient, amount)`. The receiver must be nonzero, the transfer must succeed, and the contract emits `NativeRescued`. A payable `receive` function accepts native transfers. Native rescue does not consume a payout ID. Keep transaction gas ETH in the relayer account.

Signer rotation changes only the accepted public address. It has no epoch or cancellation counter. Old signatures fail while another signer is selected. Selecting an old signer again restores its unused, unexpired authorizations. Paid IDs remain used across every signer change. `PayoutSignerChanged(previousSigner, newSigner)` records each change. The EIP-712 fields, domain name and version stay unchanged.

The contract has no upgrade path, generic external calls, or token approvals. Treasury manually sends native Base USDC to the deployed contract before payment. The backend must wait when the contract balance is insufficient. Automatic Lighter withdrawals, bridging and treasury replenishment are outside this implementation.

## Authorization

Sign this EIP-712 domain:

```json
{
  "name": "DTF Instant Payouts",
  "version": "1",
  "chainId": 8453,
  "verifyingContract": "<deployed InstantPayouts address>"
}
```

The typed message is:

```solidity
Payout(bytes32 payoutId,address recipient,uint256 amount,uint256 deadline)
```

`deadline` is an inclusive Unix timestamp. `payoutId`, `recipient`, and `amount` must be nonzero. A customer payout receiver must also differ from this custody contract and the USDC token contract. These receiver checks do not restrict owner rescue. `payoutId` must come from the saved business payout record and must stay the same for every retry, replacement, and manual or automatic attempt. Do not derive it from the receiver, amount, transaction hash, or signature.

Use the EIP-712 digest directly with the KMS `ECDSA_SHA_256` signing operation in `DIGEST` mode. Do not hash it again or add an Ethereum personal-message prefix. Convert the returned ASN.1 DER signature into 65-byte `r || s || v` form, normalize `s` to the lower half of the secp256k1 order, and set `v` to `27` or `28` after recovering the configured KMS public address. OpenZeppelin rejects high-`s` signatures.

The transaction calls:

```solidity
payout(payoutId, recipient, amount, deadline, signature)
```

A successful call emits `Paid(payoutId, recipient, amount)`. Use this event and the confirmed receipt to reconcile the saved payout. A timeout alone does not prove failure. Read `used(payoutId)` and inspect the receipt before retrying. A second call for a used ID reverts, even with a fresh valid signature and changed receiver or amount.

The contract cannot detect two distinct IDs assigned to one profit claim. The backend must keep a unique relationship between each profit claim and payout record. Moving to another contract also needs reconciliation of prior payments; a new deployment starts with an empty ID map.

## Build and test

Run commands from this directory. Its own `foundry.toml` selects this project. Do not run these commands from the repository root or add a `.env` file here. Foundry v1.2.3 loads dotenv only from its current directory and selected project root; this separate project prevents it from loading a parent repository `.env`.

```sh
set -eu
test ! -e .env
forge test --offline
forge fmt --check src test
forge build --offline
```

The build pins Solidity `0.8.30`, EVM `cancun`, optimizer enabled with 200 runs, and IPFS metadata. Install that compiler before the offline checks. If it is installed at another path, use `forge test --offline --use /absolute/path/to/solc-0.8.30`. Do not use a different compiler version for deployment.

The offline suite has 29 tests, including 512 generated cases across two fuzz tests. Tests use local mocks at the fixed USDC address; they do not access RPC, real USDC, KMS, or production accounts. They cover global duplicate IDs, signed-field changes, chain and contract replay, expiry, invalid and high-`s` signatures, failed-transfer rollback, invalid custody/token receivers, manual/automatic ordering, unrestricted owner rescue, unauthorized rescue, two-step ownership, copied-signature relay attempts, token reentry, native rescue and plain signer rotation. They also demonstrate that two valid authorizations with distinct IDs can pay the same receiver twice. See [the security review](SECURITY_REVIEW.md) for the trust boundaries and test limits.

## Dependency and audit evidence

The required OpenZeppelin Contracts v5.6.1 import closure is vendored in `lib/openzeppelin-contracts`. The files are exact upstream source at commit `5fd1781b1454fd1ef8e722282f86f9293cacf256`. `manifest.json` records SHA-256 hashes for each source file and the upstream MIT license. There is no submodule or dependency checkout.

The [OpenZeppelin audit index](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/audits/README.md) lists the October 2025 v5.5.0 review of `SafeERC20`, `ECDSA`, and `SignatureChecker`, and the February 2026 v5.6.0 review of v5.5/v5.6 changes. [The v5.6.1 patch](https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.6.1) addresses `InteroperableAddress`, which is not in this import closure.

**This DTF contract is new custom code. It has not received an independent audit.** Component audits do not audit this composition or its backend integration. Coinbase's [audited MagicSpend reference](https://code4rena.com/reports/2024-03-coinbase) has different owner and replay rules and was not copied.

## Deployment records

Current Base deployment: [`0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8`](https://basescan.org/address/0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8). [Sourcify](https://repo.sourcify.dev/8453/0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8) confirmed exact creation and runtime source matches. The [November 4 public record](deployments/base-2026-11-04.json) saves the transaction, matched source and runtime hashes, constructor addresses, compiler settings and verification receipt. This version has native rescue, payable receive and owner-controlled signer changes. Its initial owner and payout signer are the approved addresses above.

The [prior Base deployment](https://basescan.org/address/0xA734D3837f0eb87Bca3cDF7C3dfE70422F2877Dd#code) has an immutable signer and no native rescue. Its unchanged [public record](deployments/base.json) retains the earlier source and verification evidence. It does not qualify the changed source.

The new deployment transaction, runtime, owner, initial signer, USDC and EIP-712 domain were checked. A mined receipt is not a claim of finality. No customer payout or treasury funding transfer was part of these checks. Backend activation remains separate. Treasury funding is manual; automatic Lighter funding is outside scope.

For a future deployment, record the source Git revision, source hash, compiler settings, constructor addresses, creation bytecode hash and predicted contract address before broadcast. Verify the exact source and constructor arguments afterward, and create a separate public record. Reconcile all prior payments and pending authorizations before changing the backend custody address.

Deployment, source verification and KMS authorization commands are in [the script guide](../scripts/deploy/instantPayoutsScripts.md).
