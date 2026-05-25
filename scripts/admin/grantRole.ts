/**
 * Grant `RESCUE_ROLE` on OpenRouter to the configured rescue address.
 *
 * Usage:
 *   npx hardhat run scripts/admin/grantRole.ts --network <network>
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY — must be the OpenRouter owner
 *
 * Optional env:
 *   OPEN_ROUTER_ADDRESS — override deployed router (else uses ROUTER_BY_CHAIN_ID / ROUTER_CHAIN_<id>)
 *   RESCUE_ROLE_GRANTEE | PROD_RESCUE_ROLE | DEV_RESCUE_ROLE — grantee (default in scripts/admin/config.ts)
 */

import hre, { ethers } from 'hardhat';

import { confirm, getRoleHash, Role } from './utils';

export const grantRole = async () => {
  const { network } = hre;
  const [deployer] = await ethers.getSigners();

  console.log('Network:', network.name);
  console.log('Deployer:', deployer.address);

  const grantee = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';

  await _grantRole({
    role: Role.RESCUE_ROLE,
    grantee,
  });
};

export const _grantRole = async (params: { role: Role; grantee: string }) => {
  const { role, grantee } = params;
  const roleHash = getRoleHash(role);
  const chainName = hre.network.name;
  const [deployer] = await ethers.getSigners();

  console.log('Chain Name:', chainName);
  console.log('Contract Name: OpenRouter');
  console.log('Role:', role);
  console.log('Grantee:', grantee);
  await confirm('Continue? y/n ');

  const contractAddress = '0x1Cb8E88afDe521aaA0108F2b788D467C286ABAe7';

  const contract = await ethers.getContractAt(
    'OpenRouter',
    contractAddress,
    deployer,
  );

  const owner = await contract.owner();
  if (owner !== deployer.address) {
    throw new Error(
      `Deployer is not the owner of OpenRouter\nOwner: ${owner}; Deployer: ${deployer.address}`,
    );
  }

  const hasRoleBefore = await contract.hasRole(roleHash, grantee);
  if (hasRoleBefore) {
    console.log(`Role ${role} already granted to ${grantee}. Skipping...`);
    return;
  }

  const grantRoleTxn = await contract.grantRole(roleHash, grantee);
  console.log(`grantRole() hash: ${grantRoleTxn.hash}, network: ${chainName}`);
  await grantRoleTxn.wait(2);

  const hasRole = await contract.hasRole(roleHash, grantee);
  if (!hasRole) {
    throw new Error(`Role ${role} not granted to ${grantee}`);
  }

  console.log(`Role ${role} granted to ${grantee} on ${contractAddress}`);
};

if (require.main === module) {
  grantRole()
    .then(() => {
      console.log('Finished running grantRole script');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
