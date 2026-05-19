// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.25;

import {BungeeOpenRouterV2Unchecked as Router} from "../../src/combined/BungeeOpenRouterV2Unchecked.sol";
import {BungeeOpenRouterV2UncheckedTestBase} from "./BungeeOpenRouterV2UncheckedTestBase.sol";

contract BungeeOpenRouterV2UncheckedBridgeTest is BungeeOpenRouterV2UncheckedTestBase {
    function test_bridge_erc20() public {
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertTokenBalances(
            address(inputToken),
            Balances({
                user: INPUT_AMOUNT,
                router: 0,
                swapTarget: 0,
                bridgeTarget: 0,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: 0
            }),
            "input token initial"
        );

        _execBridge(
            address(inputToken),
            INPUT_AMOUNT,
            0,
            Router.FeeData({receiver: address(0), amount: 0}),
            _bridgeData(address(inputToken), 0),
            _bridgeCallData(address(inputToken), INPUT_AMOUNT)
        );

        _assertTokenBalances(
            address(inputToken),
            Balances({
                user: 0,
                router: 0,
                swapTarget: 0,
                bridgeTarget: INPUT_AMOUNT,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: 0
            }),
            "input token final"
        );
        assertEq(bridgeTarget.receivedToken(), address(inputToken));
        assertEq(bridgeTarget.receivedAmount(), INPUT_AMOUNT);
    }

    function test_bridge_native() public {
        vm.deal(USER, INPUT_AMOUNT);
        uint256 testContractBalance = address(this).balance;

        _assertTokenBalances(
            NATIVE_TOKEN,
            Balances({
                user: INPUT_AMOUNT,
                router: 0,
                swapTarget: 0,
                bridgeTarget: 0,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: testContractBalance
            }),
            "native initial"
        );

        _execBridge(
            NATIVE_TOKEN,
            INPUT_AMOUNT,
            INPUT_AMOUNT,
            Router.FeeData({receiver: address(0), amount: 0}),
            _bridgeData(NATIVE_TOKEN, INPUT_AMOUNT),
            _bridgeCallData(NATIVE_TOKEN, INPUT_AMOUNT)
        );

        _assertTokenBalances(
            NATIVE_TOKEN,
            Balances({
                user: 0,
                router: 0,
                swapTarget: 0,
                bridgeTarget: INPUT_AMOUNT,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: testContractBalance
            }),
            "native final"
        );
        assertEq(bridgeTarget.receivedToken(), NATIVE_TOKEN);
        assertEq(bridgeTarget.receivedAmount(), INPUT_AMOUNT);
    }

    function test_bridge_withErc20Fee() public {
        uint256 bridgeAmount = INPUT_AMOUNT - FEE_AMOUNT;
        _deal(address(inputToken), USER, INPUT_AMOUNT);
        _approveInputToken(INPUT_AMOUNT);

        _assertTokenBalances(
            address(inputToken),
            Balances({
                user: INPUT_AMOUNT,
                router: 0,
                swapTarget: 0,
                bridgeTarget: 0,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: 0
            }),
            "input token initial"
        );

        _execBridge(
            address(inputToken),
            INPUT_AMOUNT,
            0,
            Router.FeeData({receiver: FEE_RECIPIENT, amount: FEE_AMOUNT}),
            _bridgeData(address(inputToken), 0),
            _bridgeCallData(address(inputToken), bridgeAmount)
        );

        _assertTokenBalances(
            address(inputToken),
            Balances({
                user: 0,
                router: 0,
                swapTarget: 0,
                bridgeTarget: bridgeAmount,
                receiver: 0,
                feeRecipient: FEE_AMOUNT,
                allowanceHolder: 0,
                testContract: 0
            }),
            "input token final"
        );
        assertEq(bridgeTarget.receivedToken(), address(inputToken));
        assertEq(bridgeTarget.receivedAmount(), bridgeAmount);
    }

    function test_bridge_withNativeFee() public {
        uint256 bridgeAmount = INPUT_AMOUNT - FEE_AMOUNT;
        vm.deal(USER, INPUT_AMOUNT);
        uint256 testContractBalance = address(this).balance;

        _assertTokenBalances(
            NATIVE_TOKEN,
            Balances({
                user: INPUT_AMOUNT,
                router: 0,
                swapTarget: 0,
                bridgeTarget: 0,
                receiver: 0,
                feeRecipient: 0,
                allowanceHolder: 0,
                testContract: testContractBalance
            }),
            "native initial"
        );

        _execBridge(
            NATIVE_TOKEN,
            INPUT_AMOUNT,
            INPUT_AMOUNT,
            Router.FeeData({receiver: FEE_RECIPIENT, amount: FEE_AMOUNT}),
            _bridgeData(NATIVE_TOKEN, bridgeAmount),
            _bridgeCallData(NATIVE_TOKEN, bridgeAmount)
        );

        _assertTokenBalances(
            NATIVE_TOKEN,
            Balances({
                user: 0,
                router: 0,
                swapTarget: 0,
                bridgeTarget: bridgeAmount,
                receiver: 0,
                feeRecipient: FEE_AMOUNT,
                allowanceHolder: 0,
                testContract: testContractBalance
            }),
            "native final"
        );
        assertEq(bridgeTarget.receivedToken(), NATIVE_TOKEN);
        assertEq(bridgeTarget.receivedAmount(), bridgeAmount);
    }
}
