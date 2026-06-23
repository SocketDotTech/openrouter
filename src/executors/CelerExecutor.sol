// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {Ownable} from "../common/utils/Ownable.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {Pb} from "../common/lib/Pb.sol";
import {IERC20} from "../common/interfaces/IERC20.sol";
import {ICelerBridge} from "../interfaces/ICelerBridge.sol";

/// @title CelerExecutor
/// @notice Proxies Celer bridge calls from OpenRouter so refunds return to this contract.
contract CelerExecutor is Ownable {
    using Pb for Pb.Buffer;

    error CallerNotOpenRouter();
    error InvalidCelerRefund();
    error CelerRefundNotReady();

    struct WithdrawMsg {
        uint64 chainid;
        uint64 seqnum;
        address receiver;
        address token;
        uint256 amount;
        bytes32 refid;
    }

    ICelerBridge public immutable CELER_BRIDGE;
    address public immutable OPEN_ROUTER;
    uint64 public immutable CHAIN_ID;

    constructor(address _owner, address _openRouter, address _celerBridgeRouter) Ownable(_owner) {
        CELER_BRIDGE = ICelerBridge(_celerBridgeRouter);
        OPEN_ROUTER = _openRouter;
        CHAIN_ID = uint64(block.chainid);
    }

    /// @notice Bridge tokens via Celer; only callable by OpenRouter.
    /// @param receiver Destination receiver on the dst chain.
    /// @param token ERC-20 token to bridge; ignored when `isNative` is true.
    /// @param amount Amount to bridge; may be spliced at runtime by OpenRouter on swapAndBridge.
    /// @param dstChainId Celer destination chain id.
    /// @param nonce Unique nonce for the transfer.
    /// @param maxSlippage Max slippage in basis points.
    /// @param isNative When true, forwards `amount` as msg.value to `sendNative`.
    function execute(
        address receiver,
        address token,
        uint256 amount,
        uint64 dstChainId,
        uint64 nonce,
        uint32 maxSlippage,
        bool isNative
    ) external payable {
        if (msg.sender != OPEN_ROUTER) {
            revert CallerNotOpenRouter();
        }

        if (isNative) {
            CELER_BRIDGE.sendNative{value: amount}(receiver, amount, dstChainId, nonce, maxSlippage);
            return;
        }

        SafeTransferLib.safeTransferFrom(token, OPEN_ROUTER, address(this), amount);

        if (amount > IERC20(token).allowance(address(this), address(CELER_BRIDGE))) {
            SafeTransferLib.safeApproveWithRetry(token, address(CELER_BRIDGE), type(uint256).max);
        }

        CELER_BRIDGE.send(receiver, token, amount, dstChainId, nonce, maxSlippage);
    }

    /// @notice Admin refund handler for Celer bridge withdrawals.
    /// @param _receiver Address that receives the refunded funds.
    /// @param _request Withdraw message from the Celer SDK.
    /// @param _sigs Validator signatures.
    /// @param _signers Validator signer addresses.
    /// @param _powers Validator powers.
    function refundCelerUserAdmin(
        address _receiver,
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers
    ) external payable onlyOwner {
        WithdrawMsg memory request = decWithdrawMsg(_request);

        if (request.receiver != address(this)) {
            revert InvalidCelerRefund();
        }

        uint256 snapNative = address(this).balance;
        uint256 snapToken = SafeTransferLib.balanceOf(request.token, address(this));

        _withdrawIfNeeded(request, _request, _sigs, _signers, _powers);
        _payoutRefund(request, _receiver, snapNative, snapToken);
    }

    function _withdrawIfNeeded(
        WithdrawMsg memory request,
        bytes calldata requestBytes,
        bytes[] calldata sigs,
        address[] calldata signers,
        uint256[] calldata powers
    ) private {
        bytes32 transferId = keccak256(
            abi.encodePacked(request.chainid, request.seqnum, request.receiver, request.token, request.amount)
        );

        if (!CELER_BRIDGE.withdraws(transferId)) {
            CELER_BRIDGE.withdraw(requestBytes, sigs, signers, powers);
        }
    }

    function _payoutRefund(
        WithdrawMsg memory request,
        address receiver,
        uint256 snapNative,
        uint256 snapToken
    ) private {
        uint256 nativeAfter = address(this).balance;

        if (nativeAfter > snapNative) {
            if ((nativeAfter - snapNative) != request.amount) {
                revert CelerRefundNotReady();
            }
            SafeTransferLib.safeTransferETH(receiver, request.amount);
            return;
        }

        uint256 tokenAfter = SafeTransferLib.balanceOf(request.token, address(this));

        if (tokenAfter > snapToken) {
            if ((tokenAfter - snapToken) != request.amount) {
                revert CelerRefundNotReady();
            }
            SafeTransferLib.safeTransfer(request.token, receiver, request.amount);
            return;
        }

        revert CelerRefundNotReady();
    }

    /// @notice Rescues funds locked in the contract.
    function rescueFunds(address token_, address rescueTo_, uint256 amount_) external onlyOwner {
        RescueFundsLib.rescueFunds(token_, rescueTo_, amount_);
    }

    function decWithdrawMsg(bytes memory raw) internal pure returns (WithdrawMsg memory m) {
        Pb.Buffer memory buf = Pb.fromBytes(raw);

        uint256 tag;
        Pb.WireType wire;
        while (buf.hasMore()) {
            (tag, wire) = buf.decKey();
            if (tag == 1) {
                m.chainid = uint64(buf.decVarint());
            } else if (tag == 2) {
                m.seqnum = uint64(buf.decVarint());
            } else if (tag == 3) {
                m.receiver = Pb._address(buf.decBytes());
            } else if (tag == 4) {
                m.token = Pb._address(buf.decBytes());
            } else if (tag == 5) {
                m.amount = Pb._uint256(buf.decBytes());
            } else if (tag == 6) {
                m.refid = Pb._bytes32(buf.decBytes());
            } else {
                buf.skipValue(wire);
            }
        }
    }

    receive() external payable {}

    fallback() external payable {}
}
