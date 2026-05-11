// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {SwapFeeBridgeRouter} from "../../src/swapFeeBridgeRouter.sol";

interface ISwapFeeBridgeOpenOceanExchangeV2 {
    struct SwapDescription {
        address srcToken;
        address dstToken;
        address srcReceiver;
        address dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
        address referrer;
        bytes permit;
    }

    struct CallDescription {
        uint256 target;
        uint256 gasLimit;
        uint256 value;
        bytes data;
    }
}

interface ISwapFeeBridgeStargateNative {
    struct SendParam {
        uint32 dstEid;
        bytes32 to;
        uint256 amountLD;
        uint256 minAmountLD;
        bytes extraOptions;
        bytes composeMsg;
        bytes oftCmd;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    function send(SendParam calldata sendParam, MessagingFee calldata fee, address refundAddress) external payable;
}

// ref tx 0xef65dc3323cd757c5e3a1a872b99beff6e71f0a80b1a2a6d280d2f2458f3cbaf
contract OpenOceanStargateNativeSwapFeeBridgeRouterPoCTest is Test {
    bytes4 internal constant OPENOCEAN_SWAP_SELECTOR = 0x0a9704d5;
    address internal constant OPENOCEAN_EXCHANGE_V2 = 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64;
    address internal constant OPENOCEAN_CALLER = 0xB100a5B2591Dd099040a5ab76EFe682A6D8a48a2;
    address internal constant OPENOCEAN_REFERRER = 0x38c7720238a2C123814aaF1A3D0e31E0093aF046;
    address internal constant STARGATE_NATIVE_WRAPPER = 0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F;
    address internal constant FIXTURE_ROUTER = 0x3a23F943181408EAC424116Af7b7790c94Cb97a5;
    address internal constant FIXTURE_RECIPIENT = 0xB0BBff6311B7F245761A7846d3Ce7B1b100C1836;
    address internal constant FEE_RECIPIENT = 0x0079a23EDEA601190EdF1cda05c8Af3fEA2f2d9F;
    address internal constant ARBITRUM_WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address internal constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint256 internal constant FORK_BLOCK_NUMBER = 461_745_499;
    uint256 internal constant FORK_BLOCK_TIMESTAMP = 0x6a01f38b;
    uint256 internal constant SWAP_INPUT_USDC = 0x1312d00;
    uint256 internal constant OPENOCEAN_MIN_RETURN = 0x1b91a33e163bdf;
    uint256 internal constant OPENOCEAN_FLAGS = 2;
    uint256 internal constant STARGATE_NATIVE_FEE = 0x1603e90a5fe0;
    uint256 internal constant ROUTE_FEE_BPS = 100;

    uint32 internal constant BASE_ENDPOINT_ID = 30_184;
    uint256 internal constant STARGATE_AMOUNT_OFFSET = 196;

    function test_openOceanSwapFeeBridgeRouter_arbitrumFork() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpcUrl).length != 0) {
            uint256 forkBlock = vm.envOr("ARBITRUM_FORK_BLOCK", FORK_BLOCK_NUMBER);
            vm.createSelectFork(rpcUrl, forkBlock);
            vm.warp(FORK_BLOCK_TIMESTAMP);
        }

        SwapFeeBridgeRouter router = _routerAtFixtureAddress();
        if (bytes(rpcUrl).length == 0) {
            emit log("Set ARBITRUM_RPC to execute this fork PoC.");
            return;
        }

        uint256 inputAmount = vm.envOr("POC_USDC_AMOUNT", SWAP_INPUT_USDC);
        uint256 nativeFee = vm.envOr("POC_STARGATE_NATIVE_FEE", STARGATE_NATIVE_FEE);

        deal(ARBITRUM_USDC, address(router), inputAmount);
        uint256 initialNativeBalance = address(router).balance;
        uint256 initialFeeRecipientBalance = FEE_RECIPIENT.balance;
        uint256 initialWethBalance = ERC20(ARBITRUM_WETH).balanceOf(address(router));

        SwapFeeBridgeRouter.SwapFeeBridgeParams memory params = SwapFeeBridgeRouter.SwapFeeBridgeParams({
            inputToken: ARBITRUM_USDC,
            approveTarget: OPENOCEAN_EXCHANGE_V2,
            inputAmount: inputAmount,
            swapTarget: OPENOCEAN_EXCHANGE_V2,
            swapData: _openOceanSwapCalldata(inputAmount),
            bridgeTarget: STARGATE_NATIVE_WRAPPER,
            bridgeData: _stargateCalldata(nativeFee),
            bridgeAmountOffset: STARGATE_AMOUNT_OFFSET,
            feeRecipient: FEE_RECIPIENT,
            feeBps: ROUTE_FEE_BPS,
            nativeFee: nativeFee
        });

        uint256 gasBeforeSwapFeeBridge = gasleft();
        (uint256 swapOutput, uint256 routeFee, uint256 postFeeAmount, uint256 bridgeAmount) =
            router.swapFeeBridge(params);
        uint256 swapFeeBridgeGasUsed = gasBeforeSwapFeeBridge - gasleft();
        emit log_named_uint("router.swapFeeBridge gas used", swapFeeBridgeGasUsed);

        _assertPocResult(
            router,
            nativeFee,
            initialNativeBalance,
            initialFeeRecipientBalance,
            initialWethBalance,
            swapOutput,
            routeFee,
            postFeeAmount,
            bridgeAmount
        );
    }

    function _openOceanSwapCalldata(uint256 inputAmount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            OPENOCEAN_SWAP_SELECTOR,
            OPENOCEAN_CALLER,
            ISwapFeeBridgeOpenOceanExchangeV2.SwapDescription({
                srcToken: ARBITRUM_USDC,
                dstToken: NATIVE_TOKEN,
                srcReceiver: OPENOCEAN_CALLER,
                dstReceiver: FIXTURE_ROUTER,
                amount: inputAmount,
                minReturnAmount: OPENOCEAN_MIN_RETURN,
                flags: OPENOCEAN_FLAGS,
                referrer: OPENOCEAN_REFERRER,
                permit: ""
            }),
            _openOceanCalls()
        );
    }

    function _stargateCalldata(uint256 nativeFee) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISwapFeeBridgeStargateNative.send,
            (
                ISwapFeeBridgeStargateNative.SendParam({
                    dstEid: BASE_ENDPOINT_ID,
                    to: _toBytes32(FIXTURE_RECIPIENT),
                    amountLD: 0,
                    minAmountLD: 0,
                    extraOptions: "",
                    composeMsg: "",
                    oftCmd: ""
                }),
                ISwapFeeBridgeStargateNative.MessagingFee({nativeFee: nativeFee, lzTokenFee: 0}),
                FIXTURE_RECIPIENT
            )
        );
    }

    function _openOceanCalls()
        internal
        pure
        returns (ISwapFeeBridgeOpenOceanExchangeV2.CallDescription[] memory calls)
    {
        calls = new ISwapFeeBridgeOpenOceanExchangeV2.CallDescription[](6);
        calls[0] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"e5b07cdb0000000000000000000000007fcdc35463e3770c2fb992716cd070b63540b9470000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000112a880000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a200000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002eaf88d065e77c8cc2239327c5edb3a432268e583100006482af49447d8a07e3bd95bd0d56f35241523fbab1000003000000000000000000000000000000000000"
        });
        calls[1] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f865422000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f99000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000b7236b927e03542ac3be0a054f2bea8868af9508000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
        calls[2] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: uint256(uint160(0xb7236B927e03542AC3bE0A054F2bEa8868AF9508)),
            gasLimit: 0,
            value: 0,
            data: hex"53c059a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a2"
        });
        calls[3] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f86542200000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000400000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000242e1a7d4d000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
        calls[4] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"8a6a1e85000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000922164bbbd36acf9e854acbbf32facc949fcaeef000000000000000000000000000000000000000000000000001ea1d1d3352615"
        });
        calls[5] = ISwapFeeBridgeOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f865422000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f99000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000003a23f943181408eac424116af7b7790c94cb97a5000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
    }

    function _assertPocResult(
        SwapFeeBridgeRouter router,
        uint256 nativeFee,
        uint256 initialNativeBalance,
        uint256 initialFeeRecipientBalance,
        uint256 initialWethBalance,
        uint256 swapOutput,
        uint256 routeFee,
        uint256 postFeeAmount,
        uint256 bridgeAmount
    ) internal view {
        assertGt(swapOutput, 0);
        assertEq(routeFee, swapOutput * ROUTE_FEE_BPS / 10_000);
        assertEq(FEE_RECIPIENT.balance - initialFeeRecipientBalance, routeFee);
        assertEq(postFeeAmount + routeFee, swapOutput);
        assertEq(bridgeAmount + nativeFee, postFeeAmount);
        assertEq(ERC20(ARBITRUM_USDC).balanceOf(address(router)), 0);
        assertEq(ERC20(ARBITRUM_WETH).balanceOf(address(router)), initialWethBalance);
        assertLt(address(router).balance - initialNativeBalance, nativeFee);
    }

    function _routerAtFixtureAddress() internal returns (SwapFeeBridgeRouter router) {
        SwapFeeBridgeRouter implementation = new SwapFeeBridgeRouter();
        vm.etch(FIXTURE_ROUTER, address(implementation).code);
        return SwapFeeBridgeRouter(payable(FIXTURE_ROUTER));
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
