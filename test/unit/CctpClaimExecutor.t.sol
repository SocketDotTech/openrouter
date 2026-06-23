// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {CctpClaimExecutor} from "../../src/executors/CctpClaimExecutor.sol";
import {AuthenticationLib} from "../../src/common/lib/AuthenticationLib.sol";
import {IMessageTransmitter} from "../../src/interfaces/IMessageTransmitter.sol";

contract CctpClaimExecutorTest is Test {
    uint256 internal constant SOLVER_PRIVATE_KEY = 0xA11CE;
    uint256 internal constant MINT_AMOUNT = 1_000_000; // 1 USDC (6 decimals)
    uint256 internal constant RELAY_FEE = 50_000; // 0.05 USDC

    address internal constant OWNER = address(0x2222);
    address internal constant RECIPIENT = address(0xB0B);
    address internal constant FEE_TAKER = address(0xFEE);
    address internal constant OTHER = address(0xCAFE);

    address internal solverSigner;
    CctpClaimExecutor internal executor;
    MockMessageTransmitter internal transmitter;
    MockERC20 internal usdc;

    bytes internal message;
    bytes internal attestation;

    function setUp() public {
        solverSigner = vm.addr(SOLVER_PRIVATE_KEY);

        usdc = new MockERC20("USD Coin", "USDC");
        transmitter = new MockMessageTransmitter(address(usdc));
        executor = new CctpClaimExecutor(OWNER, address(transmitter), solverSigner, address(usdc));

        message = hex"abcd";
        attestation = hex"abcd";

        vm.label(address(executor), "executor");
        vm.label(address(transmitter), "transmitter");
        vm.label(address(usdc), "usdc");
        vm.label(RECIPIENT, "recipient");
        vm.label(FEE_TAKER, "feeTaker");
        vm.label(solverSigner, "solverSigner");
    }

    function test_claim_transfersFeeAndNet() public {
        transmitter.setMintAmount(MINT_AMOUNT);

        bytes memory signature = _signClaim(message, attestation, RECIPIENT, FEE_TAKER, RELAY_FEE);

        executor.claim(message, attestation, RECIPIENT, FEE_TAKER, RELAY_FEE, signature);

        assertEq(usdc.balanceOf(FEE_TAKER), RELAY_FEE);
        assertEq(usdc.balanceOf(RECIPIENT), MINT_AMOUNT - RELAY_FEE);
    }

    function test_claim_revertsIfInvalidSigner() public {
        transmitter.setMintAmount(MINT_AMOUNT);

        bytes memory signature = _signClaimWithKey(
            0xBEEF,
            message,
            attestation,
            RECIPIENT,
            FEE_TAKER,
            RELAY_FEE
        );

        vm.expectRevert(CctpClaimExecutor.InvalidSigner.selector);
        executor.claim(message, attestation, RECIPIENT, FEE_TAKER, RELAY_FEE, signature);
    }

    function test_claim_revertsIfWrongRecipientInSignature() public {
        transmitter.setMintAmount(MINT_AMOUNT);

        bytes memory signature = _signClaim(message, attestation, OTHER, FEE_TAKER, RELAY_FEE);

        vm.expectRevert(CctpClaimExecutor.InvalidSigner.selector);
        executor.claim(message, attestation, RECIPIENT, FEE_TAKER, RELAY_FEE, signature);
    }

    function test_rescueFunds_onlyOwner() public {
        usdc.mint(address(executor), MINT_AMOUNT);

        vm.prank(OTHER);
        vm.expectRevert();
        executor.rescueFunds(address(usdc), OWNER, MINT_AMOUNT);

        vm.prank(OWNER);
        executor.rescueFunds(address(usdc), OWNER, MINT_AMOUNT);

        assertEq(usdc.balanceOf(OWNER), MINT_AMOUNT);
    }

    function _signClaim(
        bytes memory message_,
        bytes memory attestation_,
        address recipient,
        address feeTaker,
        uint256 quotedRelayFee
    ) internal view returns (bytes memory) {
        return _signClaimWithKey(
            SOLVER_PRIVATE_KEY,
            message_,
            attestation_,
            recipient,
            feeTaker,
            quotedRelayFee
        );
    }

    function _signClaimWithKey(
        uint256 privateKey,
        bytes memory message_,
        bytes memory attestation_,
        address recipient,
        address feeTaker,
        uint256 quotedRelayFee
    ) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encode(
                block.chainid,
                address(executor),
                message_,
                attestation_,
                recipient,
                feeTaker,
                quotedRelayFee
            )
        );
        return _signMessage(privateKey, messageHash);
    }

    function _signMessage(uint256 privateKey, bytes32 messageHash) internal pure returns (bytes memory) {
        bytes32 ethSigned = AuthenticationLib.getEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSigned);
        return abi.encodePacked(r, s, v);
    }
}

contract MockERC20 is ERC20 {
    string private _name;
    string private _symbol;

    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockMessageTransmitter is IMessageTransmitter {
    IERC20Mintable internal immutable usdc;
    uint256 internal mintAmount;

    constructor(address usdc_) {
        usdc = IERC20Mintable(usdc_);
    }

    function setMintAmount(uint256 amount) external {
        mintAmount = amount;
    }

    function receiveMessage(bytes calldata, bytes calldata) external returns (bool) {
        if (mintAmount > 0) {
            usdc.mint(msg.sender, mintAmount);
        }
        return true;
    }

    function usedNonces(bytes32) external pure returns (uint256) {
        return 0;
    }
}

interface IERC20Mintable {
    function mint(address to, uint256 amount) external;
}
