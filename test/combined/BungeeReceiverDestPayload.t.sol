// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {BungeeReceiver} from "../../src/BungeeReceiver.sol";
import {CalldataExecutor} from "../../src/CalldataExecutor.sol";
import {AuthenticationLib} from "../../src/common/lib/AuthenticationLib.sol";
import {IBungeeExecutor} from "../../src/interfaces/IBungeeExecutor.sol";

/// @dev End-to-end test for the simplified destination payload path:
///      bridge deposit → signed executeDestPayload → transfer to executor → executeData.
contract BungeeReceiverDestPayloadTest is Test {
    uint256 internal constant SOLVER_PRIVATE_KEY = 0xA11CE;
    uint256 internal constant OUTPUT_AMOUNT = 100 ether;
    uint256 internal constant GAS_LIMIT = 500_000;

    address internal solverSigner;
    BungeeReceiver internal receiver;
    CalldataExecutor internal calldataExecutor;
    MockBungeeExecutor internal executor;
    MockERC20 internal bridgedToken;

    bytes32 internal constant QUOTE_ID = keccak256("quote-1");
    bytes internal executionCallData = hex"deadbeef";

    function setUp() public {
        solverSigner = vm.addr(SOLVER_PRIVATE_KEY);

        uint64 deployNonce = vm.getNonce(address(this));
        address predictedReceiver = vm.computeCreateAddress(address(this), deployNonce + 1);

        calldataExecutor = new CalldataExecutor(predictedReceiver);
        receiver = new BungeeReceiver(address(this), solverSigner, address(calldataExecutor));

        assertEq(address(receiver), predictedReceiver);

        executor = new MockBungeeExecutor();
        bridgedToken = new MockERC20("Bridged Token", "BRG");

        vm.label(address(receiver), "bungeeReceiver");
        vm.label(address(calldataExecutor), "calldataExecutor");
        vm.label(address(executor), "bungeeExecutor");
        vm.label(address(bridgedToken), "bridgedToken");
        vm.label(solverSigner, "solverSigner");
    }

    function test_executeDestPayload_transfersFundsAndCallsExecutor() public {
        _depositBridgedFunds();

        BungeeReceiver.DestPayload memory payload = _buildPayload(1);
        bytes memory signature = _signPayload(payload, executionCallData);

        vm.expectEmit(true, false, false, true, address(receiver));
        emit BungeeReceiver.DestPayloadExecuted(QUOTE_ID, true);

        receiver.executeDestPayload(payload, executionCallData, signature);

        assertEq(bridgedToken.balanceOf(address(receiver)), 0);
        assertEq(bridgedToken.balanceOf(address(executor)), OUTPUT_AMOUNT);
        assertEq(executor.lastQuoteId(), QUOTE_ID);
        assertEq(executor.lastAmount(), OUTPUT_AMOUNT);
        assertEq(executor.lastToken(), address(bridgedToken));
        assertEq(executor.lastCallData(), executionCallData);
        assertTrue(receiver.nonceUsed(1));
    }

    function test_executeDestPayload_revertsWhenTargetIsZero() public {
        BungeeReceiver.DestPayload memory payload = _buildPayload(1);
        payload.target = address(0);
        bytes memory signature = _signPayload(payload, executionCallData);

        vm.expectRevert(BungeeReceiver.InvalidExecution.selector);
        receiver.executeDestPayload(payload, executionCallData, signature);
    }

    function test_executeDestPayload_revertsOnInvalidSigner() public {
        _depositBridgedFunds();

        BungeeReceiver.DestPayload memory payload = _buildPayload(1);
        bytes32 messageHash = _messageHash(payload, executionCallData);
        bytes32 ethSignedMessageHash = AuthenticationLib.getEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PRIVATE_KEY + 1, ethSignedMessageHash);
        bytes memory badSignature = abi.encodePacked(r, s, v);

        vm.expectRevert(BungeeReceiver.InvalidSigner.selector);
        receiver.executeDestPayload(payload, executionCallData, badSignature);
    }

    function test_executeDestPayload_revertsOnNonceReuse() public {
        _depositBridgedFunds();

        BungeeReceiver.DestPayload memory payload = _buildPayload(1);
        bytes memory signature = _signPayload(payload, executionCallData);

        receiver.executeDestPayload(payload, executionCallData, signature);

        vm.expectRevert(BungeeReceiver.InvalidNonce.selector);
        receiver.executeDestPayload(payload, executionCallData, signature);
    }

    function test_executeDestPayload_emitsFailureWhenExecutorReverts() public {
        _depositBridgedFunds();

        executor.setShouldRevert(true);

        BungeeReceiver.DestPayload memory payload = _buildPayload(2);
        bytes memory signature = _signPayload(payload, executionCallData);

        vm.expectEmit(true, false, false, true, address(receiver));
        emit BungeeReceiver.DestPayloadExecuted(QUOTE_ID, false);

        receiver.executeDestPayload(payload, executionCallData, signature);

        assertEq(bridgedToken.balanceOf(address(executor)), OUTPUT_AMOUNT);
        assertFalse(executor.wasCalled());
    }

    function _depositBridgedFunds() internal {
        bridgedToken.mint(address(receiver), OUTPUT_AMOUNT);
    }

    function _buildPayload(uint256 nonce) internal view returns (BungeeReceiver.DestPayload memory payload) {
        payload = BungeeReceiver.DestPayload({
            nonce: nonce,
            quoteId: QUOTE_ID,
            bridgedToken: address(bridgedToken),
            target: address(executor),
            outputAmount: OUTPUT_AMOUNT,
            gasLimit: GAS_LIMIT
        });
    }

    function _messageHash(BungeeReceiver.DestPayload memory payload, bytes memory callData)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(receiver), payload, keccak256(callData)));
    }

    function _signPayload(BungeeReceiver.DestPayload memory payload, bytes memory callData)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 messageHash = _messageHash(payload, callData);
        bytes32 ethSignedMessageHash = AuthenticationLib.getEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PRIVATE_KEY, ethSignedMessageHash);
        signature = abi.encodePacked(r, s, v);
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

contract MockBungeeExecutor is IBungeeExecutor {
    bytes32 public lastQuoteId;
    uint256 public lastAmount;
    address public lastToken;
    bytes public lastCallData;
    bool public wasCalled;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function executeData(bytes32 quoteId, uint256 amount, address token, bytes calldata callData) external payable {
        if (shouldRevert) {
            revert("executor revert");
        }

        wasCalled = true;
        lastQuoteId = quoteId;
        lastAmount = amount;
        lastToken = token;
        lastCallData = callData;
    }

    receive() external payable {}
}
