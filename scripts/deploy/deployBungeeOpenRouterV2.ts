/**
 * Deployment script for BungeeOpenRouterV2 and BungeeOpenRouterV2Unchecked.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployBungeeOpenRouterV2.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY       — deployer wallet private key
 *   OWNER_ADDRESS              — owner of both contracts (defaults to deployer)
 *   OPEN_ROUTER_SIGNER_ADDRESS — backend signer for BungeeOpenRouterV2
 *
 * Optional: set --network to any network configured in hardhat.config.ts.
 * Omitting --network runs against the in-process Hardhat network.
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;

  const owner = deployer.address;
  const openRouterSigner = deployer.address;

  if (!openRouterSigner) {
    throw new Error('OPEN_ROUTER_SIGNER_ADDRESS is not set in environment');
  }

  console.log('Deployer:          ', deployer.address);
  console.log('Owner:             ', owner);
  console.log('OpenRouterSigner:  ', openRouterSigner);
  console.log('Network:           ', networkName);
  console.log('');

  // -------------------------------------------------------------------------
  // BungeeOpenRouterV2  (monolithic + modular, signature-verified, AH pull)
  // -------------------------------------------------------------------------
  // console.log("Deploying BungeeOpenRouterV2...");
  // const V2Factory = await ethers.getContractFactory("BungeeOpenRouterV2");
  // const v2 = await V2Factory.deploy(owner, openRouterSigner);
  // await v2.waitForDeployment();
  // const v2Address = await v2.getAddress();
  // console.log("BungeeOpenRouterV2 deployed to:", v2Address);

  // -------------------------------------------------------------------------
  // BungeeOpenRouterV2Unchecked  (same logic, no signature verification)
  // -------------------------------------------------------------------------
  console.log('Deploying BungeeOpenRouterV2Unchecked...');
  const V2UFactory = await ethers.getContractFactory(
    'BungeeOpenRouterV2Unchecked',
  );
  const v2u = await V2UFactory.deploy(owner);
  await v2u.waitForDeployment();
  const v2uAddress = await v2u.getAddress();
  console.log('BungeeOpenRouterV2Unchecked deployed to:', v2uAddress);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n=== Deployment Summary ===');
  // console.log(`BungeeOpenRouterV2:           ${v2Address}`);
  console.log(`BungeeOpenRouterV2Unchecked:  ${v2uAddress}`);

  // -------------------------------------------------------------------------
  // Verification hint
  // -------------------------------------------------------------------------
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n) {
    console.log('\nTo verify on a block explorer:');
    // console.log(
    //   `  npx hardhat verify --network ${networkName} ${v2Address} "${owner}" "${openRouterSigner}"`
    // );
    console.log(
      `  npx hardhat verify --network ${networkName} ${v2uAddress} "${owner}"`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
