const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");

describe("Upgrade V2 → V3", function () {
  let vaultV2;
  let vaultV3;
  let token;
  let admin;
  let user1;
  let user2;
  let attacker;

  const DEPOSIT_FEE = 500;      // 5%
  const YIELD_RATE = 500;       // 5% annual
  const WITHDRAWAL_DELAY = 60;  // 60 seconds
  const DEPOSIT_AMOUNT = ethers.utils.parseEther("1000");

  const increaseTime = async (seconds) => {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  };

  beforeEach(async function () {
    [admin, user1, user2, attacker] = await ethers.getSigners();

    // ── Token ─────────────────────────────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy(
      "Test Token",
      "TEST",
      ethers.utils.parseEther("10000000")
    );
    await token.deployed();

    await token.mint(user1.address, ethers.utils.parseEther("50000"));
    await token.mint(user2.address, ethers.utils.parseEther("50000"));

    // ── V1 proxy ──────────────────────────────────────────────────────────────
    const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    const vaultV1 = await upgrades.deployProxy(
      TokenVaultV1,
      [token.address, admin.address, DEPOSIT_FEE],
      { kind: "uups" }
    );
    await vaultV1.deployed();

    await token
      .connect(user1)
      .approve(vaultV1.address, ethers.constants.MaxUint256);
    await token
      .connect(user2)
      .approve(vaultV1.address, ethers.constants.MaxUint256);

    // State deposits in V1
    await vaultV1.connect(user1).deposit(DEPOSIT_AMOUNT);
    await vaultV1.connect(user2).deposit(DEPOSIT_AMOUNT);

    // ── Upgrade to V2 ─────────────────────────────────────────────────────────
    const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
    vaultV2 = await upgrades.upgradeProxy(vaultV1.address, TokenVaultV2, {
      kind: "uups",
      call: { fn: "initializeV2", args: [YIELD_RATE, admin.address] },
    });
    await vaultV2.deployed();

    // Advance time so yield accrues in V2
    await increaseTime(30 * 24 * 3600); // 30 days

    // ── Upgrade to V3 ─────────────────────────────────────────────────────────
    const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
    vaultV3 = await upgrades.upgradeProxy(vaultV2.address, TokenVaultV3, {
      kind: "uups",
      call: { fn: "initializeV3", args: [WITHDRAWAL_DELAY] },
    });
    await vaultV3.deployed();
  });

  // =========================================================================
  // State preservation across V2 → V3
  // =========================================================================

  it("should preserve all V2 state after upgrade", async function () {
    // User balances
    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const expected = DEPOSIT_AMOUNT.sub(fee);
    expect(await vaultV3.balanceOf(user1.address)).to.equal(expected);
    expect(await vaultV3.balanceOf(user2.address)).to.equal(expected);

    // Total deposits
    expect(await vaultV3.totalDeposits()).to.equal(expected.mul(2));

    // Fee
    expect(await vaultV3.getDepositFee()).to.equal(DEPOSIT_FEE);

    // Token
    expect(await vaultV3.token()).to.equal(token.address);

    // Yield rate
    expect(await vaultV3.getYieldRate()).to.equal(YIELD_RATE);

    // Pause state
    expect(await vaultV3.isDepositsPaused()).to.be.false;

    // Roles
    const ADMIN_ROLE = await vaultV3.DEFAULT_ADMIN_ROLE();
    expect(await vaultV3.hasRole(ADMIN_ROLE, admin.address)).to.be.true;

    // Version string
    expect(await vaultV3.getImplementationVersion()).to.equal("V3");
  });

  // =========================================================================
  // Withdrawal delay configuration
  // =========================================================================

  it("should allow setting withdrawal delay", async function () {
    const newDelay = 3600; // 1 hour
    await vaultV3.connect(admin).setWithdrawalDelay(newDelay);
    expect(await vaultV3.getWithdrawalDelay()).to.equal(newDelay);
  });

  it("should prevent non-admin from setting withdrawal delay", async function () {
    await expect(
      vaultV3.connect(attacker).setWithdrawalDelay(3600)
    ).to.be.reverted;
  });

  // =========================================================================
  // Withdrawal request flow
  // =========================================================================

  it("should handle withdrawal requests correctly", async function () {
    const balance = await vaultV3.balanceOf(user1.address);

    const tx = await vaultV3.connect(user1).requestWithdrawal(balance);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const [reqAmount, reqTime] = await vaultV3.getWithdrawalRequest(
      user1.address
    );

    expect(reqAmount).to.equal(balance);
    expect(reqTime).to.equal(block.timestamp);
  });

  it("should enforce withdrawal delay", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    await vaultV3.connect(user1).requestWithdrawal(balance);

    // Attempting to execute before delay should revert
    await expect(vaultV3.connect(user1).executeWithdrawal()).to.be.reverted;
  });

  it("should prevent premature withdrawal execution", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    await vaultV3.connect(user1).requestWithdrawal(balance);

    // Only advance half the delay
    await increaseTime(Math.floor(WITHDRAWAL_DELAY / 2));

    await expect(vaultV3.connect(user1).executeWithdrawal()).to.be.reverted;
  });

  it("should execute withdrawal after delay has elapsed", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    await vaultV3.connect(user1).requestWithdrawal(balance);

    await increaseTime(WITHDRAWAL_DELAY + 1);

    const tokenBefore = await token.balanceOf(user1.address);
    await vaultV3.connect(user1).executeWithdrawal();
    const tokenAfter = await token.balanceOf(user1.address);

    expect(tokenAfter.sub(tokenBefore)).to.equal(balance);
    expect(await vaultV3.balanceOf(user1.address)).to.equal(0);

    // Request should be cleared
    const [reqAmount] = await vaultV3.getWithdrawalRequest(user1.address);
    expect(reqAmount).to.equal(0);
  });

  it("should cancel previous request when a new one is submitted", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    const half = balance.div(2);

    await vaultV3.connect(user1).requestWithdrawal(balance);
    await vaultV3.connect(user1).requestWithdrawal(half); // overwrites

    const [reqAmount] = await vaultV3.getWithdrawalRequest(user1.address);
    expect(reqAmount).to.equal(half);
  });

  it("should revert executeWithdrawal when no request exists", async function () {
    await expect(vaultV3.connect(user1).executeWithdrawal()).to.be.reverted;
  });

  // =========================================================================
  // Emergency withdrawal
  // =========================================================================

  it("should allow emergency withdrawals", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    const tokenBefore = await token.balanceOf(user1.address);

    await vaultV3.connect(user1).emergencyWithdraw();

    const tokenAfter = await token.balanceOf(user1.address);
    expect(tokenAfter.sub(tokenBefore)).to.equal(balance);
    expect(await vaultV3.balanceOf(user1.address)).to.equal(0);
  });

  it("should clear pending withdrawal request on emergency withdraw", async function () {
    const balance = await vaultV3.balanceOf(user1.address);
    await vaultV3.connect(user1).requestWithdrawal(balance);

    await vaultV3.connect(user1).emergencyWithdraw();

    const [reqAmount] = await vaultV3.getWithdrawalRequest(user1.address);
    expect(reqAmount).to.equal(0);
  });

  it("should revert emergencyWithdraw when balance is zero", async function () {
    await vaultV3.connect(user1).emergencyWithdraw(); // clears balance

    await expect(vaultV3.connect(user1).emergencyWithdraw()).to.be.reverted;
  });

  it("should bypass withdrawal delay with emergency withdraw", async function () {
    // Set a very long delay
    await vaultV3.connect(admin).setWithdrawalDelay(30 * 24 * 3600);

    const balance = await vaultV3.balanceOf(user2.address);
    await vaultV3.connect(user2).requestWithdrawal(balance);

    // Emergency withdraw should succeed immediately
    await expect(vaultV3.connect(user2).emergencyWithdraw()).to.not.be.reverted;
  });

  // =========================================================================
  // Total deposits consistency
  // =========================================================================

  it("should correctly update totalDeposits after executeWithdrawal", async function () {
    const totalBefore = await vaultV3.totalDeposits();
    const balance = await vaultV3.balanceOf(user1.address);

    await vaultV3.connect(user1).requestWithdrawal(balance);
    await increaseTime(WITHDRAWAL_DELAY + 1);
    await vaultV3.connect(user1).executeWithdrawal();

    expect(await vaultV3.totalDeposits()).to.equal(
      totalBefore.sub(balance)
    );
  });
});
