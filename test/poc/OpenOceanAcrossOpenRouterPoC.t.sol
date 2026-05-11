// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {DummyRouter} from "../../src/dummyRouter.sol";
import {AcrossERC20AmountManipulator} from "../../src/manipulators/AcrossERC20AmountManipulator.sol";

interface ISpokePool {
    function deposit(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32 exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;
}

contract OpenOceanAcrossOpenRouterPoCTest is Test {
    address internal constant OPENOCEAN_EXCHANGE_V2 = 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64;
    address internal constant ACROSS_ARBITRUM_SPOKE_POOL = 0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A;
    address internal constant FIXTURE_ROUTER = 0x3a23F943181408EAC424116Af7b7790c94Cb97a5;
    address internal constant FIXTURE_RECIPIENT = 0xB0BBff6311B7F245761A7846d3Ce7B1b100C1836;
    address internal constant ARBITRUM_WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address internal constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant FORK_BLOCK_NUMBER = 461_716_058;
    uint256 internal constant FORK_BLOCK_TIMESTAMP = 0x6a01d6d1;
    uint256 internal constant SWAP_INPUT_USDC = 0x1640325;
    uint256 internal constant DEFAULT_ACROSS_BRIDGE_FEE = 1;
    string internal constant OPENOCEAN_SWAP_CALLDATA =
        "0x0a9704d5000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a2000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab1000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a20000000000000000000000003a23f943181408eac424116af7b7790c94cb97a50000000000000000000000000000000000000000000000000000000001640325000000000000000000000000000000000000000000000000002002d5154237f3000000000000000000000000000000000000000000000000000000000000000200000000000000000000000038c7720238a2c123814aaf1a3d0e31e0093af04600000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000034000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000104e5b07cdb0000000000000000000000007fcdc35463e3770c2fb992716cd070b63540b94700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001640325000000000000000000000000b100a5b2591dd099040a5ab76efe682a6d8a48a200000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002eaf88d065e77c8cc2239327c5edb3a432268e583100006482af49447d8a07e3bd95bd0d56f35241523fbab100000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000648a6a1e8500000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab1000000000000000000000000922164bbbd36acf9e854acbbf32facc949fcaeef00020000000000000000000000000000000000000000000000239364a56cb36600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001a49f86542200000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f9900000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab10000000000000000000000003a23f943181408eac424116af7b7790c94cb97a500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    function test_openOceanSwapManipulatorAcrossDeposit_arbitrumFork() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpcUrl).length != 0) {
            uint256 forkBlock = vm.envOr("ARBITRUM_FORK_BLOCK", FORK_BLOCK_NUMBER);
            vm.createSelectFork(rpcUrl, forkBlock);
            vm.warp(FORK_BLOCK_TIMESTAMP);
        }

        DummyRouter router = _routerAtFixtureAddress();
        AcrossERC20AmountManipulator manipulator = new AcrossERC20AmountManipulator();
        if (bytes(rpcUrl).length == 0) {
            emit log("Set ARBITRUM_RPC to execute this fork PoC.");
            return;
        }

        uint256 inputAmount = vm.envOr("POC_USDC_AMOUNT", SWAP_INPUT_USDC);
        uint256 bridgeFee = vm.envOr("POC_ACROSS_BRIDGE_FEE", DEFAULT_ACROSS_BRIDGE_FEE);

        deal(ARBITRUM_USDC, address(router), inputAmount);
        deal(ARBITRUM_WETH, address(router), 0);

        DummyRouter.Action[] memory actions =
            _buildActions(manipulator, inputAmount, bridgeFee, vm.parseBytes(OPENOCEAN_SWAP_CALLDATA));
        uint256 spokePoolWethBefore = ERC20(ARBITRUM_WETH).balanceOf(ACROSS_ARBITRUM_SPOKE_POOL);

        bytes[] memory results = router.execute(actions);

        _assertPocResult(router, bridgeFee, spokePoolWethBefore, results[2]);
    }

    function _buildActions(
        AcrossERC20AmountManipulator manipulator,
        uint256 inputAmount,
        uint256 bridgeFee,
        bytes memory swapCalldata
    ) internal view returns (DummyRouter.Action[] memory actions) {
        actions = new DummyRouter.Action[](5);
        actions[0] = _action(
            DummyRouter.CallType.CALL,
            ARBITRUM_USDC,
            abi.encodeWithSelector(ERC20.approve.selector, OPENOCEAN_EXCHANGE_V2, inputAmount),
            new DummyRouter.Splice[](0)
        );

        actions[1] =
            _action(DummyRouter.CallType.CALL, OPENOCEAN_EXCHANGE_V2, swapCalldata, new DummyRouter.Splice[](0));

        DummyRouter.Splice[] memory outputAmountSplices = new DummyRouter.Splice[](1);
        outputAmountSplices[0] = DummyRouter.Splice({sourceActionIndex: 1, srcOffset: 0, dstOffset: 4, length: 32});

        actions[2] = _action(
            DummyRouter.CallType.STATICCALL,
            address(manipulator),
            abi.encodeCall(
                AcrossERC20AmountManipulator.deriveOutputAmount, (uint256(0), bridgeFee, uint256(18), uint256(18))
            ),
            outputAmountSplices
        );

        actions[3] = _action(
            DummyRouter.CallType.CALL,
            ARBITRUM_WETH,
            abi.encodeWithSelector(ERC20.approve.selector, ACROSS_ARBITRUM_SPOKE_POOL, type(uint256).max),
            new DummyRouter.Splice[](0)
        );

        DummyRouter.Splice[] memory depositSplices = new DummyRouter.Splice[](2);
        depositSplices[0] = DummyRouter.Splice({sourceActionIndex: 1, srcOffset: 0, dstOffset: 132, length: 32});
        depositSplices[1] = DummyRouter.Splice({sourceActionIndex: 2, srcOffset: 0, dstOffset: 164, length: 32});

        actions[4] = _action(
            DummyRouter.CallType.CALL, ACROSS_ARBITRUM_SPOKE_POOL, _emptyAcrossDepositCalldata(), depositSplices
        );
    }

    function _assertPocResult(
        DummyRouter router,
        uint256 bridgeFee,
        uint256 spokePoolWethBefore,
        bytes memory manipulatorResult
    ) internal view {
        uint256 actualInputAmount = ERC20(ARBITRUM_WETH).balanceOf(ACROSS_ARBITRUM_SPOKE_POOL) - spokePoolWethBefore;
        uint256 actualOutputAmount = abi.decode(manipulatorResult, (uint256));

        assertEq(ERC20(ARBITRUM_USDC).balanceOf(address(router)), 0);
        assertEq(ERC20(ARBITRUM_WETH).balanceOf(address(router)), 0);
        assertGt(actualInputAmount, 0);
        assertEq(actualOutputAmount, actualInputAmount - bridgeFee);
    }

    function _routerAtFixtureAddress() internal returns (DummyRouter router) {
        DummyRouter implementation = new DummyRouter();
        vm.etch(FIXTURE_ROUTER, address(implementation).code);
        return DummyRouter(payable(FIXTURE_ROUTER));
    }

    function _emptyAcrossDepositCalldata() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            ISpokePool.deposit.selector,
            _toBytes32(FIXTURE_RECIPIENT),
            _toBytes32(FIXTURE_RECIPIENT),
            _toBytes32(ARBITRUM_WETH),
            _toBytes32(BASE_WETH),
            uint256(0),
            uint256(0),
            BASE_CHAIN_ID,
            bytes32(0),
            uint32(block.timestamp),
            uint32(block.timestamp + 3 hours),
            uint32(0),
            ""
        );
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
