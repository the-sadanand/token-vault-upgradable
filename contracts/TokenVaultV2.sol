// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TokenVaultV1.sol";

/**
 * @title TokenVaultV2
 * @notice Extends V1 with yield generation (simple interest) and deposit-pause controls.
 *
 * Storage Layout — V2 appends after V1's 50-slot block:
 *   slot 50: yieldRate          (uint256)
 *   slot 51: _userYieldAccrued  (mapping)
 *   slot 52: _lastClaimTime     (mapping)
 *   slot 53: _depositsPaused    (bool)
 *   slots 54-99: __gapV2        (46 × uint256)
 */
contract TokenVaultV2 is TokenVaultV1 {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Additional Role
    // =========================================================================

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // =========================================================================
    // V2 Storage
    // =========================================================================

    /// @notice Annual yield rate in basis points (e.g. 500 = 5%)
    uint256 public yieldRate;

    mapping(address => uint256) internal _userYieldAccrued;
    mapping(address => uint256) internal _lastClaimTime;
    bool internal _depositsPaused;

    /// @dev Gap: 50 - 4 new slots = 46
    uint256[46] private __gapV2;

    // =========================================================================
    // Events
    // =========================================================================

    event YieldRateUpdated(uint256 oldRate, uint256 newRate);
    event YieldClaimed(address indexed user, uint256 amount);
    event DepositsPaused(address indexed by);
    event DepositsUnpaused(address indexed by);

    // =========================================================================
    // Errors
    // =========================================================================

    error DepositsArePaused();
    error NoYieldAvailable();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // =========================================================================
    // Re-initializer (version 2)
    // =========================================================================

    /**
     * @notice Called once during the V1 → V2 upgrade via upgradeToAndCall.
     * @param _yieldRate   Initial annual yield rate in basis points
     * @param _pauser      Address that receives PAUSER_ROLE
     */
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(uint256 _yieldRate, address _pauser)
        external
        reinitializer(2)
    {
        if (_pauser == address(0)) revert ZeroAddress();
        __ReentrancyGuard_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        yieldRate = _yieldRate;
        _grantRole(PAUSER_ROLE, _pauser);
    }

    // =========================================================================
    // Overridden core functions
    // =========================================================================

    function deposit(uint256 amount) external virtual override nonReentrant {
        if (_depositsPaused) revert DepositsArePaused();
        _updateYield(msg.sender);
        _depositInternal(amount);
    }

    function withdraw(uint256 amount) external virtual override nonReentrant {
        _updateYield(msg.sender);
        _withdrawInternal(amount);
    }

    // =========================================================================
    // Yield functions
    // =========================================================================

    function setYieldRate(uint256 _yieldRate)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        uint256 old = yieldRate;
        yieldRate = _yieldRate;
        emit YieldRateUpdated(old, _yieldRate);
    }

    function getYieldRate() external view returns (uint256) {
        return yieldRate;
    }

    function claimYield() external nonReentrant returns (uint256 yieldAmount) {
        _updateYield(msg.sender);
        yieldAmount = _userYieldAccrued[msg.sender];
        if (yieldAmount == 0) revert NoYieldAvailable();
        _userYieldAccrued[msg.sender] = 0;
        token.safeTransfer(msg.sender, yieldAmount);
        emit YieldClaimed(msg.sender, yieldAmount);
    }

    function getUserYield(address user) external view returns (uint256) {
        return _userYieldAccrued[user] + _calculatePendingYield(user);
    }

    // =========================================================================
    // Pause functions
    // =========================================================================

    function pauseDeposits() external onlyRole(PAUSER_ROLE) {
        _depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyRole(PAUSER_ROLE) {
        _depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    function isDepositsPaused() external view returns (bool) {
        return _depositsPaused;
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
        return "V2";
    }

    // =========================================================================
    // Internal yield helpers
    // =========================================================================

    function _updateYield(address user) internal {
        uint256 pending = _calculatePendingYield(user);
        if (pending > 0) {
            _userYieldAccrued[user] += pending;
        }
        _lastClaimTime[user] = block.timestamp;
    }

    function _calculatePendingYield(address user)
        internal
        view
        returns (uint256)
    {
        if (_balances[user] == 0 || yieldRate == 0) return 0;
        uint256 lastTime = _lastClaimTime[user];
        if (lastTime == 0) return 0;
        uint256 timeElapsed = block.timestamp - lastTime;
        return (_balances[user] * yieldRate * timeElapsed) / (365 days * 10_000);
    }
}
