const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");

describe("Upgrade V1 → V2", function () {
  let proxy;       // vault proxy address (stays constant)
  let vaultV1;     // proxy typed as V1
  let vaultV2;     // proxy typed as V2
  let token;
  let admin;
  let user1;
  let user2;
  let attacker;

  const DEPOSIT_FEE = 500; // 5%
  const YIELD_RATE = 500;  // 5% annual
  const DEPOSIT_AMOUNT = ethers.utils.parseEther("1000");

  // Helpers
  const increaseTime = async (seconds) => {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  };

  beforeEach(async function () {
    [admin, user1, user2, attacker] = await ethers.getSigners();

    // ── Deploy token ──────────────────────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy(
      "Test Token",
      "TEST",
      ethers.utils.parseEther("10000000")
    );
    await token.deployed();

    await token.mint(user1.address, ethers.utils.parseEther("50000"));
    await token.mint(user2.address, ethers.utils.parseEther("50000"));

    // ── Deploy V1 proxy ───────────────────────────────────────────────────────
    const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    vaultV1 = await upgrades.deployProxy(
      TokenVaultV1,
      [token.address, admin.address, DEPOSIT_FEE],
      { kind: "uups" }
    );
    await vaultV1.deployed();

    // ── Approve ───────────────────────────────────────────────────────────────
    await token
      .connect(user1)
      .approve(vaultV1.address, ethers.constants.MaxUint256);
    await token
      .connect(user2)
      .approve(vaultV1.address, ethers.constants.MaxUint256);

    // ── State in V1: user1 and user2 deposit ──────────────────────────────────
    await vaultV1.connect(user1).deposit(DEPOSIT_AMOUNT);
    await vaultV1.connect(user2).deposit(DEPOSIT_AMOUNT);

    // ── Upgrade to V2 ─────────────────────────────────────────────────────────
    const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
    vaultV2 = await upgrades.upgradeProxy(vaultV1.address, TokenVaultV2, {
      kind: "uups",
      call: {
        fn: "initializeV2",
        args: [YIELD_RATE, admin.address], // admin gets PAUSER_ROLE
      },
    });
    await vaultV2.deployed();
  });

  // =========================================================================
  // State preservation
  // =========================================================================

  it("should preserve user balances after upgrade", async function () {
    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const expectedBalance = DEPOSIT_AMOUNT.sub(fee);

    expect(await vaultV2.balanceOf(user1.address)).to.equal(expectedBalance);
    expect(await vaultV2.balanceOf(user2.address)).to.equal(expectedBalance);
  });

  it("should preserve total deposits after upgrade", async function () {
    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const netPerUser = DEPOSIT_AMOUNT.sub(fee);
    const expectedTotal = netPerUser.mul(2);

    expect(await vaultV2.totalDeposits()).to.equal(expectedTotal);
  });

  it("should preserve the deposit fee after upgrade", async function () {
    expect(await vaultV2.getDepositFee()).to.equal(DEPOSIT_FEE);
  });

  it("should preserve the token address after upgrade", async function () {
    expect(await vaultV2.token()).to.equal(token.address);
  });

  it("should report V2 implementation version", async function () {
    expect(await vaultV2.getImplementationVersion()).to.equal("V2");
  });

  // =========================================================================
  // Access control preservation
  // =========================================================================

  it("should maintain admin access control after upgrade", async function () {
    const ADMIN_ROLE = await vaultV2.DEFAULT_ADMIN_ROLE();
    const UPGRADER_ROLE = await vaultV2.UPGRADER_ROLE();
    const PAUSER_ROLE = await vaultV2.PAUSER_ROLE();

    expect(await vaultV2.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    expect(await vaultV2.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    expect(await vaultV2.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
  });

  it("should not grant roles to non-admin users after upgrade", async function () {
    const ADMIN_ROLE = await vaultV2.DEFAULT_ADMIN_ROLE();
    expect(await vaultV2.hasRole(ADMIN_ROLE, user1.address)).to.be.false;
    expect(await vaultV2.hasRole(ADMIN_ROLE, attacker.address)).to.be.false;
  });

  // =========================================================================
  // Yield functionality
  // =========================================================================

  it("should allow setting yield rate in V2", async function () {
    const newRate = 1000; // 10%
    await vaultV2.connect(admin).setYieldRate(newRate);
    expect(await vaultV2.getYieldRate()).to.equal(newRate);
  });

  it("should calculate yield correctly", async function () {
    // Re-deposit so lastClaimTime is recorded
    await token
      .connect(user1)
      .approve(vaultV2.address, ethers.constants.MaxUint256);
    await vaultV2.connect(user1).deposit(DEPOSIT_AMOUNT);

    const balance = await vaultV2.balanceOf(user1.address);
    const elapsedSeconds = 365 * 24 * 3600; // 1 year

    await increaseTime(elapsedSeconds);

    const expectedYield = balance.mul(YIELD_RATE).div(10_000); // 5%
    const actualYield = await vaultV2.getUserYield(user1.address);

    // Allow ≤ 0.01 token tolerance for block-time imprecision
    const tolerance = ethers.utils.parseEther("0.01");
    expect(actualYield).to.be.closeTo(expectedYield, tolerance);
  });

  it("should accumulate yield over multiple periods", async function () {
    await token
      .connect(user1)
      .approve(vaultV2.address, ethers.constants.MaxUint256);
    await vaultV2.connect(user1).deposit(DEPOSIT_AMOUNT);

    const balance = await vaultV2.balanceOf(user1.address);
    const halfYear = Math.floor(365 * 24 * 3600 / 2);

    await increaseTime(halfYear);
    const yield1 = await vaultV2.getUserYield(user1.address);

    await increaseTime(halfYear);
    const yield2 = await vaultV2.getUserYield(user1.address);

    // Yield at 1 year ≈ 2× yield at 6 months
    const tolerance = ethers.utils.parseEther("0.01");
    expect(yield2).to.be.closeTo(yield1.mul(2), tolerance);
  });

  it("should reset yield after claiming", async function () {
    await token
      .connect(user1)
      .approve(vaultV2.address, ethers.constants.MaxUint256);
    await vaultV2.connect(user1).deposit(DEPOSIT_AMOUNT);

    await increaseTime(365 * 24 * 3600);

    // Mint extra tokens to vault so it can pay yield
    await token.mint(vaultV2.address, ethers.utils.parseEther("10000"));

    await vaultV2.connect(user1).claimYield();

    // Immediately after claiming, pending yield should be near zero
    const yieldAfterClaim = await vaultV2.getUserYield(user1.address);
    expect(yieldAfterClaim).to.be.lt(ethers.utils.parseEther("0.001"));
  });

  it("should prevent non-admin from setting yield rate", async function () {
    await expect(
      vaultV2.connect(attacker).setYieldRate(1000)
    ).to.be.reverted;

    await expect(
      vaultV2.connect(user1).setYieldRate(1000)
    ).to.be.reverted;
  });

  // =========================================================================
  // Pause functionality
  // =========================================================================

  it("should allow pausing deposits in V2", async function () {
    await vaultV2.connect(admin).pauseDeposits();
    expect(await vaultV2.isDepositsPaused()).to.be.true;

    await token
      .connect(user1)
      .approve(vaultV2.address, ethers.constants.MaxUint256);

    await expect(
      vaultV2.connect(user1).deposit(DEPOSIT_AMOUNT)
    ).to.be.reverted;
  });

  it("should allow unpausing deposits in V2", async function () {
    await vaultV2.connect(admin).pauseDeposits();
    await vaultV2.connect(admin).unpauseDeposits();

    expect(await vaultV2.isDepositsPaused()).to.be.false;

    await token
      .connect(user1)
      .approve(vaultV2.address, ethers.constants.MaxUint256);

    await expect(vaultV2.connect(user1).deposit(DEPOSIT_AMOUNT)).to.not.be
      .reverted;
  });

  it("should prevent non-pauser from pausing deposits", async function () {
    await expect(vaultV2.connect(attacker).pauseDeposits()).to.be.reverted;
    await expect(vaultV2.connect(user1).pauseDeposits()).to.be.reverted;
  });

  it("should allow withdrawals even when deposits are paused", async function () {
    await vaultV2.connect(admin).pauseDeposits();
    const balance = await vaultV2.balanceOf(user1.address);

    await expect(vaultV2.connect(user1).withdraw(balance)).to.not.be.reverted;
  });

  // =========================================================================
  // Proxy address unchanged
  // =========================================================================

  it("should keep the same proxy address after upgrade", async function () {
    expect(vaultV2.address).to.equal(vaultV1.address);
  });
});
