// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {BungeeOpenRouterV2Unchecked as Router} from "../../src/combined/BungeeOpenRouterV2Unchecked.sol";
import {ALLOWANCE_HOLDER, IAllowanceHolder} from "../../src/common/interfaces/IAllowanceHolder.sol";

abstract contract BungeeOpenRouterV2UncheckedTestBase is Test {
    uint256 internal constant FEE_FLAG_BIT_MASK = 0x01;
    uint256 internal constant BALANCE_FLAG_BIT_MASK = 0x02;
    uint256 internal constant BRIDGE_VALUE_FLAG_BIT_MASK = 0x04;
    uint256 internal constant BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK = 0x08;
    uint256 internal constant BRIDGE_AMOUNT_POSITION_SHIFT = 16;
    uint256 internal constant BRIDGE_AMOUNT_CALLDATA_OFFSET = 36;

    address internal constant NATIVE_TOKEN = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    address internal constant USER = address(0xA11CE);
    address internal constant RECEIVER = address(0xB0B);
    address internal constant FEE_RECIPIENT = address(0xFEE);

    uint256 internal constant INPUT_AMOUNT = 100 ether;
    uint256 internal constant SWAP_OUTPUT_AMOUNT = 175 ether;
    uint256 internal constant FEE_AMOUNT = 7 ether;

    Router internal router;
    MockERC20 internal inputToken;
    MockERC20 internal outputToken;
    MockSwap internal swapTarget;
    MockBridge internal bridgeTarget;

    struct Balances {
        uint256 user;
        uint256 router;
        uint256 swapTarget;
        uint256 bridgeTarget;
        uint256 receiver;
        uint256 feeRecipient;
        uint256 allowanceHolder;
        uint256 testContract;
    }

    struct SwapParams {
        address input;
        uint256 inputAmount;
        uint256 value;
        address receiver;
        uint256 flags;
        Router.FeeData fee;
        Router.SwapData swapData;
        bytes swapCallData;
    }

    struct SwapAndBridgeParams {
        address input;
        uint256 inputAmount;
        uint256 value;
        uint256 flags;
        Router.FeeData fee;
        Router.SwapData swapData;
        bytes swapCallData;
        Router.BridgeData bridgeData;
        bytes bridgeCallData;
    }

    function setUp() public virtual {
        vm.etch(address(ALLOWANCE_HOLDER), address(new MockAllowanceHolder()).code);

        router = new Router(address(this));
        inputToken = new MockERC20("Input Token", "IN");
        outputToken = new MockERC20("Output Token", "OUT");
        swapTarget = new MockSwap();
        bridgeTarget = new MockBridge();

        vm.label(address(router), "router");
        vm.label(address(inputToken), "inputToken");
        vm.label(address(outputToken), "outputToken");
        vm.label(address(swapTarget), "swapTarget");
        vm.label(address(bridgeTarget), "bridgeTarget");
        vm.label(address(ALLOWANCE_HOLDER), "allowanceHolder");
        vm.label(USER, "user");
        vm.label(RECEIVER, "receiver");
        vm.label(FEE_RECIPIENT, "feeRecipient");
    }

    function _approveInputToken(uint256 amount) internal {
        vm.prank(USER);
        inputToken.approve(address(ALLOWANCE_HOLDER), amount);
    }

    function _execThroughAllowanceHolder(address token, uint256 amount, uint256 value, bytes memory data)
        internal
        returns (bytes memory result)
    {
        vm.prank(USER);
        result = IAllowanceHolder(address(ALLOWANCE_HOLDER)).exec{value: value}(
            address(router), token, amount, payable(address(router)), data
        );
    }

    function _execSwap(SwapParams memory params) internal returns (uint256 finalAmount) {
        bytes memory result = _execThroughAllowanceHolder(
            params.input,
            params.inputAmount,
            params.value,
            abi.encodeCall(
                router.swap,
                (
                    keccak256("swap"),
                    Router.InputData({user: USER, inputToken: params.input, inputAmount: params.inputAmount}),
                    params.receiver,
                    params.flags,
                    params.fee,
                    params.swapData,
                    params.swapCallData
                )
            )
        );
        finalAmount = abi.decode(result, (uint256));
    }

    function _execBridge(
        address input,
        uint256 inputAmount,
        uint256 value,
        Router.FeeData memory fee,
        Router.BridgeData memory bridgeData,
        bytes memory bridgeCallData
    ) internal {
        _execThroughAllowanceHolder(
            input,
            inputAmount,
            value,
            abi.encodeCall(
                router.bridge,
                (
                    keccak256("bridge"),
                    Router.InputData({user: USER, inputToken: input, inputAmount: inputAmount}),
                    fee,
                    bridgeData,
                    bridgeCallData
                )
            )
        );
    }

    function _execSwapAndBridge(SwapAndBridgeParams memory params) internal {
        _execThroughAllowanceHolder(
            params.input,
            params.inputAmount,
            params.value,
            abi.encodeCall(
                router.swapAndBridge,
                (
                    keccak256("swap-and-bridge"),
                    Router.InputData({user: USER, inputToken: params.input, inputAmount: params.inputAmount}),
                    params.flags,
                    params.fee,
                    params.swapData,
                    params.swapCallData,
                    params.bridgeData,
                    params.bridgeCallData
                )
            )
        );
    }

    function _swapData(address input, address output, uint256 outputAmount, bool useReturnData)
        internal
        view
        returns (Router.SwapData memory)
    {
        return Router.SwapData({
            target: address(swapTarget),
            approvalSpender: input == NATIVE_TOKEN ? address(0) : address(swapTarget),
            outputToken: output,
            value: input == NATIVE_TOKEN ? INPUT_AMOUNT : 0,
            minOutput: outputAmount,
            returnDataWordOffset: useReturnData ? 0 : 0
        });
    }

    function _swapDataWithValue(address input, address output, uint256 outputAmount, uint256 value)
        internal
        view
        returns (Router.SwapData memory)
    {
        return Router.SwapData({
            target: address(swapTarget),
            approvalSpender: input == NATIVE_TOKEN ? address(0) : address(swapTarget),
            outputToken: output,
            value: value,
            minOutput: outputAmount,
            returnDataWordOffset: 0
        });
    }

    function _bridgeData(address token, uint256 value) internal view returns (Router.BridgeData memory) {
        return Router.BridgeData({
            target: address(bridgeTarget),
            approvalSpender: token == NATIVE_TOKEN ? address(0) : address(bridgeTarget),
            value: value
        });
    }

    function _swapCallData(address input, address output, uint256 inputAmount, uint256 outputAmount, address receiver)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(MockSwap.swap, (input, output, inputAmount, outputAmount, receiver));
    }

    function _swapNoReturnCallData(
        address input,
        address output,
        uint256 inputAmount,
        uint256 outputAmount,
        address receiver
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwap.swapNoReturn, (input, output, inputAmount, outputAmount, receiver));
    }

    function _bridgeCallData(address token, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(MockBridge.bridge, (token, amount));
    }

    function _bridgeAmountSpliceFlags(uint256 baseFlags) internal pure returns (uint256) {
        return baseFlags | BRIDGE_AMOUNT_POSITION_FLAG_BIT_MASK
            | (BRIDGE_AMOUNT_CALLDATA_OFFSET << BRIDGE_AMOUNT_POSITION_SHIFT);
    }

    function _assertTokenBalances(address token, Balances memory expected, string memory label) internal view {
        assertEq(_balanceOf(token, USER), expected.user, string.concat(label, ": user"));
        assertEq(_balanceOf(token, address(router)), expected.router, string.concat(label, ": router"));
        assertEq(_balanceOf(token, address(swapTarget)), expected.swapTarget, string.concat(label, ": swap"));
        assertEq(_balanceOf(token, address(bridgeTarget)), expected.bridgeTarget, string.concat(label, ": bridge"));
        assertEq(_balanceOf(token, RECEIVER), expected.receiver, string.concat(label, ": receiver"));
        assertEq(_balanceOf(token, FEE_RECIPIENT), expected.feeRecipient, string.concat(label, ": fee recipient"));
        assertEq(
            _balanceOf(token, address(ALLOWANCE_HOLDER)),
            expected.allowanceHolder,
            string.concat(label, ": allowance holder")
        );
        assertEq(_balanceOf(token, address(this)), expected.testContract, string.concat(label, ": test contract"));
    }

    function _balanceOf(address token, address account) internal view returns (uint256) {
        if (token == NATIVE_TOKEN) return account.balance;
        return ERC20(token).balanceOf(account);
    }

    function _emptyBalances() internal pure returns (Balances memory balances) {}

    function _emptyBalancesFor(address token) internal view returns (Balances memory balances) {
        if (token == NATIVE_TOKEN) balances.testContract = address(this).balance;
    }

    function _deal(address token, address account, uint256 amount) internal {
        if (token == NATIVE_TOKEN) {
            vm.deal(account, amount);
        } else {
            MockERC20(token).mint(account, amount);
        }
    }
}

contract MockAllowanceHolder {
    function exec(address, address, uint256, address payable target, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        (bool success, bytes memory returndata) = target.call{value: msg.value}(bytes.concat(data, bytes20(msg.sender)));
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }
        return returndata;
    }

    function transferFrom(address token, address owner, address recipient, uint256 amount) external returns (bool) {
        require(ERC20(token).transferFrom(owner, recipient, amount), "MockAllowanceHolder: transfer failed");
        return true;
    }
}

contract MockSwap {
    address public storedInputToken;
    uint256 public storedInputAmount;

    receive() external payable {}

    function swap(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, address receiver)
        external
        payable
        returns (uint256)
    {
        _swap(inputToken, outputToken, inputAmount, outputAmount, receiver);
        return outputAmount;
    }

    function swapNoReturn(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        address receiver
    ) external payable {
        _swap(inputToken, outputToken, inputAmount, outputAmount, receiver);
    }

    function _swap(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, address receiver)
        internal
    {
        storedInputToken = inputToken;
        storedInputAmount += inputAmount;

        if (inputToken == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)) {
            require(msg.value == inputAmount, "MockSwap: bad native input");
        } else {
            require(msg.value == 0, "MockSwap: unexpected value");
            require(ERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount), "MockSwap: input failed");
        }

        if (outputToken == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)) {
            (bool success,) = receiver.call{value: outputAmount}("");
            require(success, "MockSwap: native output failed");
        } else {
            require(ERC20(outputToken).transfer(receiver, outputAmount), "MockSwap: output failed");
        }
    }
}

contract MockBridge {
    address public receivedToken;
    uint256 public receivedAmount;

    receive() external payable {}

    function bridge(address token, uint256 amount) external payable {
        receivedToken = token;
        receivedAmount += amount;

        if (token == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)) {
            require(msg.value == amount, "MockBridge: bad native amount");
        } else {
            require(msg.value == 0, "MockBridge: unexpected value");
            require(ERC20(token).transferFrom(msg.sender, address(this), amount), "MockBridge: transfer failed");
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
