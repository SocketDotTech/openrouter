// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {BungeeOpenRouter as Router} from "../../src/BungeeOpenRouter.sol";
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

        Router router = _routerAtFixtureAddress();
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

        Router.Action[] memory actions = _buildActions(
            manipulator, inputAmount, nativeFee, _openOceanSwapCalldata(inputAmount), _stargateCalldata(nativeFee)
        );

        uint256 gasBeforeExecute = gasleft();
        router.performActions(keccak256("open-ocean-stargate-native-modular"), actions);
        uint256 executeGasUsed = gasBeforeExecute - gasleft();
        emit log_named_uint("router.performActions gas used", executeGasUsed);

        _assertPocResult(router, nativeFee, initialNativeBalance, initialFeeRecipientBalance, initialWethBalance);
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
    ) internal pure returns (Router.Action[] memory actions) {
        actions = new Router.Action[](7);
        actions[0] = _action(
            Router.CallType.CALL,
            ARBITRUM_USDC,
            abi.encodeWithSelector(ERC20.approve.selector, OPENOCEAN_EXCHANGE_V2, inputAmount),
            new uint256[](0),
            false
        );

        actions[1] = _action(Router.CallType.CALL, OPENOCEAN_EXCHANGE_V2, swapCalldata, new uint256[](0), true);

        uint256[] memory feeSplices = new uint256[](1);
        feeSplices[0] = _splice(1, 0, 4, 32);
        actions[2] = _action(
            Router.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.percent, (uint256(0), ROUTE_FEE_BPS)),
            feeSplices,
            true
        );

        uint256[] memory feeTransferSplices = new uint256[](1);
        feeTransferSplices[0] = _splice(2, 0, 0, 32);
        actions[3] = _action(
            Router.CallType.CALL_WITH_NATIVE, FEE_RECIPIENT, abi.encodePacked(uint256(0)), feeTransferSplices, false
        );

        uint256[] memory postFeeSplices = new uint256[](2);
        postFeeSplices[0] = _splice(1, 0, 4, 32);
        postFeeSplices[1] = _splice(2, 0, 36, 32);
        actions[4] = _action(
            Router.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.subtract, (uint256(0), uint256(0))),
            postFeeSplices,
            true
        );

        uint256[] memory bridgeAmountSplices = new uint256[](1);
        bridgeAmountSplices[0] = _splice(4, 0, 4, 32);
        actions[5] = _action(
            Router.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(MathManipulator.subtract, (uint256(0), nativeFee)),
            bridgeAmountSplices,
            true
        );

        uint256[] memory stargateSplices = new uint256[](2);
        stargateSplices[0] = _splice(4, 0, 0, 32);
        stargateSplices[1] = _splice(5, 0, uint64(CALL_WITH_NATIVE_PAYLOAD_OFFSET + STARGATE_AMOUNT_OFFSET), 32);
        actions[6] = _action(
            Router.CallType.CALL_WITH_NATIVE,
            STARGATE_NATIVE_WRAPPER,
            abi.encodePacked(uint256(0), stargateCalldata),
            stargateSplices,
            false
        );
    }

    function _assertPocResult(
        Router router,
        uint256 nativeFee,
        uint256 initialNativeBalance,
        uint256 initialFeeRecipientBalance,
        uint256 initialWethBalance
    ) internal view {
        assertGt(FEE_RECIPIENT.balance - initialFeeRecipientBalance, 0);
        assertEq(ERC20(ARBITRUM_USDC).balanceOf(address(router)), 0);
        assertEq(ERC20(ARBITRUM_WETH).balanceOf(address(router)), initialWethBalance);
        assertLt(address(router).balance - initialNativeBalance, nativeFee);
    }

    function _routerAtFixtureAddress() internal returns (Router router) {
        Router implementation = new Router(address(this));
        vm.etch(FIXTURE_ROUTER, address(implementation).code);
        return Router(payable(FIXTURE_ROUTER));
    }

    function _action(
        Router.CallType callType,
        address target,
        bytes memory data,
        uint256[] memory splices,
        bool storeResult
    ) internal pure returns (Router.Action memory) {
        return Router.Action({actionInfo: _actionInfo(callType, target, storeResult), data: data, splices: splices});
    }

    function _actionInfo(Router.CallType callType, address target, bool storeResult) internal pure returns (uint256) {
        return uint256(uint8(callType)) | (storeResult ? uint256(1) << 8 : 0) | (uint256(uint160(target)) << 16);
    }

    function _splice(uint64 sourceActionIndex, uint64 srcOffset, uint64 dstOffset, uint64 length)
        internal
        pure
        returns (uint256)
    {
        return uint256(sourceActionIndex) | (uint256(srcOffset) << 64) | (uint256(dstOffset) << 128)
            | (uint256(length) << 192);
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
