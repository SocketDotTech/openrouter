// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {DummyRouter} from "../../src/dummyRouter.sol";
import {MathManipulator} from "../../src/manipulators/MathManipulator.sol";

interface IOpenOceanExchangeV2 {
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

interface IStargateNative {
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
contract OpenOceanStargateNativeOpenRouterPoCTest is Test {
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
    uint256 internal constant CALL_WITH_NATIVE_PAYLOAD_OFFSET = 32;

    function test_openOceanSwapStargateNativeBridge_arbitrumFork() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpcUrl).length != 0) {
            uint256 forkBlock = vm.envOr("ARBITRUM_FORK_BLOCK", FORK_BLOCK_NUMBER);
            vm.createSelectFork(rpcUrl, forkBlock);
            vm.warp(FORK_BLOCK_TIMESTAMP);
        }

        DummyRouter router = _routerAtFixtureAddress();
        MathManipulator manipulator = new MathManipulator();
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

        DummyRouter.Action[] memory actions = _buildActions(
            manipulator, inputAmount, nativeFee, _openOceanSwapCalldata(inputAmount), _stargateCalldata(nativeFee)
        );

        uint256 gasBeforeExecute = gasleft();
        bytes[] memory results = router.execute(actions);
        uint256 executeGasUsed = gasBeforeExecute - gasleft();
        emit log_named_uint("router.execute gas used", executeGasUsed);

        _assertPocResult(
            router,
            nativeFee,
            initialNativeBalance,
            initialFeeRecipientBalance,
            initialWethBalance,
            results[1],
            results[2],
            results[4],
            results[5]
        );
    }

    function _openOceanSwapCalldata(uint256 inputAmount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            OPENOCEAN_SWAP_SELECTOR,
            OPENOCEAN_CALLER,
            IOpenOceanExchangeV2.SwapDescription({
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
            IStargateNative.send,
            (
                IStargateNative.SendParam({
                    dstEid: BASE_ENDPOINT_ID,
                    to: _toBytes32(FIXTURE_RECIPIENT),
                    amountLD: 0,
                    minAmountLD: 0,
                    extraOptions: "",
                    composeMsg: "",
                    oftCmd: ""
                }),
                IStargateNative.MessagingFee({nativeFee: nativeFee, lzTokenFee: 0}),
                FIXTURE_RECIPIENT
            )
        );
    }

    function _openOceanCalls() internal pure returns (IOpenOceanExchangeV2.CallDescription[] memory calls) {
        calls = new IOpenOceanExchangeV2.CallDescription[](6);
        calls[0] = IOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"e5b07cdb0000000000000000000000007fcdc35463e3770c2fb992716cd070b63540b9470000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000112a880000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a200000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002eaf88d065e77c8cc2239327c5edb3a432268e583100006482af49447d8a07e3bd95bd0d56f35241523fbab1000003000000000000000000000000000000000000"
        });
        calls[1] = IOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f865422000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f99000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000b7236b927e03542ac3be0a054f2bea8868af9508000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
        calls[2] = IOpenOceanExchangeV2.CallDescription({
            target: uint256(uint160(0xb7236B927e03542AC3bE0A054F2bEa8868AF9508)),
            gasLimit: 0,
            value: 0,
            data: hex"53c059a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a2"
        });
        calls[3] = IOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f86542200000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000400000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000242e1a7d4d000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
        calls[4] = IOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"8a6a1e85000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000922164bbbd36acf9e854acbbf32facc949fcaeef000000000000000000000000000000000000000000000000001ea1d1d3352615"
        });
        calls[5] = IOpenOceanExchangeV2.CallDescription({
            target: 0,
            gasLimit: 0,
            value: 0,
            data: hex"9f865422000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f99000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000003a23f943181408eac424116af7b7790c94cb97a5000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000"
        });
    }

    function _buildActions(
        MathManipulator manipulator,
        uint256 inputAmount,
        uint256 nativeFee,
        bytes memory swapCalldata,
        bytes memory stargateCalldata
    ) internal pure returns (DummyRouter.Action[] memory actions) {
        actions = new DummyRouter.Action[](7);
        actions[0] = _action(
            DummyRouter.CallType.CALL,
            ARBITRUM_USDC,
            abi.encodeWithSelector(ERC20.approve.selector, OPENOCEAN_EXCHANGE_V2, inputAmount),
            new DummyRouter.Splice[](0)
        );

        actions[1] =
            _action(DummyRouter.CallType.CALL, OPENOCEAN_EXCHANGE_V2, swapCalldata, new DummyRouter.Splice[](0));

        DummyRouter.Splice[] memory feeSplices = new DummyRouter.Splice[](1);
        feeSplices[0] = DummyRouter.Splice({sourceActionIndex: 1, srcOffset: 0, dstOffset: 4, length: 32});
        actions[2] = _action(
            DummyRouter.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.percent, (uint256(0), ROUTE_FEE_BPS)),
            feeSplices
        );

        DummyRouter.Splice[] memory feeTransferSplices = new DummyRouter.Splice[](1);
        feeTransferSplices[0] = DummyRouter.Splice({sourceActionIndex: 2, srcOffset: 0, dstOffset: 0, length: 32});
        actions[3] = _action(
            DummyRouter.CallType.CALL_WITH_NATIVE, FEE_RECIPIENT, abi.encodePacked(uint256(0)), feeTransferSplices
        );

        DummyRouter.Splice[] memory postFeeSplices = new DummyRouter.Splice[](2);
        postFeeSplices[0] = DummyRouter.Splice({sourceActionIndex: 1, srcOffset: 0, dstOffset: 4, length: 32});
        postFeeSplices[1] = DummyRouter.Splice({sourceActionIndex: 2, srcOffset: 0, dstOffset: 36, length: 32});
        actions[4] = _action(
            DummyRouter.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.subtract, (uint256(0), uint256(0))),
            postFeeSplices
        );

        DummyRouter.Splice[] memory bridgeAmountSplices = new DummyRouter.Splice[](1);
        bridgeAmountSplices[0] = DummyRouter.Splice({sourceActionIndex: 4, srcOffset: 0, dstOffset: 4, length: 32});
        actions[5] = _action(
            DummyRouter.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.subtract, (uint256(0), nativeFee)),
            bridgeAmountSplices
        );

        DummyRouter.Splice[] memory stargateSplices = new DummyRouter.Splice[](2);
        stargateSplices[0] = DummyRouter.Splice({sourceActionIndex: 4, srcOffset: 0, dstOffset: 0, length: 32});
        stargateSplices[1] = DummyRouter.Splice({
            sourceActionIndex: 5,
            srcOffset: 0,
            dstOffset: CALL_WITH_NATIVE_PAYLOAD_OFFSET + STARGATE_AMOUNT_OFFSET,
            length: 32
        });
        actions[6] = _action(
            DummyRouter.CallType.CALL_WITH_NATIVE,
            STARGATE_NATIVE_WRAPPER,
            abi.encodePacked(uint256(0), stargateCalldata),
            stargateSplices
        );
    }

    function _assertPocResult(
        DummyRouter router,
        uint256 nativeFee,
        uint256 initialNativeBalance,
        uint256 initialFeeRecipientBalance,
        uint256 initialWethBalance,
        bytes memory openOceanResult,
        bytes memory feeResult,
        bytes memory postFeeResult,
        bytes memory bridgeAmountResult
    ) internal view {
        uint256 swapOutput = abi.decode(openOceanResult, (uint256));
        uint256 routeFee = abi.decode(feeResult, (uint256));
        uint256 postFeeAmount = abi.decode(postFeeResult, (uint256));
        uint256 bridgeAmount = abi.decode(bridgeAmountResult, (uint256));

        assertGt(swapOutput, 0);
        assertEq(routeFee, swapOutput * ROUTE_FEE_BPS / 10_000);
        assertEq(FEE_RECIPIENT.balance - initialFeeRecipientBalance, routeFee);
        assertEq(postFeeAmount + routeFee, swapOutput);
        assertEq(bridgeAmount + nativeFee, postFeeAmount);
        assertEq(ERC20(ARBITRUM_USDC).balanceOf(address(router)), 0);
        assertEq(ERC20(ARBITRUM_WETH).balanceOf(address(router)), initialWethBalance);
        assertLt(address(router).balance - initialNativeBalance, nativeFee);
    }

    function _routerAtFixtureAddress() internal returns (DummyRouter router) {
        DummyRouter implementation = new DummyRouter();
        vm.etch(FIXTURE_ROUTER, address(implementation).code);
        return DummyRouter(payable(FIXTURE_ROUTER));
    }

    function _action(
        DummyRouter.CallType callType,
        address target,
        bytes memory data,
        DummyRouter.Splice[] memory splices
    ) internal pure returns (DummyRouter.Action memory) {
        return DummyRouter.Action({callType: callType, target: target, data: data, splices: splices});
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
