/**
 * Checks native balance of the deployer wallet across all OpenRouter chains.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkDeployerBalances.ts
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *
 * Optional env:
 *   MIN_BALANCE_WEI — minimum native balance to mark a chain as funded (default: 10^15 wei ≈ 0.001 ETH)
 */

import { Wallet, formatEther } from 'ethers';
import { RECEIVER_DEPLOY_NETWORKS } from './networks';
import {
  createNetworkProvider,
  resolveDeployerPrivateKey,
} from './receiverDeployCore';

async function main() {
  const deployerKey = resolveDeployerPrivateKey();
  const wallet = new Wallet(deployerKey);
  const minBalanceWei = BigInt(process.env.MIN_BALANCE_WEI?.trim() || '1000000000000000');

  console.log(`Deployer: ${wallet.address}`);
  console.log(`Min balance threshold: ${formatEther(minBalanceWei)} native`);
  console.log('');

  let funded = 0;
  let unfunded = 0;
  let errors = 0;

  for (const network of RECEIVER_DEPLOY_NETWORKS) {
    try {
      const provider = createNetworkProvider(network);
      const balance = await provider.getBalance(wallet.address);
      const sufficient = balance >= minBalanceWei;
      const tag = sufficient ? 'OK' : 'LOW';

      if (sufficient) {
        funded++;
      } else {
        unfunded++;
      }

      console.log(
        `[${tag}] ${network.name.padEnd(12)} chainId=${String(network.chainId).padEnd(8)} balance=${formatEther(balance)} native`,
      );
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ERR] ${network.name.padEnd(12)} chainId=${network.chainId} error=${msg}`);
    }
  }

  console.log('');
  console.log(`Summary: ${funded} funded, ${unfunded} low balance, ${errors} errors`);

  if (unfunded > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
