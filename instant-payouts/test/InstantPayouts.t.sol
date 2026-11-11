// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {InstantPayouts} from "../src/InstantPayouts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function chainId(uint256 chainId_) external;
    function etch(address target, bytes calldata code) external;
    function prank(address caller) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Installed only in the local test EVM at the fixed Base USDC address.
contract TestToken {
    mapping(address => uint256) public balanceOf;
    bool public returnFalse;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract NativeReceiver {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

contract NativeRejector {
    receive() external payable {
        revert("native rejected");
    }
}

contract InstantPayoutsTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant AMOUNT = 80e6;
    uint256 internal constant DEADLINE = 1_800_000_000;
    bytes32 internal constant ID = keccak256("payout-1");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    address internal constant OWNER = 0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53;
    address internal constant RECIPIENT = address(0xB0B);
    address internal constant OTHER = address(0xCA11);

    InstantPayouts internal vault;
    TestToken internal usdc;

    event PayoutSignerChanged(address indexed previousSigner, address indexed newSigner);
    event NativeRescued(address indexed recipient, uint256 amount);
    event Paid(bytes32 indexed payoutId, address indexed recipient, uint256 amount);
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_700_000_000);
        vault = new InstantPayouts(OWNER, vm.addr(SIGNER_KEY));
        TestToken template = new TestToken();
        vm.etch(address(vault.USDC()), address(template).code);
        usdc = TestToken(address(vault.USDC()));
        usdc.mint(address(vault), 1_000e6);
    }

    function testAnyoneCanRelayFullAmountAndEmitsReceipt() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(ID, RECIPIENT, AMOUNT);
        vm.prank(OTHER);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        require(vault.used(ID), "ID not consumed");
        require(usdc.balanceOf(RECIPIENT) == AMOUNT, "wrong receiver amount");
        require(usdc.balanceOf(OTHER) == 0, "relayer received funds");
    }

    function testDuplicateIdFailsEvenWithNewReceiverAmountAndSignature() public {
        _pay(ID, RECIPIENT, AMOUNT);
        bytes memory changed = _signature(ID, OTHER, 2 * AMOUNT, DEADLINE);
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, ID));
        vault.payout(ID, OTHER, 2 * AMOUNT, DEADLINE, changed);
        require(usdc.balanceOf(OTHER) == 0, "duplicate paid");
    }

    function testAutomaticThenManualAndManualThenAutomaticUseSameGuard() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        vm.prank(OTHER); // Automatic worker wins the first race.
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, ID));
        vm.prank(OWNER); // A manual owner call has no bypass.
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);

        bytes32 secondId = keccak256("manual-first");
        bytes memory secondSignature = _signature(secondId, RECIPIENT, AMOUNT, DEADLINE);
        vm.prank(OWNER);
        vault.payout(secondId, RECIPIENT, AMOUNT, DEADLINE, secondSignature);
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, secondId));
        vm.prank(OTHER);
        vault.payout(secondId, RECIPIENT, AMOUNT, DEADLINE, secondSignature);
        require(usdc.balanceOf(RECIPIENT) == 2 * AMOUNT, "race paid twice");
    }

    function testSignatureBindsEveryPayoutField() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, OTHER, AMOUNT, DEADLINE, signature);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, RECIPIENT, AMOUNT + 1, DEADLINE, signature);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE + 1, signature);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(keccak256("different-id"), RECIPIENT, AMOUNT, DEADLINE, signature);
        require(!vault.used(ID), "failed signatures consumed ID");
    }

    function testSignatureCannotReplayOnAnotherChainOrContract() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        vm.chainId(1);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        vm.chainId(8453);
        InstantPayouts anotherVault = new InstantPayouts(OWNER, vm.addr(SIGNER_KEY));
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        anotherVault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
    }

    function testDeadlineIsInclusiveAndExpiredAuthorizationDoesNotConsumeId() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        vm.warp(DEADLINE + 1);
        vm.expectRevert(InstantPayouts.PayoutExpired.selector);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        require(!vault.used(ID), "expiry consumed ID");
        vm.warp(DEADLINE);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
    }

    function testWrongSignerMalformedAndHighSSignaturesFail() public {
        bytes32 digest = _digest(ID, RECIPIENT, AMOUNT, DEADLINE);
        (uint8 badV, bytes32 badR, bytes32 badS) = vm.sign(0xBAD, digest);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, abi.encodePacked(badR, badS, badV));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, hex"");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        uint256 curveOrder = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(curveOrder - uint256(s));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));
        require(!vault.used(ID), "bad signature consumed ID");
    }

    function testFalseReturningTransferRollsBackIdAndCanRetry() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        usdc.setReturnFalse(true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        require(!vault.used(ID), "failed transfer consumed ID");
        require(usdc.balanceOf(RECIPIENT) == 0, "failed transfer paid");
        usdc.setReturnFalse(false);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
    }

    function testInsufficientFundingRollsBackIdAndCanRetryAfterFunding() public {
        uint256 amount = 2_000e6;
        bytes memory signature = _signature(ID, RECIPIENT, amount, DEADLINE);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "insufficient balance"));
        vault.payout(ID, RECIPIENT, amount, DEADLINE, signature);
        require(!vault.used(ID), "insufficient funds consumed ID");
        usdc.mint(address(vault), 1_000e6);
        vault.payout(ID, RECIPIENT, amount, DEADLINE, signature);
        require(usdc.balanceOf(RECIPIENT) == amount, "retry amount");
    }

    function testInvalidPayoutInputsFail() public {
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vault.payout(bytes32(0), RECIPIENT, AMOUNT, DEADLINE, hex"");
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vault.payout(ID, address(0), AMOUNT, DEADLINE, hex"");
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vault.payout(ID, RECIPIENT, 0, DEADLINE, hex"");
    }

    function testSelfRecipientCannotConsumeIdOrEmitReceipt() public {
        bytes memory signature = _signature(ID, address(vault), AMOUNT, DEADLINE);
        uint256 vaultBalance = usdc.balanceOf(address(vault));
        vm.recordLogs();
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vault.payout(ID, address(vault), AMOUNT, DEADLINE, signature);
        require(!vault.used(ID), "self transfer consumed ID");
        require(usdc.balanceOf(address(vault)) == vaultBalance, "self transfer moved funds");
        require(vm.getRecordedLogs().length == 0, "self transfer emitted receipt");
        _pay(ID, RECIPIENT, AMOUNT);
        require(usdc.balanceOf(RECIPIENT) == AMOUNT, "valid replacement could not pay");
    }

    function testTokenRecipientCannotConsumeIdOrMoveUsdc() public {
        bytes memory signature = _signature(ID, address(usdc), AMOUNT, DEADLINE);
        uint256 vaultBalance = usdc.balanceOf(address(vault));
        uint256 tokenBalance = usdc.balanceOf(address(usdc));
        vm.recordLogs();
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vault.payout(ID, address(usdc), AMOUNT, DEADLINE, signature);
        require(!vault.used(ID), "token transfer consumed ID");
        require(usdc.balanceOf(address(vault)) == vaultBalance, "token transfer debited vault");
        require(usdc.balanceOf(address(usdc)) == tokenBalance, "token transfer credited token");
        require(vm.getRecordedLogs().length == 0, "token transfer emitted receipt");
    }

    function testOwnerCanRescueUsdcAndOtherTokenWithoutSignature() public {
        TestToken otherToken = new TestToken();
        otherToken.mint(address(vault), 5);
        vm.expectEmit(true, true, false, true, address(vault));
        emit TokenRescued(address(otherToken), OTHER, 5);
        vm.prank(OWNER);
        vault.rescueToken(IERC20(address(otherToken)), OTHER, 5);
        vm.prank(OWNER);
        vault.rescueToken(IERC20(address(usdc)), RECIPIENT, AMOUNT);
        require(otherToken.balanceOf(OTHER) == 5, "other token not rescued");
        require(usdc.balanceOf(RECIPIENT) == AMOUNT, "USDC not rescued");
        require(!vault.used(ID), "rescue must not claim payout ID");
    }

    function testNonOwnerIncludingKmsSignerCannotRescue() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        vm.prank(OTHER);
        vault.rescueToken(IERC20(address(usdc)), OTHER, 1);
        address signer = vm.addr(SIGNER_KEY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        vm.prank(signer);
        vault.rescueToken(IERC20(address(usdc)), OTHER, 1);
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vm.prank(OWNER);
        vault.rescueToken(IERC20(address(usdc)), address(0), 1);
    }

    function testOwnershipRequiresNominationAndAcceptance() public {
        vm.prank(OWNER);
        vault.transferOwnership(OTHER);
        require(vault.owner() == OWNER && vault.pendingOwner() == OTHER, "owner changed before acceptance");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, RECIPIENT));
        vm.prank(RECIPIENT);
        vault.acceptOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        vm.prank(OTHER);
        vault.rescueToken(IERC20(address(usdc)), OTHER, 1);
        vm.prank(OTHER);
        vault.acceptOwnership();
        require(vault.owner() == OTHER && vault.pendingOwner() == address(0), "acceptance failed");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        vm.prank(OWNER);
        vault.rescueToken(IERC20(address(usdc)), OWNER, 1);
        vm.prank(OTHER);
        vault.rescueToken(IERC20(address(usdc)), OTHER, 1);
    }

    function testZeroConstructorAuthoritiesFail() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new InstantPayouts(address(0), vm.addr(SIGNER_KEY));
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        new InstantPayouts(OWNER, address(0));
    }

    function testFuzz_GlobalIdCanOnlyPayOnce(bytes32 id, uint96 rawAmount, address recipient) public {
        if (id == bytes32(0)) id = bytes32(uint256(1));
        if (recipient == address(0) || recipient == address(vault) || recipient == address(usdc)) recipient = RECIPIENT;
        uint256 amount = uint256(rawAmount) + 1;
        usdc.mint(address(vault), amount);
        uint256 beforeBalance = usdc.balanceOf(recipient);
        bytes memory signature = _signature(id, recipient, amount, DEADLINE);
        vault.payout(id, recipient, amount, DEADLINE, signature);
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, id));
        vault.payout(id, recipient, amount, DEADLINE, signature);
        require(usdc.balanceOf(recipient) - beforeBalance == amount, "not paid exactly once");
    }

    function testNativeDepositAndOwnerRescuePreservePayoutState() public {
        _pay(ID, RECIPIENT, AMOUNT);
        address signer = vault.payoutSigner();
        NativeReceiver receiver = new NativeReceiver();
        vm.deal(address(this), 2 ether);
        (bool deposited,) = address(vault).call{value: 2 ether}("");
        require(deposited && address(vault).balance == 2 ether, "native deposit failed");
        vm.expectEmit(true, false, false, true, address(vault));
        emit NativeRescued(address(receiver), 1 ether);
        vm.prank(OWNER);
        vault.rescueNative(payable(address(receiver)), 1 ether);
        require(receiver.received() == 1 ether && address(vault).balance == 1 ether, "native rescue amount");
        require(vault.used(ID) && vault.payoutSigner() == signer, "native rescue changed payout state");
    }

    function testNativeRescueRejectsUnauthorizedAndInvalidReceiver() public {
        vm.deal(address(vault), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        vm.prank(OTHER);
        vault.rescueNative(payable(OTHER), 1 ether);
        address signer = vm.addr(SIGNER_KEY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        vm.prank(signer);
        vault.rescueNative(payable(OTHER), 1 ether);
        vm.expectRevert(InstantPayouts.InvalidPayout.selector);
        vm.prank(OWNER);
        vault.rescueNative(payable(address(0)), 1 ether);
        require(address(vault).balance == 1 ether, "rejected rescue moved native funds");
    }

    function testNativeRescueFailurePreservesBalanceAndCanRetry() public {
        NativeRejector rejector = new NativeRejector();
        NativeReceiver receiver = new NativeReceiver();
        vm.deal(address(vault), 1 ether);
        vm.recordLogs();
        vm.expectRevert(InstantPayouts.NativeTransferFailed.selector);
        vm.prank(OWNER);
        vault.rescueNative(payable(address(rejector)), 1 ether);
        require(vm.getRecordedLogs().length == 0, "failed native rescue emitted receipt");
        require(address(vault).balance == 1 ether, "failed native rescue moved funds");
        vm.expectRevert(InstantPayouts.NativeTransferFailed.selector);
        vm.prank(OWNER);
        vault.rescueNative(payable(address(receiver)), 2 ether);
        vm.prank(OWNER);
        vault.rescueNative(payable(address(receiver)), 1 ether);
        require(receiver.received() == 1 ether && address(vault).balance == 0, "native rescue retry failed");
    }

    function testSignerChangeRequiresOwnerAndNonzeroAddress() public {
        address originalSigner = vault.payoutSigner();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        vm.prank(OTHER);
        vault.setPayoutSigner(OTHER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, originalSigner));
        vm.prank(originalSigner);
        vault.setPayoutSigner(OTHER);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vm.prank(OWNER);
        vault.setPayoutSigner(address(0));
        require(vault.payoutSigner() == originalSigner, "rejected signer change took effect");
    }

    function testSignerRotationRejectsOldSignerAndPreservesPaidIds() public {
        _pay(ID, RECIPIENT, AMOUNT);
        bytes32 nextId = keccak256("next-payout");
        bytes memory oldSignature = _signature(nextId, RECIPIENT, AMOUNT, DEADLINE);
        address oldSigner = vault.payoutSigner();
        uint256 newKey = 0xB0B;
        address newSigner = vm.addr(newKey);
        vm.expectEmit(true, true, false, true, address(vault));
        emit PayoutSignerChanged(oldSigner, newSigner);
        vm.prank(OWNER);
        vault.setPayoutSigner(newSigner);
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(nextId, RECIPIENT, AMOUNT, DEADLINE, oldSignature);
        require(!vault.used(nextId) && vault.used(ID), "rotation changed used IDs");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newKey, _digest(nextId, RECIPIENT, AMOUNT, DEADLINE));
        vault.payout(nextId, RECIPIENT, AMOUNT, DEADLINE, abi.encodePacked(r, s, v));
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, ID));
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, hex"");
        require(usdc.balanceOf(RECIPIENT) == 2 * AMOUNT, "new signer did not pay once");
    }

    function testSelectingOldSignerRestoresUnusedUnexpiredAuthorization() public {
        bytes memory signature = _signature(ID, RECIPIENT, AMOUNT, DEADLINE);
        address originalSigner = vault.payoutSigner();
        vm.prank(OWNER);
        vault.setPayoutSigner(vm.addr(0xB0B));
        vm.expectRevert(InstantPayouts.InvalidSigner.selector);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        vm.prank(OWNER);
        vault.setPayoutSigner(originalSigner);
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
        require(vault.used(ID) && usdc.balanceOf(RECIPIENT) == AMOUNT, "restored signer signature rejected");
        vm.expectRevert(abi.encodeWithSelector(InstantPayouts.PayoutAlreadyUsed.selector, ID));
        vault.payout(ID, RECIPIENT, AMOUNT, DEADLINE, signature);
    }

    function _pay(bytes32 id, address recipient, uint256 amount) internal {
        vault.payout(id, recipient, amount, DEADLINE, _signature(id, recipient, amount, DEADLINE));
    }

    function _signature(bytes32 id, address recipient, uint256 amount, uint256 deadline)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, _digest(id, recipient, amount, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _digest(bytes32 id, address recipient, uint256 amount, uint256 deadline) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("DTF Instant Payouts"), keccak256("1"), block.chainid, address(vault))
        );
        bytes32 data = keccak256(abi.encode(vault.PAYOUT_TYPEHASH(), id, recipient, amount, deadline));
        return keccak256(abi.encodePacked(hex"1901", domain, data));
    }
}
