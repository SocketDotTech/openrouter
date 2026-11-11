# Instant Payouts scripts

Run these commands from the repository root after installing its existing development dependencies. They import `ethers` directly. They do not import Hardhat or the dotenv package. The deployment command loads the repository-root `.env` with Node's `process.loadEnvFile` when `main` runs. Existing process variables take precedence. A missing file leaves the exported settings in use; another file-read error stops with a generic message. Loading does not print settings or file contents. Importing the deployment module for offline tests does not load the repository `.env`. Use Node 20.12 or later with `process.loadEnvFile` support.

This exception is limited to `deployInstantPayouts.ts`. Authorization scripts still require exported settings and do not load `.env`. Foundry still runs only from the dedicated project root below.

Build the separate project first. Foundry must run from `instant-payouts/`, which has its own `foundry.toml`. Check for `.env` before starting Foundry; this checks existence only.

```sh
(
  set -e
  cd instant-payouts
  test ! -e .env && test ! -L .env
  forge build --offline
)
```

The compiler is Solidity 0.8.30. If it is not installed in Foundry, use a verified local compiler with `forge build --offline --use <compiler-path>`.

Prepare an unsigned Base deployment. `BASE_RPC` must be exported or set in the repository `.env`. The owner defaults to `0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53`; `OWNER_ADDRESS` can change it in the reviewed plan. The initial payout signer is the verified normal payout KMS address, `0x9486019cb42bBB69313f5cd0BC69625b9192e2e0`. A configured `PAYOUT_SIGNER_ADDRESS` must match this approved address. The router's `SOLVER_SIGNER_ADDRESS` is not used.

```sh
npx ts-node scripts/deploy/deployInstantPayouts.ts \
  --deployer 0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53 \
  --output /tmp/instant-payouts-base-plan.json
```

This mode loads deployment settings, including any configured key, but does not use a key to sign or broadcast. It saves the chain, owner, signer, token, deployer, nonce, predicted CREATE address, artifact SHA-256, creation/initcode hashes, and gas estimate. The gas budget excludes Base's L1 data fee. Review the plan before broadcast.

Use the existing deployment wallet through `DEPLOYER_PRIVATE_KEY` in the process environment or repository `.env`. Do not send the private key through chat. No key is copied into the output.

```sh
npx ts-node scripts/deploy/deployInstantPayouts.ts \
  --plan /tmp/instant-payouts-base-plan.json --broadcast \
  --output /tmp/instant-payouts-base-receipt.json
```

An optional `--expected-plan <printed-SHA256>` also checks the reviewed plan hash. If the deployment wallet is the payout signer, coordinate its Base nonce with the normal payout worker and add `--nonce-coordinated`. A separate deployment wallet does not need that flag. In both cases, the script refuses a changed nonce or an existing pending transaction. The flag is an operator acknowledgement, not a distributed lock.

The script saves the exact signed deployment bytes and hash before broadcast, then verifies the receipt, current block hash, transaction input, runtime code outside compiler immutable slots, owner, payout signer, native USDC, and EIP-712 domain. It uses ordinary CREATE and needs no new CREATE3 factory. It does not claim finality.

If the send or wait fails, keep the receipt file. Do not create another deployment or use another nonce. Check the stored transaction first:

```sh
npx ts-node scripts/deploy/deployInstantPayouts.ts \
  --verify /tmp/instant-payouts-base-receipt.json
```

Publish and wait for source verification after deployment. This first repeats the receipt and runtime checks. The default verifier uses public Sourcify API v2 and needs no API key. Foundry only creates the standard JSON input locally; it does not use its retired Sourcify v1 HTTP client. The request pins compiler 0.8.30, Cancun, 200 optimizer runs, and the recorded creation transaction hash.

```sh
npx ts-node scripts/deploy/deployInstantPayouts.ts \
  --verify-source /tmp/instant-payouts-base-receipt.json
```

The receipt stores the Sourcify job ID before polling. Each command reads the job at most six times with a two-second gap. If it remains pending, the command exits with status 2; run the same command to resume the saved job. It never submits another job while that ID is saved. A lost submission response leaves an unknown-outcome marker and requires an operator check before another submission. HTTP errors are not retried automatically. Success requires exact creation and runtime matches in both the completed job and the separate contract lookup. An HTTP 200 response alone is not success.

To use Etherscan/BaseScan instead, export `ETHERSCAN_API_KEY` and add `--source-verifier etherscan`. Verifier errors are hidden to keep endpoint/key details out of logs. The receipt records source verification only after the v2 exact-match checks, or after the watched Etherscan command succeeds. A failed source verification does not cause another deployment. API details: [Sourcify v2 documentation](https://docs.sourcify.dev/docs/api/index.html).

No command automatically retries a failed broadcast with a fresh transaction. Output files use mode 0600 and a new file is never overwritten. Receipt updates are atomic. Records and script error messages exclude RPC URLs, private keys, AWS key identifiers, and provider error bodies.

Prepare an authorization offline. Supply the permanent payout ID from accounting. Never generate another ID for a retry. `--amount` accepts decimal USDC with at most six decimal places; the signature uses integer six-decimal units. `--deadline` is a Unix timestamp, inclusive in the contract.

```sh
npx ts-node scripts/deploy/instantPayoutAuthorization.ts prepare \
  --contract <deployed-contract> --payout-id <nonzero-bytes32> \
  --recipient <receiver> --amount 80.123456 --deadline <unix-seconds> \
  --output /tmp/instant-payout-authorization.json
npx ts-node scripts/deploy/instantPayoutAuthorization.ts hash \
  --input /tmp/instant-payout-authorization.json
```

Explicit KMS signing uses Foundry's native AWS support. Export `AWS_KMS_KEY_ID` and the standard AWS settings, or pass `--kms-key-id`. The script checks Base, the contract domain/token, unused payout ID, and the current on-chain signer against the selected KMS public address before signing. An optional `--signer` or exported `PAYOUT_SIGNER_ADDRESS` pins the expected current signer; a mismatch stops signing. The deployment helper still requires the approved initial signer above. It recovers the resulting signature locally. `cast` runs only from the dedicated project root; it refuses if that root contains `.env`, including a symlink. Signing does not submit a payment.

```sh
npx ts-node scripts/deploy/instantPayoutAuthorization.ts sign \
  --input /tmp/instant-payout-authorization.json --execute-kms-sign \
  --output /tmp/instant-payout-signed.json
npx ts-node scripts/deploy/instantPayoutAuthorization.ts calldata \
  --input /tmp/instant-payout-signed.json \
  --signer <current-onchain-payout-signer> \
  --output /tmp/instant-payout-relay.json
```

Offline `calldata` mode requires `--signer` and checks signature recovery against that explicit current address. It makes no RPC call, so confirm that address is still active before relay. The relay JSON contains chain ID, contract, value zero, and exact `payout(...)` calldata. Manual and automatic callers must use this same payout path and ID. Treasury manually prefunds the contract with native Base USDC and pays relay gas. Insufficient USDC waits for funding; these scripts do not withdraw from Lighter or replenish funds. The script does not broadcast payout transactions. `rescueToken` is an owner recovery exception and must not be used as the manual payout route. The contract cannot detect a second accounting ID for the same claim.

The changed contract exposes `setPayoutSigner(address)` and `rescueNative(address,uint256)` to the owner. The signer must be nonzero. Native rescue uses native units (wei on Base), requires a nonzero receiver and checks transfer success. The contract accepts plain native transfers, but gas for payout transactions stays in the relayer account. Do not use owner rescue as the customer payment path.

Signer changes have no epoch or cancellation counter. An old signature fails while another signer is active. Selecting the old signer again restores its unused, unexpired authorizations. Paid IDs remain used. The EIP-712 domain name/version and payout fields are unchanged. The November 4 deployment at `0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8` has native rescue and the mutable signer. [Sourcify](https://repo.sourcify.dev/8453/0x6Dd462E3b4b197cC163955C6F00e8FF1876665b8) confirmed exact creation and runtime matches. Its public record is `instant-payouts/deployments/base-2026-11-04.json`. The prior deployment has an immutable signer and no native rescue; keep `instant-payouts/deployments/base.json` unchanged. Write a separate record for any future deployment.

Offline checks use synthetic environment files only; they do not load the real repository `.env`.

```sh
npx ts-node scripts/deploy/instantPayouts.test.ts
```

`INSTANT_PAYOUTS_ROOT` can select another dedicated checkout root for local checks. It must contain the project's own `foundry.toml` and must not contain `.env`. No workstation path or AWS profile alias is stored in these scripts.
