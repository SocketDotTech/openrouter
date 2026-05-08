// SPDX-License-Identifier: GPL-3.0-only
pragma solidity =0.8.25;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

import {OpenRouterAuthBase} from "../common/OpenRouterAuthBase.sol";
import {BytesSpliceLib} from "../common/lib/BytesSpliceLib.sol";
import {CurrencyLib} from "../common/lib/CurrencyLib.sol";

/// @title BungeeOpenRouter (v1, monolithic)
/// @notice Monolithic, opinionated open-router: pulls ERC20 funds from a user
///         via standard ERC20 `transferFrom`, optionally takes a pre-swap fee,
///         optionally performs a swap, optionally takes a post-swap fee, then
///         executes a single arbitrary bridge call where the final amount is
///         spliced into the bridge calldata at a list of byte positions.
///
///         This version is the easiest to reason about because every step is
///         laid out explicitly. The trade-off is rigidity - if a route needs
///         a different ordering or a multi-call bridge interaction, see the
///         modular variants (`BungeeOpenRouterModular`, `BungeeOpenRouterMinimal`).
///
/// @dev Authentication is matched to `Solver` / `StakedRouterReceiver`:
///        - personal_sign + ecrecover via `AuthenticationLib`
///        - single-use nonces marked with the same assembly pattern
///        - signed digest binds `block.chainid` and `address(this)` so that a
///          payload meant for one deployment cannot be replayed elsewhere.
///        - the user, input token + amount, both fee transfers, the swap,
///          and the bridge calldata are ALL part of the signed payload, so a
///          malicious caller cannot redirect funds.
contract BungeeOpenRouter is OpenRouterAuthBase {
    // marked virtual so AllowanceHolder variants can override the pull step
    // without duplicating the rest of the body.
    using SafeTransferLib for address;

    /// @notice Who is sending funds and how much.
    struct InputData {
        address user;
        address inputToken;
        uint256 inputAmount;
    }

    /// @notice Optional fee taken in the input token before a swap, or in the
    ///         bridge token when there is no swap. Set `receiver` to address(0)
    ///         and `amount` to 0 to skip.
    struct FeeData {
        address receiver;
        uint256 amount;
    }

    /// @notice Optional swap step. Set `target` to address(0) to skip entirely.
    struct SwapData {
        address target;
        address approvalSpender; // 0 to skip ERC20 approval
        address outputToken; // token measured for balance delta
        uint256 value; // ETH forwarded to the swap target
        uint256 minOutput; // minimum balance delta; reverts if not met
        bytes data;
    }

    /// @notice Mandatory bridge call. `amountPositions` lists every byte offset
    ///         in `data` where the final amount (post-fees) must be written
    ///         before dispatching the call.
    struct BridgeData {
        address target;
        address approvalSpender; // 0 to skip ERC20 approval
        uint256 value; // ETH forwarded to the bridge target
        bytes data;
        uint256[] amountPositions;
    }

    /// @notice Full signed payload for one execution.
    /// @dev Signed via personal_sign over keccak256(abi.encode(chainid, this, exec)).
    struct Execution {
        InputData input;
        FeeData preFee; // taken in inputToken before swap
        SwapData swap;
        FeeData postFee; // taken in finalToken after swap
        BridgeData bridge;
        uint256 nonce;
        uint256 deadline;
    }

    error SwapOutputInsufficient();
    error InsufficientFunds();
    error InvalidExecution();

    constructor(address _owner, address _openRouterSigner) OpenRouterAuthBase(_owner, _openRouterSigner) {}

    receive() external payable {}

    /// @notice Executes the signed payload end-to-end.
    /// @dev Anyone can call this; the security boundary is the signature.
    function performExecution(Execution calldata exec, bytes calldata signature) external payable {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), exec));
        _verifyAndConsume(digest, exec.nonce, exec.deadline, signature);

        if (exec.bridge.target == address(0) || exec.input.user == address(0) || exec.input.inputToken == address(0)) {
            revert InvalidExecution();
        }

        // 1. pull funds from user; ERC20 transferFrom on the base contract,
        //    AllowanceHolder transferFrom on the AH variant.
        _pullFromUser(exec.input.inputToken, exec.input.user, exec.input.inputAmount);

        // 2. optional pre-swap fee in input token
        if (exec.preFee.amount != 0) {
            CurrencyLib.transfer(exec.input.inputToken, exec.preFee.receiver, exec.preFee.amount);
        }

        // 3. optional swap, accounted via balance delta
        address finalToken;
        uint256 finalAmount;
        if (exec.swap.target != address(0)) {
            (finalToken, finalAmount) = _performSwap(exec);
        } else {
            // no swap path: input minus pre-fee is what we have on-hand
            if (exec.preFee.amount > exec.input.inputAmount) {
                revert InsufficientFunds();
            }
            finalToken = exec.input.inputToken;
            unchecked {
                finalAmount = exec.input.inputAmount - exec.preFee.amount;
            }
        }

        // 4. optional post-swap fee in final token
        if (exec.postFee.amount != 0) {
            if (exec.postFee.amount > finalAmount) {
                revert InsufficientFunds();
            }
            CurrencyLib.transfer(finalToken, exec.postFee.receiver, exec.postFee.amount);
            unchecked {
                finalAmount -= exec.postFee.amount;
            }
        }

        // 5. patch bridge calldata with final amount at every signed position
        bytes memory bridgeData = exec.bridge.data;
        BytesSpliceLib.spliceWords({data: bridgeData, positions: exec.bridge.amountPositions, word: finalAmount});

        // 6. optional approval to the bridge spender (no-op if same as target via permit / native)
        if (exec.bridge.approvalSpender != address(0) && finalToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            SafeTransferLib.safeApproveWithRetry(finalToken, exec.bridge.approvalSpender, finalAmount);
        }

        // 7. dispatch the bridge call, bubbling any revert
        _performAction(exec.bridge.target, exec.bridge.value, bridgeData);
    }

    /// @notice Hook for pulling `amount` of `token` from `user` into this
    ///         contract. Default uses ERC20 transferFrom; the AllowanceHolder
    ///         variant overrides this to call AllowanceHolder.
    function _pullFromUser(address token, address user, uint256 amount) internal virtual {
        SafeTransferLib.safeTransferFrom(token, user, address(this), amount);
    }

    /// @dev Split out so the main `performExecution` body stays under the
    ///      marketplace "≤ 100 lines / SRP" guideline.
    function _performSwap(Execution calldata exec) internal returns (address finalToken, uint256 finalAmount) {
        // Snapshot pre-swap balance of the swap output token on this contract.
        uint256 preBalance = CurrencyLib.balanceOf(exec.swap.outputToken, address(this));

        // Approve swap router to pull the input token if it expects an allowance.
        if (exec.swap.approvalSpender != address(0) && exec.input.inputToken != CurrencyLib.NATIVE_TOKEN_ADDRESS) {
            // amount available for swap = inputAmount - preFee
            uint256 swapInput;
            unchecked {
                swapInput = exec.input.inputAmount - exec.preFee.amount;
            }
            SafeTransferLib.safeApproveWithRetry(exec.input.inputToken, exec.swap.approvalSpender, swapInput);
        }

        _performAction(exec.swap.target, exec.swap.value, exec.swap.data);

        uint256 postBalance = CurrencyLib.balanceOf(exec.swap.outputToken, address(this));
        if (postBalance < preBalance) {
            revert SwapOutputInsufficient();
        }
        uint256 delta;
        unchecked {
            delta = postBalance - preBalance;
        }
        if (delta < exec.swap.minOutput) {
            revert SwapOutputInsufficient();
        }

        finalToken = exec.swap.outputToken;
        finalAmount = delta;
    }
}
