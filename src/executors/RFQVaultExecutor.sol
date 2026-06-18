// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {Ownable} from "../common/utils/Ownable.sol";
import {RescueFundsLib} from "../common/lib/RescueFundsLib.sol";
import {AuthenticationLib} from "../common/lib/AuthenticationLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";

/// @title RFQVaultExecutor
/// @notice Solver-controlled vault that receives deposits and releases funds via signed fulfil/refund flows.
contract RFQVaultExecutor is Ownable {
    struct Action {
        address target;
        uint256 value;
        bytes data;
    }

    error ActionFailed(uint256 index);
    error InvalidQuoteId();
    error InvalidNonce();
    error InvalidSigner();
    error SwapOutputInsufficient();

    uint256 internal constant FULFIL_DISCRIMINATOR = 1;
    uint256 internal constant REFUND_DISCRIMINATOR = 2;
    uint256 internal constant SWAP_AND_FULFIL_DISCRIMINATOR = 3;

    address internal SOLVER_SIGNER;

    mapping(bytes32 quoteId => uint256 isUsed) public quoteIdUsed;
    mapping(uint256 nonce => uint256 isUsed) public nonceUsed;
    mapping(bytes32 quoteId => uint256 isMarked) public isMarkedForRefund;

    event NativeDeposited(bytes32 quoteId, uint256 amount);
    event ERC20Deposited(bytes32 quoteId, address token, uint256 amount);
    event Fulfilled(
        bytes32 quoteId,
        address token,
        uint256 amount,
        address receiver
    );
    event Refunded(
        bytes32 quoteId,
        address token,
        uint256 amount,
        address receiver
    );

    constructor(address _owner, address _solverSigner) Ownable(_owner) {
        SOLVER_SIGNER = _solverSigner;
    }

    /// @notice Accept native deposits and emit a correlating event.
    function receiveNative(bytes32 quoteId) external payable {
        emit NativeDeposited(quoteId, msg.value);
    }

    /// @notice Pull ERC20 tokens from the caller into the vault and emit a correlating event.
    function receiveERC20(
        bytes32 quoteId,
        address token,
        uint256 amount
    ) external {
        SafeTransferLib.safeTransferFrom(
            token,
            msg.sender,
            address(this),
            amount
        );
        emit ERC20Deposited(quoteId, token, amount);
    }

    /// @notice Transfer vault funds to a receiver for a signed quote.
    function fulfil(
        bytes32 quoteId,
        uint256 nonce,
        address token,
        uint256 amount,
        address receiver,
        bytes calldata signature
    ) external {
        bytes32 messageHash = _hashFulfilOrRefund(
            FULFIL_DISCRIMINATOR,
            quoteId,
            nonce,
            token,
            amount,
            receiver
        );
        _verifyAndMarkQuoteId(messageHash, signature, quoteId);

        CurrencyLib.transfer(token, receiver, amount);
        emit Fulfilled(quoteId, token, amount, receiver);
    }

    /// @notice Swap vault inventory then transfer swap output to the receiver.
    function swapAndFulfil(
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken,
        uint256 minOutput,
        Action calldata swapAction,
        address receiver,
        bytes calldata signature
    ) external {
        bytes32 messageHash = _hashSwapAndFulfil(
            quoteId,
            nonce,
            approvalToken,
            approvalSpender,
            approvalAmount,
            outputToken,
            minOutput,
            swapAction,
            receiver
        );
        _verifyAndMarkQuoteId(messageHash, signature, quoteId);

        if (approvalToken != address(0)) {
            SafeTransferLib.safeApproveWithRetry(
                approvalToken,
                approvalSpender,
                approvalAmount
            );
        }

        uint256 beforeBalance = CurrencyLib.balanceOf(
            outputToken,
            address(this)
        );
        if (!_performAction(swapAction)) {
            revert ActionFailed(0);
        }

        uint256 swapOutput;
        unchecked {
            swapOutput =
                CurrencyLib.balanceOf(outputToken, address(this)) -
                beforeBalance;
        }

        if (swapOutput < minOutput) {
            revert SwapOutputInsufficient();
        }

        CurrencyLib.transfer(outputToken, receiver, swapOutput);
        emit Fulfilled(quoteId, outputToken, swapOutput, receiver);
    }

    /// @notice Execute arbitrary signed actions unrelated to quote fulfilment.
    function performActions(
        uint256 nonce,
        Action[] calldata actions,
        bytes calldata signature
    ) external {
        bytes32 messageHash = keccak256(
            abi.encode(block.chainid, address(this), nonce, actions)
        );
        _verifyAndMarkNonce(messageHash, signature, nonce);

        uint256 actionsLength = actions.length;
        for (uint256 i = 0; i < actionsLength; ) {
            if (!_performAction(actions[i])) {
                revert ActionFailed(i);
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Refund vault funds to a receiver for a signed quote.
    function refund(
        bytes32 quoteId,
        uint256 nonce,
        address token,
        uint256 amount,
        address receiver,
        bytes calldata signature
    ) external {
        bytes32 messageHash = _hashFulfilOrRefund(
            REFUND_DISCRIMINATOR,
            quoteId,
            nonce,
            token,
            amount,
            receiver
        );
        _verifyAndMarkQuoteId(messageHash, signature, quoteId);

        CurrencyLib.transfer(token, receiver, amount);
        emit Refunded(quoteId, token, amount, receiver);
    }

    function setSolverSigner(address _solverSigner) external onlyOwner {
        SOLVER_SIGNER = _solverSigner;
    }

    function solverSigner() external view returns (address) {
        return SOLVER_SIGNER;
    }

    /// @notice Mark a quoteId as used to block any further fulfil for this quote.
    /// @dev Permissionless — no financial incentive exists to grief a fulfil.
    ///      Called by the solver on the destination chain before initiating an
    ///      origin-chain refund, preventing race conditions where an in-flight
    ///      fulfil relay lands after the refund is already processed.
    ///      Reverts with InvalidQuoteId if the quoteId was already used.
    function markForRefund(bytes32 quoteId) external {
        _markQuoteId(quoteId);
        isMarkedForRefund[quoteId] = 1;
    }

    function rescueFunds(
        address token_,
        address rescueTo_,
        uint256 amount_
    ) external onlyOwner {
        RescueFundsLib.rescueFunds(token_, rescueTo_, amount_);
    }

    receive() external payable {}

    /// @dev Fixed-size fulfil/refund hash without abi.encode overhead.
    function _hashFulfilOrRefund(
        uint256 discriminator,
        bytes32 quoteId,
        uint256 nonce,
        address token,
        uint256 amount,
        address receiver
    ) internal view returns (bytes32 hash) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainid())
            mstore(add(ptr, 0x20), address())
            mstore(add(ptr, 0x40), discriminator)
            mstore(add(ptr, 0x60), quoteId)
            mstore(add(ptr, 0x80), nonce)
            mstore(add(ptr, 0xa0), token)
            mstore(add(ptr, 0xc0), amount)
            mstore(add(ptr, 0xe0), receiver)
            hash := keccak256(ptr, 0x100)
            mstore(0x40, add(ptr, 0x100))
        }
    }

    function _hashSwapAndFulfil(
        bytes32 quoteId,
        uint256 nonce,
        address approvalToken,
        address approvalSpender,
        uint256 approvalAmount,
        address outputToken,
        uint256 minOutput,
        Action calldata swapAction,
        address receiver
    ) internal view returns (bytes32 hash) {
        bytes32 dataHash = _keccak256CalldataBytes(swapAction.data);

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainid())
            mstore(add(ptr, 0x20), address())
            mstore(add(ptr, 0x40), SWAP_AND_FULFIL_DISCRIMINATOR)
            mstore(add(ptr, 0x60), quoteId)
            mstore(add(ptr, 0x80), nonce)
            mstore(add(ptr, 0xa0), approvalToken)
            mstore(add(ptr, 0xc0), approvalSpender)
            mstore(add(ptr, 0xe0), approvalAmount)
            mstore(add(ptr, 0x100), outputToken)
            mstore(add(ptr, 0x120), minOutput)
            mstore(add(ptr, 0x140), calldataload(swapAction))
            mstore(add(ptr, 0x160), calldataload(add(swapAction, 0x20)))
            mstore(add(ptr, 0x180), dataHash)
            mstore(add(ptr, 0x1a0), receiver)
            hash := keccak256(ptr, 0x1c0)
            mstore(0x40, add(ptr, 0x1c0))
        }
    }

    function _keccak256CalldataBytes(
        bytes calldata data
    ) internal pure returns (bytes32 hash) {
        assembly {
            let ptr := mload(0x40)
            let len := data.length
            calldatacopy(ptr, data.offset, len)
            hash := keccak256(ptr, len)
            mstore(0x40, add(ptr, and(add(len, 0x1f), not(0x1f))))
        }
    }

    function _verifyAndMarkQuoteId(
        bytes32 messageHash,
        bytes calldata signature,
        bytes32 quoteId
    ) internal {
        address signer = SOLVER_SIGNER;
        if (signer != AuthenticationLib.authenticate(messageHash, signature)) {
            assembly {
                mstore(0x00, 0x815e1d64)
                revert(0x1c, 0x04)
            }
        }
        _markQuoteId(quoteId);
    }

    function _verifyAndMarkNonce(
        bytes32 messageHash,
        bytes calldata signature,
        uint256 nonce
    ) internal {
        address signer = SOLVER_SIGNER;
        if (signer != AuthenticationLib.authenticate(messageHash, signature)) {
            assembly {
                mstore(0x00, 0x815e1d64)
                revert(0x1c, 0x04)
            }
        }
        _markNonce(nonce);
    }

    function _markQuoteId(bytes32 quoteId) internal {
        assembly {
            mstore(0, quoteId)
            mstore(0x20, quoteIdUsed.slot)
            let dataSlot := keccak256(0, 0x40)

            if sload(dataSlot) {
                mstore(0x00, 0x140dcdb5)
                revert(0x1c, 0x04)
            }

            sstore(dataSlot, 0x01)
        }
    }

    function _markNonce(uint256 nonce) internal {
        assembly {
            mstore(0, nonce)
            mstore(0x20, nonceUsed.slot)
            let dataSlot := keccak256(0, 0x40)

            if sload(dataSlot) {
                mstore(0x00, 0x756688fe)
                revert(0x1c, 0x04)
            }

            sstore(dataSlot, 0x01)
        }
    }

    /// @dev Does not revert on failure. Caller should check the return value.
    function _performAction(
        Action calldata action
    ) internal returns (bool success) {
        assembly {
            let actionDataLength := calldataload(add(action, 0x60))

            let freeMemPtr := mload(0x40)
            calldatacopy(
                freeMemPtr,
                add(add(action, 0x20), calldataload(add(action, 0x40))),
                actionDataLength
            )

            success := call(
                gas(),
                calldataload(action),
                calldataload(add(action, 0x20)),
                freeMemPtr,
                actionDataLength,
                0,
                0
            )
        }
    }
}
