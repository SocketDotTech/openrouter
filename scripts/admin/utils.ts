import { ethers } from 'hardhat';
import { exit, stdin, stdout } from 'process';
import { createInterface } from 'readline/promises';

export enum Role {
  RESCUE_ROLE = 'RESCUE_ROLE',
}

export const throwError = (errorMessage: string): never => {
  throw new Error(errorMessage);
};

export const confirm = async (message: string) => {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(message);
  rl.close();
  if (answer.toLowerCase() !== 'y') {
    exit(0);
  }
};

export const getRoleHash = (role: Role) =>
  ethers.keccak256(ethers.toUtf8Bytes(role)).toString();
