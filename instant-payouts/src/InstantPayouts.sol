// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Holds native Base USDC and pays each authorized payout ID once.
/// @dev Owner token rescue is an explicit exception to payout-ID protection.
contract InstantPayouts is Ownable2Step, EIP712 {
    using SafeERC20 for IERC20;

    IERC20 public constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    bytes32 public constant PAYOUT_TYPEHASH =
        keccak256("Payout(bytes32 payoutId,address recipient,uint256 amount,uint256 deadline)");

    address public payoutSigner;
    mapping(bytes32 payoutId => bool) public used;

    error NativeTransferFailed();
    error InvalidSigner();
    error InvalidPayout();
    error PayoutExpired();
    error PayoutAlreadyUsed(bytes32 payoutId);

    event PayoutSignerChanged(address indexed previousSigner, address indexed newSigner);
    event NativeRescued(address indexed recipient, uint256 amount);
    event Paid(bytes32 indexed payoutId, address indexed recipient, uint256 amount);
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);

    constructor(address initialOwner, address signer) Ownable(initialOwner) EIP712("DTF Instant Payouts", "1") {
        if (signer == address(0)) revert InvalidSigner();
        payoutSigner = signer;
    }

    receive() external payable {}

    /// @notice Change the signer without changing paid IDs or the signed message.
    /// @dev Selecting an old signer restores its unused, unexpired authorizations.
    function setPayoutSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidSigner();
        address previousSigner = payoutSigner;
        payoutSigner = signer;
        emit PayoutSignerChanged(previousSigner, signer);
    }

    /// @notice Owner can recover native currency sent to this contract.
    function rescueNative(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidPayout();
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit NativeRescued(recipient, amount);
    }

    /// @notice Anyone can submit a valid KMS authorization. The receiver is signed.
    /// @param amount Native USDC units (six decimal places).
    /// @param deadline Last valid Unix timestamp, inclusive.
    function payout(bytes32 payoutId, address recipient, uint256 amount, uint256 deadline, bytes calldata signature)
        external
    {
        if (
            payoutId == bytes32(0) || recipient == address(0) || recipient == address(this)
                || recipient == address(USDC) || amount == 0
        ) revert InvalidPayout();
        if (used[payoutId]) revert PayoutAlreadyUsed(payoutId);
        if (block.timestamp > deadline) revert PayoutExpired();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(PAYOUT_TYPEHASH, payoutId, recipient, amount, deadline)));
        if (ECDSA.recover(digest, signature) != payoutSigner) revert InvalidSigner();

        used[payoutId] = true;
        USDC.safeTransfer(recipient, amount);
        emit Paid(payoutId, recipient, amount);
    }

    /// @notice Owner can move any ERC-20 token without a payout signature or ID.
    /// @dev This function can bypass customer payout-ID protection by design.
    function rescueToken(IERC20 token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidPayout();
        token.safeTransfer(recipient, amount);
        emit TokenRescued(address(token), recipient, amount);
    }
}
