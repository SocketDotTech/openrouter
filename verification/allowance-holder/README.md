# AllowanceHolder Verification Source

This Foundry project exists only to verify the deployed Socket
AllowanceHolder.

The source is the 0x-settler Cancun AllowanceHolder with the constructor
address guard patched from 0x's holder address to Socket's CREATE3 address:

```solidity
require(
    address(this) == 0x50c4E75a512F2A14A7b304787Adf79C4531A5909 ||
    block.chainid == 31337
);
```

Compiler settings:

- Solidity `0.8.25`
- EVM version `cancun`
- optimizer enabled, `1000000` runs
- `viaIR = false`
- IPFS CBOR metadata enabled

The compiled bytecode body matches the deployed initcode recovered from the
CreateX CREATE3 deployment transaction. The metadata hash can differ from the
original deployment artifact, so some explorers record this as a similar or
partial match.

Run:

```bash
ETHERSCAN_API_KEY=... npm run verify:allowance-holder
```
