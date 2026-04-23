// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TokenVaultV2.sol";

/**
 * @title TokenVaultV3
 * @notice Extends V2 with time-delayed withdrawals and an emergency escape hatch.
 *
 * Storage Layout — V3 appends after V2's 100-slot block:
 *   slot 100: withdrawalDelay        (uint256)
 *   slot 101: _withdrawalRequests    (mapping)
 *   slots 102-149: __gapV3           (48 × uint256)
 *
 * Withdrawal flow:
 *   1. requestWithdrawal(amount) — queues request, records timestamp
 *   2. Wait `withdrawalDelay` seconds
 *   3. executeWithdrawal()       — releases funds
 *
 * Emergency: emergencyWithdraw() bypasses delay, transfers entire balance.
 */
contract TokenVaultV3 is TokenVaultV2 {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Types
    // =========================================================================

    struct WithdrawalRequest {
        uint256 amount;
        uint256 requestTime;
    }

    // =========================================================================
    // V3 Storage
    // =========================================================================

    uint256 public withdrawalDelay;
    mapping(address => WithdrawalRequest) internal _withdrawalRequests;

    /// @dev Gap: 50 - 2 new slots = 48
    uint256[48] private __gapV3;

    // =========================================================================
    // Events
    // =========================================================================

    event WithdrawalDelayUpdated(uint256 oldDelay, uint256 newDelay);
    event WithdrawalRequested(address indexed user, uint256 amount, uint256 availableAt);
    event WithdrawalExecuted(address indexed user, uint256 amount);
    event WithdrawalRequestCancelled(address indexed user, uint256 oldAmount);
    event EmergencyWithdrawal(address indexed user, uint256 amount);

    // =========================================================================
    // Errors
    // =========================================================================

    error WithdrawalDelayNotMet(uint256 availableAt, uint256 currentTime);
    error NoPendingWithdrawalRequest();
    error WithdrawalAmountExceedsBalance(uint256 requested, uint256 available);

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // =========================================================================
    // Re-initializer (version 3)
    // =========================================================================

    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV3(uint256 _withdrawalDelay) external reinitializer(3) {
        __ReentrancyGuard_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        withdrawalDelay = _withdrawalDelay;
        emit WithdrawalDelayUpdated(0, _withdrawalDelay);
    }

    // =========================================================================
    // Withdrawal-delay functions
    // =========================================================================

    function setWithdrawalDelay(uint256 _delaySeconds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        uint256 old = withdrawalDelay;
        withdrawalDelay = _delaySeconds;
        emit WithdrawalDelayUpdated(old, _delaySeconds);
    }

    function getWithdrawalDelay() external view returns (uint256) {
        return withdrawalDelay;
    }

    /**
     * @notice Submit a withdrawal request. Cancels any prior pending request.
     */
    function requestWithdrawal(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (_balances[msg.sender] < amount)
            revert WithdrawalAmountExceedsBalance(amount, _balances[msg.sender]);

        if (_withdrawalRequests[msg.sender].amount > 0) {
            emit WithdrawalRequestCancelled(
                msg.sender,
                _withdrawalRequests[msg.sender].amount
            );
        }

        _withdrawalRequests[msg.sender] = WithdrawalRequest({
            amount: amount,
            requestTime: block.timestamp
        });

        emit WithdrawalRequested(
            msg.sender,
            amount,
            block.timestamp + withdrawalDelay
        );
    }

    /**
     * @notice Execute a pending withdrawal after the delay has elapsed.
     */
    function executeWithdrawal() external nonReentrant returns (uint256 amount) {
        WithdrawalRequest storage req = _withdrawalRequests[msg.sender];
        if (req.amount == 0) revert NoPendingWithdrawalRequest();

        uint256 availableAt = req.requestTime + withdrawalDelay;
        if (block.timestamp < availableAt)
            revert WithdrawalDelayNotMet(availableAt, block.timestamp);

        amount = req.amount;
        if (_balances[msg.sender] < amount)
            revert InsufficientBalance(amount, _balances[msg.sender]);

        // CEI: clear state before transfer
        delete _withdrawalRequests[msg.sender];
        _updateYield(msg.sender);
        _balances[msg.sender] -= amount;
        _totalDeposits -= amount;

        token.safeTransfer(msg.sender, amount);
        emit WithdrawalExecuted(msg.sender, amount);
    }

    /**
     * @notice Emergency withdrawal — bypasses delay, transfers entire balance.
     */
    function emergencyWithdraw() external nonReentrant returns (uint256 amount) {
        amount = _balances[msg.sender];
        if (amount == 0) revert ZeroAmount();

        _updateYield(msg.sender);
        _balances[msg.sender] = 0;
        _totalDeposits -= amount;
        delete _withdrawalRequests[msg.sender];

        token.safeTransfer(msg.sender, amount);
        emit EmergencyWithdrawal(msg.sender, amount);
    }

    /**
     * @notice Return the pending withdrawal request for a user.
     */
    function getWithdrawalRequest(address user)
        external
        view
        returns (uint256 amount, uint256 requestTime)
    {
        WithdrawalRequest storage req = _withdrawalRequests[user];
        return (req.amount, req.requestTime);
    }

    // =========================================================================
    // Version
    // =========================================================================

    function getImplementationVersion()
        external
        pure
        virtual
        override
        returns (string memory)
    {
        return "V3";
    }
}
