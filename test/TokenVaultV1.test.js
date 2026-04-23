const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");

describe("TokenVaultV1", function () {
  let vault;
  let token;
  let admin;
  let user1;
  let user2;
  let attacker;

  const DEPOSIT_FEE = 500; // 5%
  const INITIAL_SUPPLY = ethers.utils.parseEther("1000000");
  const DEPOSIT_AMOUNT = ethers.utils.parseEther("1000");

  let TokenVaultV1;

  beforeEach(async function () {
    [admin, user1, user2, attacker] = await ethers.getSigners();

    // Deploy mock ERC-20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Test Token", "TEST", INITIAL_SUPPLY);
    await token.deployed();

    // Mint tokens to users
    await token.mint(user1.address, ethers.utils.parseEther("10000"));
    await token.mint(user2.address, ethers.utils.parseEther("10000"));

    // Deploy vault as UUPS proxy
    TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    vault = await upgrades.deployProxy(
      TokenVaultV1,
      [token.address, admin.address, DEPOSIT_FEE],
      { kind: "uups" }
    );
    await vault.deployed();

    // Approve vault to spend tokens
    await token.connect(user1).approve(vault.address, ethers.constants.MaxUint256);
    await token.connect(user2).approve(vault.address, ethers.constants.MaxUint256);
  });

  // =========================================================================
  // Initialisation
  // =========================================================================

  it("should initialize with correct parameters", async function () {
    expect(await vault.token()).to.equal(token.address);
    expect(await vault.getDepositFee()).to.equal(DEPOSIT_FEE);
    expect(await vault.getImplementationVersion()).to.equal("V1");

    const ADMIN_ROLE = await vault.DEFAULT_ADMIN_ROLE();
    const UPGRADER_ROLE = await vault.UPGRADER_ROLE();
    expect(await vault.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    expect(await vault.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
  });

  // =========================================================================
  // Deposits
  // =========================================================================

  it("should allow deposits and update balances", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);

    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const expectedBalance = DEPOSIT_AMOUNT.sub(fee);

    expect(await vault.balanceOf(user1.address)).to.equal(expectedBalance);
    expect(await vault.totalDeposits()).to.equal(expectedBalance);
  });

  it("should deduct deposit fee correctly", async function () {
    const depositAmount = ethers.utils.parseEther("1000");
    const userBalanceBefore = await token.balanceOf(user1.address);

    await vault.connect(user1).deposit(depositAmount);

    const userBalanceAfter = await token.balanceOf(user1.address);
    const vaultBalance = await token.balanceOf(vault.address);

    // User loses the full gross amount
    expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(depositAmount);

    // Vault holds the full gross amount
    expect(vaultBalance).to.equal(depositAmount);

    // User's internal credit is net (after 5% fee)
    const fee = depositAmount.mul(DEPOSIT_FEE).div(10_000); // 50 tokens
    const expectedCredit = depositAmount.sub(fee);           // 950 tokens
    expect(await vault.balanceOf(user1.address)).to.equal(expectedCredit);
    expect(await vault.totalDeposits()).to.equal(expectedCredit);
  });

  it("should allow multiple deposits by the same user", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);

    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const netPerDeposit = DEPOSIT_AMOUNT.sub(fee);
    expect(await vault.balanceOf(user1.address)).to.equal(netPerDeposit.mul(2));
  });

  it("should track total deposits across multiple users", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);
    await vault.connect(user2).deposit(DEPOSIT_AMOUNT);

    const fee = DEPOSIT_AMOUNT.mul(DEPOSIT_FEE).div(10_000);
    const net = DEPOSIT_AMOUNT.sub(fee);
    expect(await vault.totalDeposits()).to.equal(net.mul(2));
  });

  it("should revert when deposit amount is zero", async function () {
    await expect(vault.connect(user1).deposit(0)).to.be.reverted;
  });

  // =========================================================================
  // Withdrawals
  // =========================================================================

  it("should allow withdrawals and update balances", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);

    const credit = await vault.balanceOf(user1.address);
    const tokenBalBefore = await token.balanceOf(user1.address);

    await vault.connect(user1).withdraw(credit);

    expect(await vault.balanceOf(user1.address)).to.equal(0);
    expect(await vault.totalDeposits()).to.equal(0);

    const tokenBalAfter = await token.balanceOf(user1.address);
    expect(tokenBalAfter.sub(tokenBalBefore)).to.equal(credit);
  });

  it("should prevent withdrawal of more than balance", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);
    const credit = await vault.balanceOf(user1.address);

    await expect(
      vault.connect(user1).withdraw(credit.add(1))
    ).to.be.reverted;
  });

  it("should revert when withdraw amount is zero", async function () {
    await expect(vault.connect(user1).withdraw(0)).to.be.reverted;
  });

  it("should revert withdrawal when user has no balance", async function () {
    await expect(
      vault.connect(user1).withdraw(ethers.utils.parseEther("1"))
    ).to.be.reverted;
  });

  it("should allow partial withdrawals", async function () {
    await vault.connect(user1).deposit(DEPOSIT_AMOUNT);
    const credit = await vault.balanceOf(user1.address);
    const half = credit.div(2);

    await vault.connect(user1).withdraw(half);
    expect(await vault.balanceOf(user1.address)).to.equal(credit.sub(half));
  });

  // =========================================================================
  // Initialisation security
  // =========================================================================

  it("should prevent reinitialization", async function () {
    await expect(
      vault.initialize(token.address, admin.address, DEPOSIT_FEE)
    ).to.be.reverted;
  });

  it("should prevent direct initialization of the implementation contract", async function () {
    const implAddress = await upgrades.erc1967.getImplementationAddress(
      vault.address
    );
    const impl = TokenVaultV1.attach(implAddress);
    await expect(
      impl.initialize(token.address, admin.address, DEPOSIT_FEE)
    ).to.be.reverted;
  });

  // =========================================================================
  // Access control
  // =========================================================================

  it("should prevent unauthorized upgrade attempts", async function () {
    const TokenVaultV1New = await ethers.getContractFactory("TokenVaultV1");
    const newImpl = await TokenVaultV1New.deploy();
    await newImpl.deployed();

    await expect(
      vault.connect(attacker).upgradeTo(newImpl.address)
    ).to.be.reverted;
  });
});
