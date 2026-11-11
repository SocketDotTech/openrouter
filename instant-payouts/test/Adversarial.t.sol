// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {InstantPayouts} from "../src/InstantPayouts.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ReviewVm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract HookToken {
    mapping(address => uint256) public balanceOf;
    address public target;
    bytes public payload;
    bool public attempted;
    bool public reentered;

    function mint(address who, uint256 value) external {
        balanceOf[who] += value;
    }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (target != address(0) && !attempted) {
            attempted = true;
            (reentered,) = target.call(payload);
        }
        require(balanceOf[msg.sender] >= value, "short balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

abstract contract ReviewBase {
    ReviewVm constant vm = ReviewVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Public test key. It has no role outside this local test EVM.
    uint256 constant TEST_SIGNER_KEY = 0xA11CE;
    address constant OWNER = address(0x1111);
    address constant RECEIVER = address(0x2222);
    address constant ATTACKER = address(0x3333);
    bytes32 constant ID = keccak256("payout-id");
    uint256 constant AMOUNT = 100e6;
    InstantPayouts vault;

    function sig(bytes32 id, address receiver, uint256 amount, uint256 deadline) internal returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DTF Instant Payouts"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901", domain, keccak256(abi.encode(vault.PAYOUT_TYPEHASH(), id, receiver, amount, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract LocalAdversarialReview is ReviewBase {
    HookToken token;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1800000000);
        vault = new InstantPayouts(OWNER, vm.addr(TEST_SIGNER_KEY));
        HookToken t = new HookToken();
        vm.etch(address(vault.USDC()), address(t).code);
        token = HookToken(address(vault.USDC()));
        token.mint(address(vault), 1000e6);
    }

    function testFuzz_CopiedSignatureCannotRedirect(address relayer) public {
        if (relayer == RECEIVER) relayer = ATTACKER;
        uint256 deadline = block.timestamp + 100;
        bytes memory s = sig(ID, RECEIVER, AMOUNT, deadline);
        vm.prank(relayer);
        vault.payout(ID, RECEIVER, AMOUNT, deadline, s);
        require(token.balanceOf(RECEIVER) == AMOUNT, "receiver unpaid");
        if (relayer != address(vault)) require(token.balanceOf(relayer) == 0, "relayer stole");
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, ID));
        vault.payout(ID, RECEIVER, AMOUNT, deadline, s);
    }

    function testSameIdReentryCannotPayTwice() public {
        uint256 deadline = block.timestamp + 100;
        bytes memory s = sig(ID, RECEIVER, AMOUNT, deadline);
        token.arm(address(vault), abi.encodeCall(vault.payout, (ID, RECEIVER, AMOUNT, deadline, s)));
        vault.payout(ID, RECEIVER, AMOUNT, deadline, s);
        require(token.attempted() && !token.reentered(), "reentry paid");
        require(token.balanceOf(RECEIVER) == AMOUNT, "double debit");
    }

    function testReentryCannotRedirectValidSignature() public {
        uint256 deadline = block.timestamp + 100;
        bytes memory s = sig(ID, RECEIVER, AMOUNT, deadline);
        token.arm(address(vault), abi.encodeCall(vault.payout, (ID, ATTACKER, AMOUNT, deadline, s)));
        vault.payout(ID, RECEIVER, AMOUNT, deadline, s);
        require(!token.reentered() && token.balanceOf(ATTACKER) == 0, "redirected");
    }

    function testDistinctIdsAreDistinctAuthorizations() public {
        uint256 deadline = block.timestamp + 100;
        bytes32 id2 = keccak256("same-entitlement-new-id");
        vault.payout(ID, RECEIVER, AMOUNT, deadline, sig(ID, RECEIVER, AMOUNT, deadline));
        vault.payout(id2, RECEIVER, AMOUNT, deadline, sig(id2, RECEIVER, AMOUNT, deadline));
        require(token.balanceOf(RECEIVER) == 2 * AMOUNT, "backend-ID limitation not reproduced");
    }

    function testPendingOwnerCannotAcceptAfterCancellation() public {
        vm.prank(OWNER);
        vault.transferOwnership(ATTACKER);
        vm.prank(OWNER);
        vault.transferOwnership(address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER));
        vm.prank(ATTACKER);
        vault.acceptOwnership();
        require(vault.owner() == OWNER, "owner changed");
    }

    function testRenounceClearsPendingOwnerAndDoesNotChangeSigner() public {
        address originalSigner = vault.payoutSigner();
        vm.prank(OWNER);
        vault.transferOwnership(ATTACKER);
        vm.prank(OWNER);
        vault.renounceOwnership();
        require(vault.owner() == address(0) && vault.pendingOwner() == address(0), "pending owner survives");
        require(vault.payoutSigner() == originalSigner, "signer changed");
        uint256 deadline = block.timestamp + 100;
        vault.payout(ID, RECEIVER, AMOUNT, deadline, sig(ID, RECEIVER, AMOUNT, deadline));
    }
}
