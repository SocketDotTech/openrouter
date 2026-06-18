// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {RFQVaultExecutor} from "../../src/executors/RFQVaultExecutor.sol";
import {AuthenticationLib} from "../../src/common/lib/AuthenticationLib.sol";
import {CurrencyLib} from "../../src/common/lib/CurrencyLib.sol";

contract RFQVaultExecutorTest is Test {
    uint256 internal constant FULFIL_DISCRIMINATOR = 1;
    uint256 internal constant REFUND_DISCRIMINATOR = 2;
    uint256 internal constant SWAP_AND_FULFIL_DISCRIMINATOR = 3;

    address internal constant NATIVE_TOKEN = CurrencyLib.NATIVE_TOKEN_ADDRESS;
    address internal constant OWNER = address(0x2222);
    address internal constant RECEIVER = address(0xB0B);
    address internal constant OTHER = address(0xCAFE);

    uint256 internal constant SOLVER_PRIVATE_KEY = 0xA11CE;
    address internal solverSigner;

    bytes32 internal constant QUOTE_ID = keccak256("quote-1");
    uint256 internal constant NONCE = 1;
    uint256 internal constant AMOUNT = 100 ether;
    uint256 internal constant SWAP_OUTPUT = 175 ether;

    RFQVaultExecutor internal vault;
    MockERC20 internal token;
    MockERC20 internal outputToken;
    MockSwap internal swapTarget;
    MockActionTarget internal actionTarget;

    function setUp() public {
        solverSigner = vm.addr(SOLVER_PRIVATE_KEY);

        vault = new RFQVaultExecutor(OWNER, solverSigner);
        token = new MockERC20("Input", "IN");
        outputToken = new MockERC20("Output", "OUT");
        swapTarget = new MockSwap();
        actionTarget = new MockActionTarget();

        vm.label(address(vault), "vault");
        vm.label(address(token), "token");
        vm.label(address(outputToken), "outputToken");
        vm.label(address(swapTarget), "swapTarget");
        vm.label(address(actionTarget), "actionTarget");
        vm.label(RECEIVER, "receiver");
        vm.label(solverSigner, "solverSigner");
    }

    function test_receiveNative_emitsEvent() public {
        CallerStub caller = new CallerStub();
        vm.deal(address(caller), AMOUNT);

        vm.expectEmit(true, false, false, true, address(vault));
        emit RFQVaultExecutor.NativeDeposited(QUOTE_ID, AMOUNT);

        caller.sendNativeFromBalance(address(vault), QUOTE_ID, AMOUNT);
    }

    function test_receiveNative_permissionless() public {
        CallerStub otherCaller = new CallerStub();
        vm.deal(address(otherCaller), AMOUNT);

        vm.expectEmit(true, false, false, true, address(vault));
        emit RFQVaultExecutor.NativeDeposited(QUOTE_ID, AMOUNT);

        otherCaller.sendNativeFromBalance(address(vault), QUOTE_ID, AMOUNT);
    }

    function test_fulfil_erc20() public {
        token.mint(address(vault), AMOUNT);

        bytes memory signature = _signFulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);

        vm.expectEmit(false, false, false, true, address(vault));
        emit RFQVaultExecutor.Fulfilled(QUOTE_ID, address(token), AMOUNT, RECEIVER);

        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);

        assertEq(token.balanceOf(RECEIVER), AMOUNT);
        assertEq(vault.quoteIdUsed(QUOTE_ID), 1);
    }

    function test_fulfil_native() public {
        vm.deal(address(vault), AMOUNT);

        bytes memory signature = _signFulfil(QUOTE_ID, NONCE, NATIVE_TOKEN, AMOUNT, RECEIVER);

        vault.fulfil(QUOTE_ID, NONCE, NATIVE_TOKEN, AMOUNT, RECEIVER, signature);

        assertEq(RECEIVER.balance, AMOUNT);
    }

    function test_fulfil_marksQuoteId() public {
        token.mint(address(vault), AMOUNT * 2);

        bytes memory signature = _signFulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);
        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);

        vm.expectRevert(RFQVaultExecutor.InvalidQuoteId.selector);
        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);
    }

    function test_fulfil_revertsIfQuoteIdUsedByRefund() public {
        token.mint(address(vault), AMOUNT * 2);

        bytes memory refundSig = _signRefund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);
        vault.refund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, refundSig);

        bytes memory fulfilSig = _signFulfil(QUOTE_ID, NONCE + 1, address(token), AMOUNT, RECEIVER);

        vm.expectRevert(RFQVaultExecutor.InvalidQuoteId.selector);
        vault.fulfil(QUOTE_ID, NONCE + 1, address(token), AMOUNT, RECEIVER, fulfilSig);
    }

    function test_fulfil_revertsIfInvalidSigner() public {
        token.mint(address(vault), AMOUNT);

        bytes memory signature = _signFulfilWithKey(
            0xBEEF,
            QUOTE_ID,
            NONCE,
            address(token),
            AMOUNT,
            RECEIVER
        );

        vm.expectRevert(RFQVaultExecutor.InvalidSigner.selector);
        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);
    }

    function test_swapAndFulfil_erc20() public {
        token.mint(address(vault), AMOUNT);
        outputToken.mint(address(swapTarget), SWAP_OUTPUT);

        RFQVaultExecutor.Action memory swapAction = RFQVaultExecutor.Action({
            target: address(swapTarget),
            value: 0,
            data: abi.encodeCall(
                MockSwap.swapToVault,
                (address(token), address(outputToken), AMOUNT, SWAP_OUTPUT, address(vault))
            )
        });

        bytes memory signature = _signSwapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER
        );

        vault.swapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );

        assertEq(outputToken.balanceOf(RECEIVER), SWAP_OUTPUT);
        assertEq(vault.quoteIdUsed(QUOTE_ID), 1);
    }

    function test_swapAndFulfil_revertsIfSwapOutputInsufficient() public {
        token.mint(address(vault), AMOUNT);
        outputToken.mint(address(swapTarget), SWAP_OUTPUT - 1 ether);

        RFQVaultExecutor.Action memory swapAction = RFQVaultExecutor.Action({
            target: address(swapTarget),
            value: 0,
            data: abi.encodeCall(
                MockSwap.swapToVault,
                (address(token), address(outputToken), AMOUNT, SWAP_OUTPUT - 1 ether, address(vault))
            )
        });

        bytes memory signature = _signSwapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER
        );

        vm.expectRevert(RFQVaultExecutor.SwapOutputInsufficient.selector);
        vault.swapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );
    }

    function test_swapAndFulfil_marksQuoteId() public {
        token.mint(address(vault), AMOUNT);
        outputToken.mint(address(swapTarget), SWAP_OUTPUT);

        RFQVaultExecutor.Action memory swapAction = RFQVaultExecutor.Action({
            target: address(swapTarget),
            value: 0,
            data: abi.encodeCall(
                MockSwap.swapToVault,
                (address(token), address(outputToken), AMOUNT, SWAP_OUTPUT, address(vault))
            )
        });

        bytes memory signature = _signSwapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER
        );

        vault.swapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );

        vm.expectRevert(RFQVaultExecutor.InvalidQuoteId.selector);
        vault.swapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );
    }

    function test_swapAndFulfil_revertsIfInvalidSigner() public {
        token.mint(address(vault), AMOUNT);
        outputToken.mint(address(swapTarget), SWAP_OUTPUT);

        RFQVaultExecutor.Action memory swapAction = RFQVaultExecutor.Action({
            target: address(swapTarget),
            value: 0,
            data: abi.encodeCall(
                MockSwap.swapToVault,
                (address(token), address(outputToken), AMOUNT, SWAP_OUTPUT, address(vault))
            )
        });

        bytes memory signature = _signSwapAndFulfilWithKey(
            0xBEEF,
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER
        );

        vm.expectRevert(RFQVaultExecutor.InvalidSigner.selector);
        vault.swapAndFulfil(
            QUOTE_ID,
            NONCE,
            address(token),
            address(swapTarget),
            AMOUNT,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );
    }

    function test_swapAndFulfil_skipsApprovalWhenTokenIsZero() public {
        bytes32 quoteId = keccak256("quote-skip-approval");
        uint256 approveNonce = 99;

        token.mint(address(vault), AMOUNT);
        outputToken.mint(address(swapTarget), SWAP_OUTPUT);

        RFQVaultExecutor.Action[] memory approveActions = new RFQVaultExecutor.Action[](1);
        approveActions[0] = RFQVaultExecutor.Action({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(0x095ea7b3, address(swapTarget), AMOUNT)
        });

        bytes memory approveSig = _signPerformActions(approveNonce, approveActions);
        vault.performActions(approveNonce, approveActions, approveSig);

        RFQVaultExecutor.Action memory swapAction = RFQVaultExecutor.Action({
            target: address(swapTarget),
            value: 0,
            data: abi.encodeCall(
                MockSwap.swapToVault,
                (address(token), address(outputToken), AMOUNT, SWAP_OUTPUT, address(vault))
            )
        });

        bytes memory signature = _signSwapAndFulfil(
            quoteId,
            NONCE,
            address(0),
            address(0),
            0,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER
        );

        vault.swapAndFulfil(
            quoteId,
            NONCE,
            address(0),
            address(0),
            0,
            address(outputToken),
            SWAP_OUTPUT,
            swapAction,
            RECEIVER,
            signature
        );

        assertEq(outputToken.balanceOf(RECEIVER), SWAP_OUTPUT);
    }

    function test_refund_erc20() public {
        token.mint(address(vault), AMOUNT);

        bytes memory signature = _signRefund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);

        vm.expectEmit(true, false, false, true, address(vault));
        emit RFQVaultExecutor.Refunded(QUOTE_ID, address(token), AMOUNT, RECEIVER);

        vault.refund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);

        assertEq(token.balanceOf(RECEIVER), AMOUNT);
    }

    function test_refund_native() public {
        vm.deal(address(vault), AMOUNT);

        bytes memory signature = _signRefund(QUOTE_ID, NONCE, NATIVE_TOKEN, AMOUNT, RECEIVER);

        vault.refund(QUOTE_ID, NONCE, NATIVE_TOKEN, AMOUNT, RECEIVER, signature);

        assertEq(RECEIVER.balance, AMOUNT);
    }

    function test_refund_marksQuoteId() public {
        token.mint(address(vault), AMOUNT * 2);

        bytes memory signature = _signRefund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);
        vault.refund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);

        vm.expectRevert(RFQVaultExecutor.InvalidQuoteId.selector);
        vault.refund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);
    }

    function test_refund_revertsIfQuoteIdUsedByFulfil() public {
        token.mint(address(vault), AMOUNT * 2);

        bytes memory fulfilSig = _signFulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);
        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, fulfilSig);

        bytes memory refundSig = _signRefund(QUOTE_ID, NONCE + 1, address(token), AMOUNT, RECEIVER);

        vm.expectRevert(RFQVaultExecutor.InvalidQuoteId.selector);
        vault.refund(QUOTE_ID, NONCE + 1, address(token), AMOUNT, RECEIVER, refundSig);
    }

    function test_refund_revertsIfInvalidSigner() public {
        token.mint(address(vault), AMOUNT);

        bytes memory signature = _signRefundWithKey(0xBEEF, QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);

        vm.expectRevert(RFQVaultExecutor.InvalidSigner.selector);
        vault.refund(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, signature);
    }

    function test_performActions_executesAction() public {
        RFQVaultExecutor.Action[] memory actions = new RFQVaultExecutor.Action[](1);
        actions[0] = RFQVaultExecutor.Action({
            target: address(actionTarget),
            value: 0,
            data: abi.encodeCall(MockActionTarget.setValue, (42))
        });

        bytes memory signature = _signPerformActions(NONCE, actions);

        vault.performActions(NONCE, actions, signature);

        assertEq(actionTarget.value(), 42);
        assertEq(vault.nonceUsed(NONCE), 1);
    }

    function test_performActions_marksNonce() public {
        RFQVaultExecutor.Action[] memory actions = new RFQVaultExecutor.Action[](1);
        actions[0] = RFQVaultExecutor.Action({
            target: address(actionTarget),
            value: 0,
            data: abi.encodeCall(MockActionTarget.setValue, (42))
        });

        bytes memory signature = _signPerformActions(NONCE, actions);

        vault.performActions(NONCE, actions, signature);

        vm.expectRevert(RFQVaultExecutor.InvalidNonce.selector);
        vault.performActions(NONCE, actions, signature);
    }

    function test_performActions_revertsIfActionFails() public {
        RFQVaultExecutor.Action[] memory actions = new RFQVaultExecutor.Action[](1);
        actions[0] = RFQVaultExecutor.Action({
            target: address(actionTarget),
            value: 0,
            data: abi.encodeCall(MockActionTarget.revertAlways, ())
        });

        bytes memory signature = _signPerformActions(NONCE, actions);

        vm.expectRevert(abi.encodeWithSelector(RFQVaultExecutor.ActionFailed.selector, uint256(0)));
        vault.performActions(NONCE, actions, signature);
    }

    function test_performActions_revertsIfInvalidSigner() public {
        RFQVaultExecutor.Action[] memory actions = new RFQVaultExecutor.Action[](1);
        actions[0] = RFQVaultExecutor.Action({
            target: address(actionTarget),
            value: 0,
            data: abi.encodeCall(MockActionTarget.setValue, (42))
        });

        bytes memory signature = _signPerformActionsWithKey(0xBEEF, NONCE, actions);

        vm.expectRevert(RFQVaultExecutor.InvalidSigner.selector);
        vault.performActions(NONCE, actions, signature);
    }

    function test_setSolverSigner_updatesAndOnlyOwner() public {
        address newSigner = address(0x1234);

        vm.prank(OTHER);
        vm.expectRevert();
        vault.setSolverSigner(newSigner);

        vm.prank(OWNER);
        vault.setSolverSigner(newSigner);

        token.mint(address(vault), AMOUNT);
        bytes memory oldSig = _signFulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER);

        vm.expectRevert(RFQVaultExecutor.InvalidSigner.selector);
        vault.fulfil(QUOTE_ID, NONCE, address(token), AMOUNT, RECEIVER, oldSig);
    }

    function test_rescueFunds_onlyOwner() public {
        token.mint(address(vault), AMOUNT);

        vm.prank(OTHER);
        vm.expectRevert();
        vault.rescueFunds(address(token), OWNER, AMOUNT);

        vm.prank(OWNER);
        vault.rescueFunds(address(token), OWNER, AMOUNT);

        assertEq(token.balanceOf(OWNER), AMOUNT);
    }

    function _signFulfil(
        bytes32 quoteId,
        uint256 nonce,
        address token_,
        uint256 amount,
        address receiver
    ) internal view returns (bytes memory) {
        return _signFulfilWithKey(SOLVER_PRIVATE_KEY, quoteId, nonce, token_, amount, receiver);
    }

    function _signFulfilWithKey(
        uint256 privateKey,
        bytes32 quoteId,
        uint256 nonce,
        address token_,
        uint256 amount,
        address receiver
    ) internal view returns (bytes memory) {
        bytes32 messageHash = _hashFulfilOrRefund(FULFIL_DISCRIMINATOR, quoteId, nonce, token_, amount, receiver);
        return _signMessage(privateKey, messageHash);
    }

    function _signRefund(
        bytes32 quoteId,
        uint256 nonce,
        address token_,
        uint256 amount,
        address receiver
    ) internal view returns (bytes memory) {
        return _signRefundWithKey(SOLVER_PRIVATE_KEY, quoteId, nonce, token_, amount, receiver);
    }

    function _signRefundWithKey(
        uint256 privateKey,
        bytes32 quoteId,
        uint256 nonce,
        address token_,
        uint256 amount,
        address receiver
    ) internal view returns (bytes memory) {
        bytes32 messageHash = _hashFulfilOrRefund(REFUND_DISCRIMINATOR, quoteId, nonce, token_, amount, receiver);
        return _signMessage(privateKey, messageHash);
    }

    function _signSwapAndFulfil(
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken_,
        uint256 minOutput,
        RFQVaultExecutor.Action memory swapAction,
        address receiver
    ) internal view returns (bytes memory) {
        return _signSwapAndFulfilWithKey(
            SOLVER_PRIVATE_KEY,
            quoteId,
            nonce,
            approvalToken,
            approvalSpender,
            approvalAmount,
            outputToken_,
            minOutput,
            swapAction,
            receiver
        );
    }

    function _signSwapAndFulfilWithKey(
        uint256 privateKey,
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken_,
        uint256 minOutput,
        RFQVaultExecutor.Action memory swapAction,
        address receiver
    ) internal view returns (bytes memory) {
        bytes32 messageHash = _hashSwapAndFulfilAt(
            address(vault),
            quoteId,
            nonce,
            approvalToken,
            approvalSpender,
            approvalAmount,
            outputToken_,
            minOutput,
            swapAction,
            receiver
        );
        return _signMessage(privateKey, messageHash);
    }

    function _signPerformActions(uint256 nonce, RFQVaultExecutor.Action[] memory actions)
        internal
        view
        returns (bytes memory)
    {
        return _signPerformActionsWithKey(SOLVER_PRIVATE_KEY, nonce, actions);
    }

    function _signPerformActionsWithKey(
        uint256 privateKey,
        uint256 nonce,
        RFQVaultExecutor.Action[] memory actions
    ) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(abi.encode(block.chainid, address(vault), nonce, actions));
        return _signMessage(privateKey, messageHash);
    }

    function _signMessage(uint256 privateKey, bytes32 messageHash) internal pure returns (bytes memory) {
        bytes32 ethSigned = AuthenticationLib.getEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _hashFulfilOrRefund(
        uint256 discriminator,
        bytes32 quoteId,
        uint256 nonce,
        address token_,
        uint256 amount,
        address receiver
    ) internal view returns (bytes32 hash) {
        address vaultAddress = address(vault);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainid())
            mstore(add(ptr, 0x20), vaultAddress)
            mstore(add(ptr, 0x40), discriminator)
            mstore(add(ptr, 0x60), quoteId)
            mstore(add(ptr, 0x80), nonce)
            mstore(add(ptr, 0xa0), token_)
            mstore(add(ptr, 0xc0), amount)
            mstore(add(ptr, 0xe0), receiver)
            hash := keccak256(ptr, 0x100)
            mstore(0x40, add(ptr, 0x100))
        }
    }

    function _hashSwapAndFulfil(
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken_,
        uint256 minOutput,
        RFQVaultExecutor.Action memory swapAction,
        address receiver
    ) internal view returns (bytes32 hash) {
        return _hashSwapAndFulfilAt(
            address(vault),
            quoteId,
            nonce,
            approvalToken,
            approvalSpender,
            approvalAmount,
            outputToken_,
            minOutput,
            swapAction,
            receiver
        );
    }

    function _hashSwapAndFulfilAt(
        address vaultAddress,
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken_,
        uint256 minOutput,
        RFQVaultExecutor.Action memory swapAction,
        address receiver
    ) internal view returns (bytes32 hash) {
        bytes32 dataHash = keccak256(swapAction.data);

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainid())
            mstore(add(ptr, 0x20), vaultAddress)
            mstore(add(ptr, 0x40), SWAP_AND_FULFIL_DISCRIMINATOR)
            mstore(add(ptr, 0x60), quoteId)
            mstore(add(ptr, 0x80), nonce)
            mstore(add(ptr, 0xa0), approvalToken)
            mstore(add(ptr, 0xc0), approvalSpender)
            mstore(add(ptr, 0xe0), approvalAmount)
            mstore(add(ptr, 0x100), outputToken_)
            mstore(add(ptr, 0x120), minOutput)
            mstore(add(ptr, 0x140), mload(swapAction))
            mstore(add(ptr, 0x160), mload(add(swapAction, 0x20)))
            mstore(add(ptr, 0x180), dataHash)
            mstore(add(ptr, 0x1a0), receiver)
            hash := keccak256(ptr, 0x1c0)
            mstore(0x40, add(ptr, 0x1c0))
        }
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

contract MockSwap {
    function swapToVault(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        address vault
    ) external {
        ERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        ERC20(outputToken).transfer(vault, outputAmount);
    }
}

contract MockActionTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }

    function revertAlways() external pure {
        revert("fail");
    }
}

contract CallerStub {
    function sendNativeFromBalance(address vault, bytes32 quoteId, uint256 amount) external {
        RFQVaultExecutor(payable(vault)).receiveNative{value: amount}(quoteId);
    }
}
