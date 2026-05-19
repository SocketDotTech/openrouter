// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {BungeeOpenRouter as Router} from "../../src/BungeeOpenRouter.sol";
import {BungeeOpenRouterV2UncheckedTestBase} from "./BungeeOpenRouterV2UncheckedTestBase.sol";

contract BungeeOpenRouterV2UncheckedSwapTest is BungeeOpenRouterV2UncheckedTestBase {
    function test_swapWithReturnData() public {
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertERC20Balances(address(inputToken), INPUT_AMOUNT, 0, 0, 0, "before input token");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");
        _assertNativeBalances(0, 0, 0, 0, "before native");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                value: 0,
                receiver: RECEIVER,
                flags: 0,
                fee: _feeData(0),
                swapData: _swapData(address(inputToken), address(outputToken), SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(
                    address(inputToken), address(outputToken), INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, RECEIVER
                )
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertERC20Balances(address(inputToken), 0, INPUT_AMOUNT, 0, 0, "after input token");
        _assertERC20Balances(address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT, 0, "after output token");
        _assertNativeBalances(0, 0, 0, 0, "after native");
        _assertSwapInput(address(inputToken), INPUT_AMOUNT);
    }

    function test_swapWithoutReturnDataUsesBalanceDelta() public {
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertERC20Balances(address(inputToken), INPUT_AMOUNT, 0, 0, 0, "before input token");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");
        _assertNativeBalances(0, 0, 0, 0, "before native");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                value: 0,
                receiver: RECEIVER,
                flags: BALANCE_FLAG_BIT_MASK,
                fee: _feeData(0),
                swapData: _swapData(address(inputToken), address(outputToken), SWAP_OUTPUT_AMOUNT, false),
                swapCallData: _swapNoReturnCallData(
                    address(inputToken), address(outputToken), INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, RECEIVER
                )
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertERC20Balances(address(inputToken), 0, INPUT_AMOUNT, 0, 0, "after input token");
        _assertERC20Balances(address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT, 0, "after output token");
        _assertNativeBalances(0, 0, 0, 0, "after native");
        _assertSwapInput(address(inputToken), INPUT_AMOUNT);
    }

    function test_swapERC20ToNative() public {
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _deal(NATIVE_TOKEN, address(swapTarget), SWAP_OUTPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertERC20Balances(address(inputToken), INPUT_AMOUNT, 0, 0, 0, "before input token");
        _assertNativeBalances(0, SWAP_OUTPUT_AMOUNT, 0, 0, "before native");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                value: 0,
                receiver: RECEIVER,
                flags: 0,
                fee: _feeData(0),
                swapData: _swapData(address(inputToken), NATIVE_TOKEN, SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(address(inputToken), NATIVE_TOKEN, INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, RECEIVER)
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertERC20Balances(address(inputToken), 0, INPUT_AMOUNT, 0, 0, "after input token");
        _assertNativeBalances(0, 0, SWAP_OUTPUT_AMOUNT, 0, "after native");

        _assertSwapInput(address(inputToken), INPUT_AMOUNT);
    }

    function test_swapNativeToERC20() public {
        _deal(NATIVE_TOKEN, USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);

        _assertNativeBalances(INPUT_AMOUNT, 0, 0, 0, "before native");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: NATIVE_TOKEN,
                inputAmount: INPUT_AMOUNT,
                value: INPUT_AMOUNT,
                receiver: RECEIVER,
                flags: 0,
                fee: _feeData(0),
                swapData: _swapData(NATIVE_TOKEN, address(outputToken), SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(NATIVE_TOKEN, address(outputToken), INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, RECEIVER)
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertNativeBalances(0, INPUT_AMOUNT, 0, 0, "after native");
        _assertERC20Balances(address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT, 0, "after output token");

        _assertSwapInput(NATIVE_TOKEN, INPUT_AMOUNT);
    }

    function test_swapERC20ToERC20() public {
        test_swapWithReturnData();
    }

    function test_prefeeSwapWithNativeFee() public {
        uint256 swapInput = INPUT_AMOUNT - FEE_AMOUNT;

        _deal(NATIVE_TOKEN, USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);

        _assertNativeBalances(INPUT_AMOUNT, 0, 0, 0, "before native");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: NATIVE_TOKEN,
                inputAmount: INPUT_AMOUNT,
                value: INPUT_AMOUNT,
                receiver: RECEIVER,
                flags: 0,
                fee: _feeData(FEE_AMOUNT),
                swapData: _swapDataWithValue(NATIVE_TOKEN, address(outputToken), SWAP_OUTPUT_AMOUNT, swapInput),
                swapCallData: _swapCallData(NATIVE_TOKEN, address(outputToken), swapInput, SWAP_OUTPUT_AMOUNT, RECEIVER)
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertNativeBalances(0, swapInput, 0, FEE_AMOUNT, "after native");
        _assertERC20Balances(address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT, 0, "after output token");

        _assertSwapInput(NATIVE_TOKEN, swapInput);
    }

    function test_prefeeSwapWithERC20Fee() public {
        uint256 swapInput = INPUT_AMOUNT - FEE_AMOUNT;

        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertERC20Balances(address(inputToken), INPUT_AMOUNT, 0, 0, 0, "before input token");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");
        _assertNativeBalances(0, 0, 0, 0, "before native");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                value: 0,
                receiver: RECEIVER,
                flags: 0,
                fee: _feeData(FEE_AMOUNT),
                swapData: _swapData(address(inputToken), address(outputToken), SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(
                    address(inputToken), address(outputToken), swapInput, SWAP_OUTPUT_AMOUNT, RECEIVER
                )
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT, "final amount");

        _assertERC20Balances(address(inputToken), 0, swapInput, 0, FEE_AMOUNT, "after input token");
        _assertERC20Balances(address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT, 0, "after output token");
        _assertNativeBalances(0, 0, 0, 0, "after native");
        _assertSwapInput(address(inputToken), swapInput);
    }

    function test_postfeeSwapWithNativeFee() public {
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _deal(NATIVE_TOKEN, address(swapTarget), SWAP_OUTPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertERC20Balances(address(inputToken), INPUT_AMOUNT, 0, 0, 0, "before input token");
        _assertNativeBalances(0, SWAP_OUTPUT_AMOUNT, 0, 0, "before native");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                value: 0,
                receiver: RECEIVER,
                flags: FEE_FLAG_BIT_MASK,
                fee: _feeData(FEE_AMOUNT),
                swapData: _swapData(address(inputToken), NATIVE_TOKEN, SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(
                    address(inputToken), NATIVE_TOKEN, INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, address(router)
                )
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT - FEE_AMOUNT, "final amount");

        _assertERC20Balances(address(inputToken), 0, INPUT_AMOUNT, 0, 0, "after input token");
        _assertNativeBalances(0, 0, SWAP_OUTPUT_AMOUNT - FEE_AMOUNT, FEE_AMOUNT, "after native");

        _assertSwapInput(address(inputToken), INPUT_AMOUNT);
    }

    function test_postfeeSwapWithERC20Fee() public {
        _deal(NATIVE_TOKEN, USER, INPUT_AMOUNT);
        _deal(address(outputToken), address(swapTarget), SWAP_OUTPUT_AMOUNT);

        _assertNativeBalances(INPUT_AMOUNT, 0, 0, 0, "before native");
        _assertERC20Balances(address(outputToken), 0, SWAP_OUTPUT_AMOUNT, 0, 0, "before output token");

        uint256 finalAmount = _execSwap(
            SwapParams({
                input: NATIVE_TOKEN,
                inputAmount: INPUT_AMOUNT,
                value: INPUT_AMOUNT,
                receiver: RECEIVER,
                flags: FEE_FLAG_BIT_MASK,
                fee: _feeData(FEE_AMOUNT),
                swapData: _swapData(NATIVE_TOKEN, address(outputToken), SWAP_OUTPUT_AMOUNT, true),
                swapCallData: _swapCallData(
                    NATIVE_TOKEN, address(outputToken), INPUT_AMOUNT, SWAP_OUTPUT_AMOUNT, address(router)
                )
            })
        );

        assertEq(finalAmount, SWAP_OUTPUT_AMOUNT - FEE_AMOUNT, "final amount");

        _assertNativeBalances(0, INPUT_AMOUNT, 0, 0, "after native");
        _assertERC20Balances(
            address(outputToken), 0, 0, SWAP_OUTPUT_AMOUNT - FEE_AMOUNT, FEE_AMOUNT, "after output token"
        );

        _assertSwapInput(NATIVE_TOKEN, INPUT_AMOUNT);
    }

    function _feeData(uint256 amount) private pure returns (Router.FeeData memory) {
        return Router.FeeData({receiver: FEE_RECIPIENT, amount: amount});
    }

    function _emptyNativeBalances() private view returns (Balances memory balances) {
        balances.testContract = address(this).balance;
    }

    function _assertERC20Balances(
        address token,
        uint256 user,
        uint256 swapTargetBalance,
        uint256 receiver,
        uint256 feeRecipient,
        string memory label
    ) private view {
        Balances memory balances = _emptyBalances();
        balances.user = user;
        balances.swapTarget = swapTargetBalance;
        balances.receiver = receiver;
        balances.feeRecipient = feeRecipient;
        _assertTokenBalances(token, balances, label);
    }

    function _assertNativeBalances(
        uint256 user,
        uint256 swapTargetBalance,
        uint256 receiver,
        uint256 feeRecipient,
        string memory label
    ) private view {
        Balances memory balances = _emptyNativeBalances();
        balances.user = user;
        balances.swapTarget = swapTargetBalance;
        balances.receiver = receiver;
        balances.feeRecipient = feeRecipient;
        _assertTokenBalances(NATIVE_TOKEN, balances, label);
    }

    function _assertSwapInput(address input, uint256 amount) private view {
        assertEq(swapTarget.storedInputToken(), input, "swap input token");
        assertEq(swapTarget.storedInputAmount(), amount, "swap input amount");
    }
}
