// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenVaultV1
 * @notice Production-grade UUPS upgradeable token vault — Version 1.
 * @dev Implements basic deposit/withdrawal with configurable fee.
 *
 * Storage Layout (50-slot reservation):
 *   slot 0 : token          (address)
 *   slot 1 : depositFee     (uint256)
 *   slot 2 : _balances      (mapping)
 *   slot 3 : _totalDeposits (uint256)
 *   slots 4-49: __gap       (46 slots)
 */
contract TokenVaultV1 is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // =========================================================================
    // V1 Storage
    // =========================================================================

    IERC20 public token;
    uint256 public depositFee;
    mapping(address => uint256) internal _balances;
    uint256 internal _totalDeposits;

    /// @dev 50 total reserved slots − 4 used = 46 gap slots
    uint256[46] private __gap;

    // =========================================================================
    // Events
    // =========================================================================

    event Deposited(address indexed user, uint256 grossAmount, uint256 netAmount, uint256 fee);
    event Withdrawn(address indexed user, uint256 amount);
    event DepositFeeUpdated(uint256 oldFee, uint256 newFee);

    // =========================================================================
    // Errors
    // =========================================================================

    error ZeroAddress();
    error ZeroAmount();
    error FeeExceedsMaximum(uint256 fee);
    error InsufficientBalance(uint256 requested, uint256 available);

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // =========================================================================
    // Initializer
    // =========================================================================

    function initialize(
        address _token,
        address _admin,
        uint256 _depositFee
    ) external initializer {
        if (_token == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_depositFee > 10_000) revert FeeExceedsMaximum(_depositFee);

        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        token = IERC20(_token);
        depositFee = _depositFee;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
    }

    // =========================================================================
    // External functions — virtual so V2/V3 can override
    // =========================================================================

    function deposit(uint256 amount) external virtual nonReentrant {
        _depositInternal(amount);
    }

    function withdraw(uint256 amount) external virtual nonReentrant {
        _withdrawInternal(amount);
    }

    function balanceOf(address user) external view returns (uint256) {
        return _balances[user];
    }

    function totalDeposits() external view returns (uint256) {
        return _totalDeposits;
    }

    function getDepositFee() external view returns (uint256) {
        return depositFee;
    }

    function getImplementationVersion()
        external
        pure
        virtual
        returns (string memory)
    {
        return "V1";
    }

    // =========================================================================
    // Admin functions
    // =========================================================================

    function setDepositFee(uint256 _newFee)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_newFee > 10_000) revert FeeExceedsMaximum(_newFee);
        uint256 old = depositFee;
        depositFee = _newFee;
        emit DepositFeeUpdated(old, _newFee);
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    function _depositInternal(uint256 amount) internal virtual {
        if (amount == 0) revert ZeroAmount();

        uint256 fee = (amount * depositFee) / 10_000;
        uint256 netAmount = amount - fee;

        token.safeTransferFrom(msg.sender, address(this), amount);

        _balances[msg.sender] += netAmount;
        _totalDeposits += netAmount;

        emit Deposited(msg.sender, amount, netAmount, fee);
    }

    function _withdrawInternal(uint256 amount) internal virtual {
        if (amount == 0) revert ZeroAmount();
        if (_balances[msg.sender] < amount)
            revert InsufficientBalance(amount, _balances[msg.sender]);

        _balances[msg.sender] -= amount;
        _totalDeposits -= amount;

        token.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // =========================================================================
    // UUPS
    // =========================================================================

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {} // solhint-disable-line no-empty-blocks
}
