// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {OpenRouter as Router} from "../../src/OpenRouter.sol";
import {OpenRouterV2UncheckedTestBase} from "./OpenRouterV2UncheckedTestBase.sol";

contract OpenRouterV2UncheckedSwapAndBridgeTest is OpenRouterV2UncheckedTestBase {
    enum FeeMode {
        None,
        Pre,
        Post
    }

    struct Scenario {
        address input;
        address output;
        FeeMode feeMode;
        bool balanceDelta;
        uint256 swapInput;
        uint256 bridgeAmount;
    }

    function test_swapAndBridge_noFee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.None, false);
    }

    function test_swapAndBridge_noFee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.None, false);
    }

    function test_swapAndBridge_noFee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.None, false);
    }

    function test_swapAndBridge_prefee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.Pre, false);
    }

    function test_swapAndBridge_prefee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.Pre, false);
    }

    function test_swapAndBridge_prefee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.Pre, false);
    }

    function test_swapAndBridge_postfee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.Post, false);
    }

    function test_swapAndBridge_postfee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.Post, false);
    }

    function test_swapAndBridge_postfee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.Post, false);
    }

    function test_swapAndBridge_balanceDelta_noFee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.None, true);
    }

    function test_swapAndBridge_balanceDelta_noFee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.None, true);
    }

    function test_swapAndBridge_balanceDelta_noFee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.None, true);
    }

    function test_swapAndBridge_balanceDelta_prefee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.Pre, true);
    }

    function test_swapAndBridge_balanceDelta_prefee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.Pre, true);
    }

    function test_swapAndBridge_balanceDelta_prefee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.Pre, true);
    }

    function test_swapAndBridge_balanceDelta_postfee_erc20ToNative() public {
        _runSwapAndBridge(address(inputToken), NATIVE_TOKEN, FeeMode.Post, true);
    }

    function test_swapAndBridge_balanceDelta_postfee_nativeToErc20() public {
        _runSwapAndBridge(NATIVE_TOKEN, address(outputToken), FeeMode.Post, true);
    }

    function test_swapAndBridge_balanceDelta_postfee_erc20ToErc20() public {
        _runSwapAndBridge(address(inputToken), address(outputToken), FeeMode.Post, true);
    }

    function _runSwapAndBridge(address input, address output, FeeMode feeMode, bool balanceDelta) internal {
        Scenario memory scenario = _scenario(input, output, feeMode, balanceDelta);

        _fundSwapAndBridge(scenario.input, scenario.output);
        if (scenario.input != NATIVE_TOKEN) _approveInputToken(INPUT_AMOUNT);

        _assertSwapAndBridgeInitial(scenario.input, scenario.output);
        _executeSwapAndBridge(scenario);
        _assertSwapAndBridgeFinal(scenario);

        assertEq(swapTarget.storedInputToken(), scenario.input);
        assertEq(swapTarget.storedInputAmount(), scenario.swapInput);
        assertEq(bridgeTarget.receivedToken(), scenario.output);
        assertEq(bridgeTarget.receivedAmount(), scenario.bridgeAmount);
    }

    function _scenario(address input, address output, FeeMode feeMode, bool balanceDelta)
        internal
        pure
        returns (Scenario memory scenario)
    {
        scenario.input = input;
        scenario.output = output;
        scenario.feeMode = feeMode;
        scenario.balanceDelta = balanceDelta;
        scenario.swapInput = _swapInput(feeMode);
        scenario.bridgeAmount = _bridgeAmount(feeMode);
    }

    function _executeSwapAndBridge(Scenario memory scenario) internal {
        _execThroughAllowanceHolder(
            scenario.input,
            INPUT_AMOUNT,
            scenario.input == NATIVE_TOKEN ? INPUT_AMOUNT : 0,
            _swapAndBridgeCallData(scenario)
        );
    }

    function _swapAndBridgeCallData(Scenario memory scenario) internal view returns (bytes memory) {
        return abi.encodeCall(
            router.swapAndBridge,
            (
                keccak256("swap-and-bridge"),
                _flags(scenario.output, scenario.feeMode, scenario.balanceDelta),
                Router.InputData({user: USER, inputToken: scenario.input, inputAmount: INPUT_AMOUNT}),
                _fee(scenario.feeMode),
                _swapDataWithValue(
                    scenario.input,
                    scenario.output,
                    SWAP_OUTPUT_AMOUNT,
                    scenario.input == NATIVE_TOKEN ? scenario.swapInput : 0
                ),
                _swapCallData(scenario),
                _bridgeData(scenario.output, 0),
                _bridgeCallData(scenario.output, 0)
            )
        );
    }

    function _swapCallData(Scenario memory scenario) internal view returns (bytes memory) {
        if (scenario.balanceDelta) {
            return _swapNoReturnCallData(
                scenario.input, scenario.output, scenario.swapInput, SWAP_OUTPUT_AMOUNT, address(router)
            );
        }
        return _swapCallData(scenario.input, scenario.output, scenario.swapInput, SWAP_OUTPUT_AMOUNT, address(router));
    }

    function _fundSwapAndBridge(address input, address output) internal {
        _deal(input, USER, INPUT_AMOUNT);
        _deal(output, address(swapTarget), SWAP_OUTPUT_AMOUNT);
    }

    function _assertSwapAndBridgeInitial(address input, address output) internal view {
        Balances memory inputBalances = _emptyBalancesFor(input);
        inputBalances.user = INPUT_AMOUNT;
        _assertTokenBalances(input, inputBalances, "input initial");
        Balances memory outputBalances = _emptyBalancesFor(output);
        outputBalances.swapTarget = SWAP_OUTPUT_AMOUNT;
        _assertTokenBalances(output, outputBalances, "output initial");
    }

    function _assertSwapAndBridgeFinal(Scenario memory scenario) internal view {
        Balances memory inputBalances = _emptyBalancesFor(scenario.input);
        inputBalances.swapTarget = scenario.swapInput;
        inputBalances.feeRecipient = scenario.feeMode == FeeMode.Pre ? FEE_AMOUNT : 0;
        _assertTokenBalances(scenario.input, inputBalances, "input final");
        Balances memory outputBalances = _emptyBalancesFor(scenario.output);
        outputBalances.bridgeTarget = scenario.bridgeAmount;
        outputBalances.feeRecipient = scenario.feeMode == FeeMode.Post ? FEE_AMOUNT : 0;
        _assertTokenBalances(scenario.output, outputBalances, "output final");
    }

    function _swapInput(FeeMode feeMode) internal pure returns (uint256) {
        return feeMode == FeeMode.Pre ? INPUT_AMOUNT - FEE_AMOUNT : INPUT_AMOUNT;
    }

    function _bridgeAmount(FeeMode feeMode) internal pure returns (uint256) {
        return feeMode == FeeMode.Post ? SWAP_OUTPUT_AMOUNT - FEE_AMOUNT : SWAP_OUTPUT_AMOUNT;
    }

    function _flags(address output, FeeMode feeMode, bool balanceDelta) internal pure returns (uint256) {
        uint256 flags = balanceDelta ? BALANCE_FLAG_BIT_MASK : 0;
        if (output == NATIVE_TOKEN) flags |= BRIDGE_VALUE_FLAG_BIT_MASK;
        if (feeMode == FeeMode.Post) flags |= FEE_FLAG_BIT_MASK;
        return _bridgeAmountSpliceFlags(flags);
    }

    function _fee(FeeMode feeMode) internal pure returns (Router.FeeData memory) {
        if (feeMode == FeeMode.None) return Router.FeeData({receiver: address(0), amount: 0});
        return Router.FeeData({receiver: FEE_RECIPIENT, amount: FEE_AMOUNT});
    }
}
