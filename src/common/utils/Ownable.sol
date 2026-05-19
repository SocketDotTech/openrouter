// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.34;

/// @title Ownable
/// @notice Two-step ownership transfer, ported from
///         marketplace/src/utils/Ownable.sol. Simpler than OpenZeppelin's
///         `Ownable2Step` and matches the rest of the Bungee codebase.
abstract contract Ownable {
    error OnlyOwner();
    error OnlyNominee();

    address private _owner;
    address private _nominee;

    event OwnerNominated(address indexed nominee);
    event OwnerClaimed(address indexed claimer);

    constructor(address owner_) {
        _claimOwner(owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert OnlyOwner();
        }
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function nominee() public view returns (address) {
        return _nominee;
    }

    function nominateOwner(address nominee_) external {
        if (msg.sender != _owner) {
            revert OnlyOwner();
        }
        _nominee = nominee_;
        emit OwnerNominated(nominee_);
    }

    function claimOwner() external {
        if (msg.sender != _nominee) {
            revert OnlyNominee();
        }
        _claimOwner(msg.sender);
    }

    function _claimOwner(address claimer_) internal {
        _owner = claimer_;
        _nominee = address(0);
        emit OwnerClaimed(claimer_);
    }
}
