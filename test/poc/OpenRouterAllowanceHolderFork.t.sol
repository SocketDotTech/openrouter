// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/src/tokens/ERC20.sol";

import {OpenRouter as Router} from "../../src/OpenRouter.sol";
import {ALLOWANCE_HOLDER, IAllowanceHolder} from "../../src/common/interfaces/IAllowanceHolder.sol";

/// @dev No-op bridge target so `router.bridge` can complete after the pull.
contract NoopBridgeTarget {
    function ping() external {}
}

/// @notice Polygon fork: user funds + AH approval, entry via AllowanceHolder.exec, OpenRouter pulls via `_pullFromUser`.
contract OpenRouterAllowanceHolderForkTest is Test {
    address internal constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    uint256 internal constant POLYGON_FORK_BLOCK = 86_816_149;
    uint256 internal constant INPUT_AMOUNT = 100e6;

    address internal user;

    function setUp() public {
        user = makeAddr("ahForkUser");
    }

    function test_fork_openRouter_bridge_pullsFromUserViaAllowanceHolder() public {
        string memory rpcUrl = vm.envOr("POLYGON_RPC", string(""));
        if (bytes(rpcUrl).length == 0) {
            emit log("Set POLYGON_RPC to run this fork test.");
            return;
        }

        uint256 forkBlock = vm.envOr("POLYGON_FORK_BLOCK", POLYGON_FORK_BLOCK);
        vm.createSelectFork(rpcUrl, forkBlock);

        Router router = new Router();
        NoopBridgeTarget noopBridge = new NoopBridgeTarget();

        deal(POLYGON_USDC, user, INPUT_AMOUNT);
        assertEq(ERC20(POLYGON_USDC).balanceOf(address(router)), 0, "router must not be pre-funded");

        vm.prank(user);
        ERC20(POLYGON_USDC).approve(address(ALLOWANCE_HOLDER), INPUT_AMOUNT);

        bytes memory routerCalldata = abi.encodeCall(
            Router.bridge,
            (
                keccak256("open-router-ah-fork"),
                Router.InputData({user: user, inputToken: POLYGON_USDC, inputAmount: INPUT_AMOUNT}),
                Router.FeeData({receiver: address(0), amount: 0}),
                Router.BridgeData({target: address(noopBridge), approvalSpender: address(0), value: 0}),
                abi.encodeCall(NoopBridgeTarget.ping, ())
            )
        );

        // Runtime-only gas (excludes `new OpenRouter` / `new NoopBridgeTarget` above).
        // Forge's per-test `gas:` figure still includes deployment; use this log for comparisons.
        uint256 gasBeforeExec = gasleft();
        vm.prank(user);
        IAllowanceHolder(address(ALLOWANCE_HOLDER)).exec(
            address(router), POLYGON_USDC, INPUT_AMOUNT, payable(address(router)), routerCalldata
        );
        uint256 runtimeGas = gasBeforeExec - gasleft();
        emit log_named_uint("runtime gas AH.exec -> router.bridge", runtimeGas);

        assertEq(ERC20(POLYGON_USDC).balanceOf(user), 0, "user balance");
        assertEq(ERC20(POLYGON_USDC).balanceOf(address(router)), INPUT_AMOUNT, "router pulled via AH");
    }
}
