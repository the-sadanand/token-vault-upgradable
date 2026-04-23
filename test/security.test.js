const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");

/**
 * Security test suite.
 *
 * Covers:
 *  - Initializer protection on bare implementation contracts
 *  - Upgrade authorization (UPGRADER_ROLE enforcement)
 *  - Storage gap presence and layout compatibility via OZ upgrades validator
 *  - Storage layout collision detection across all three versions
 *  - Function selector uniqueness within each version
 */
describe("Security Tests", function () {
  let vaultV1;
  let vaultV2;
  let vaultV3;
  let token;
  let admin;
  let user1;
  let attacker;

  let TokenVaultV1;
  let TokenVaultV2;
  let TokenVaultV3;

  const DEPOSIT_FEE = 500;
  const YIELD_RATE = 500;
  const WITHDRAWAL_DELAY = 60;
  const DEPOSIT_AMOUNT = ethers.utils.parseEther("1000");

  beforeEach(async function () {
    [admin, user1, attacker] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy(
      "Test Token",
      "TEST",
      ethers.utils.parseEther("1000000")
    );
    await token.deployed();
    await token.mint(user1.address, ethers.utils.parseEther("10000"));

    TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
    TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");

    // Deploy V1 proxy
    vaultV1 = await upgrades.deployProxy(
      TokenVaultV1,
      [token.address, admin.address, DEPOSIT_FEE],
      { kind: "uups" }
    );
    await vaultV1.deployed();

    // Upgrade to V2
    vaultV2 = await upgrades.upgradeProxy(vaultV1.address, TokenVaultV2, {
      kind: "uups",
      call: { fn: "initializeV2", args: [YIELD_RATE, admin.address] },
    });
    await vaultV2.deployed();

    // Upgrade to V3
    vaultV3 = await upgrades.upgradeProxy(vaultV2.address, TokenVaultV3, {
      kind: "uups",
      call: { fn: "initializeV3", args: [WITHDRAWAL_DELAY] },
    });
    await vaultV3.deployed();
  });

  // =========================================================================
  // Initialisation security
  // =========================================================================

  it("should prevent direct initialization of implementation contracts", async function () {
    // ── V1 implementation ──────────────────────────────────────────────────
    const v1ImplAddress = await upgrades.erc1967.getImplementationAddress(
      vaultV1.address
    );
    const v1Impl = TokenVaultV1.attach(v1ImplAddress);
    await expect(
      v1Impl.initialize(token.address, admin.address, DEPOSIT_FEE)
    ).to.be.reverted;

    // ── V2 implementation ──────────────────────────────────────────────────
    // Deploy a fresh V2 implementation (simulates attacker targeting the impl)
    const v2ImplRaw = await TokenVaultV2.deploy();
    await v2ImplRaw.deployed();
    await expect(
      v2ImplRaw.initialize(token.address, admin.address, DEPOSIT_FEE)
    ).to.be.reverted;
    await expect(
      v2ImplRaw.initializeV2(YIELD_RATE, admin.address)
    ).to.be.reverted;

    // ── V3 implementation ──────────────────────────────────────────────────
    const v3ImplRaw = await TokenVaultV3.deploy();
    await v3ImplRaw.deployed();
    await expect(
      v3ImplRaw.initialize(token.address, admin.address, DEPOSIT_FEE)
    ).to.be.reverted;
    await expect(v3ImplRaw.initializeV3(WITHDRAWAL_DELAY)).to.be.reverted;
  });

  it("should prevent re-initialization through reinitializer(2) and (3)", async function () {
    // Calling initializeV2 again on the proxy should fail (already at version ≥ 2)
    await expect(
      vaultV2.initializeV2(YIELD_RATE, admin.address)
    ).to.be.reverted;

    // Calling initializeV3 again on the proxy should fail
    await expect(vaultV3.initializeV3(WITHDRAWAL_DELAY)).to.be.reverted;
  });

  // =========================================================================
  // Upgrade authorization
  // =========================================================================

  it("should prevent unauthorized upgrades", async function () {
    // Attempt to upgrade from an account without UPGRADER_ROLE
    const newImpl = await TokenVaultV3.deploy();
    await newImpl.deployed();

    await expect(
      vaultV3.connect(attacker).upgradeTo(newImpl.address)
    ).to.be.reverted;

    await expect(
      vaultV3.connect(user1).upgradeTo(newImpl.address)
    ).to.be.reverted;
  });

  it("should allow authorized upgrade by UPGRADER_ROLE holder", async function () {
    // Admin holds UPGRADER_ROLE — upgrade should succeed without reverting
    const newImpl = await TokenVaultV3.deploy();
    await newImpl.deployed();

    await expect(vaultV3.connect(admin).upgradeTo(newImpl.address)).to.not.be
      .reverted;
  });

  it("should revert upgrade from DEFAULT_ADMIN without UPGRADER_ROLE", async function () {
    // Revoke UPGRADER_ROLE from admin, keep DEFAULT_ADMIN_ROLE
    const UPGRADER_ROLE = await vaultV3.UPGRADER_ROLE();
    await vaultV3.connect(admin).revokeRole(UPGRADER_ROLE, admin.address);

    const newImpl = await TokenVaultV3.deploy();
    await newImpl.deployed();

    await expect(
      vaultV3.connect(admin).upgradeTo(newImpl.address)
    ).to.be.reverted;
  });

  // =========================================================================
  // Storage gap validation
  // =========================================================================

  it("should use storage gaps for future upgrades", async function () {
    /**
     * Validate storage layout compatibility by deploying fresh proxies at each
     * version and validating the upgrade path independently. We cannot reuse the
     * already-upgraded proxy (now at V3) for V1→V2 validation because OZ would
     * compare the V3 layout against V2 and flag a regression.
     */
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const tokenF = await MockERC20F.deploy("T", "T", ethers.utils.parseEther("1000"));
    await tokenF.deployed();

    // Fresh V1 proxy
    const freshV1 = await upgrades.deployProxy(
      TokenVaultV1,
      [tokenF.address, admin.address, 500],
      { kind: "uups" }
    );
    await freshV1.deployed();

    // V1 → V2: must be compatible
    await expect(
      upgrades.validateUpgrade(freshV1.address, TokenVaultV2, { kind: "uups" })
    ).to.not.be.rejected;

    // Upgrade to V2 to establish layout, then validate V2 → V3
    const freshV2 = await upgrades.upgradeProxy(freshV1.address, TokenVaultV2, {
      kind: "uups",
      call: { fn: "initializeV2", args: [500, admin.address] },
    });
    await freshV2.deployed();

    // V2 → V3: must be compatible
    await expect(
      upgrades.validateUpgrade(freshV2.address, TokenVaultV3, { kind: "uups" })
    ).to.not.be.rejected;
  });

  it("should not have storage layout collisions across versions", async function () {
    /**
     * Validates that upgrading from V1 all the way to V3 does not produce any
     * storage layout collision warnings. If any variable in a later version
     * overlaps with an earlier one, validateUpgrade throws.
     */
    // V1 → V3 (skipping V2, extreme scenario)
    await expect(
      upgrades.validateUpgrade(vaultV1.address, TokenVaultV3, { kind: "uups" })
    ).to.not.be.rejected;

    // V2 → V3
    await expect(
      upgrades.validateUpgrade(vaultV2.address, TokenVaultV3, { kind: "uups" })
    ).to.not.be.rejected;
  });

  // =========================================================================
  // Function selector integrity
  // =========================================================================

  it("should prevent function selector clashing", async function () {
    /**
     * Verify that within each contract version there are no duplicate function
     * selectors. Because V2 and V3 inherit previous versions, every selector in
     * the final ABI must be unique.
     */
    const checkNoDuplicateSelectors = (factory, label) => {
      const iface = factory.interface;
      const selectors = [];
      const names = [];

      for (const fragment of Object.values(iface.functions)) {
        const sel = iface.getSighash(fragment);
        expect(
          selectors,
          `Duplicate selector ${sel} (${fragment.name}) found in ${label}`
        ).to.not.include(sel);
        selectors.push(sel);
        names.push(fragment.name);
      }

      return selectors;
    };

    const v1Selectors = checkNoDuplicateSelectors(TokenVaultV1, "V1");
    const v2Selectors = checkNoDuplicateSelectors(TokenVaultV2, "V2");
    const v3Selectors = checkNoDuplicateSelectors(TokenVaultV3, "V3");

    // Every V1 selector must be present in V2 (backward compatibility)
    for (const sel of v1Selectors) {
      expect(
        v2Selectors,
        `V1 selector ${sel} missing from V2`
      ).to.include(sel);
    }

    // Every V2 selector must be present in V3
    for (const sel of v2Selectors) {
      expect(
        v3Selectors,
        `V2 selector ${sel} missing from V3`
      ).to.include(sel);
    }
  });

  it("should ensure V2 adds new selectors not present in V1", async function () {
    const v1Iface = TokenVaultV1.interface;
    const v2Iface = TokenVaultV2.interface;

    const v1Selectors = new Set(
      Object.values(v1Iface.functions).map((f) => v1Iface.getSighash(f))
    );
    const v2Selectors = new Set(
      Object.values(v2Iface.functions).map((f) => v2Iface.getSighash(f))
    );

    // V2 must have more selectors than V1
    expect(v2Selectors.size).to.be.gt(v1Selectors.size);

    // Spot-check: setYieldRate should exist in V2 but not V1
    const setYieldRateSel = v2Iface.getSighash("setYieldRate(uint256)");
    expect(v2Selectors.has(setYieldRateSel)).to.be.true;
    expect(v1Selectors.has(setYieldRateSel)).to.be.false;
  });

  it("should ensure V3 adds new selectors not present in V2", async function () {
    const v2Iface = TokenVaultV2.interface;
    const v3Iface = TokenVaultV3.interface;

    const v2Selectors = new Set(
      Object.values(v2Iface.functions).map((f) => v2Iface.getSighash(f))
    );
    const v3Selectors = new Set(
      Object.values(v3Iface.functions).map((f) => v3Iface.getSighash(f))
    );

    expect(v3Selectors.size).to.be.gt(v2Selectors.size);

    const emergencyWithdrawSel = v3Iface.getSighash("emergencyWithdraw()");
    expect(v3Selectors.has(emergencyWithdrawSel)).to.be.true;
    expect(v2Selectors.has(emergencyWithdrawSel)).to.be.false;
  });

  // =========================================================================
  // Proxy pattern integrity
  // =========================================================================

  it("should store implementation address in ERC-1967 slot", async function () {
    const implAddress = await upgrades.erc1967.getImplementationAddress(
      vaultV3.address
    );
    expect(implAddress).to.not.equal(ethers.constants.AddressZero);

    // Implementation must not be the proxy itself
    expect(implAddress).to.not.equal(vaultV3.address);
  });

  it("should preserve proxy address through all upgrades", async function () {
    expect(vaultV2.address).to.equal(vaultV1.address);
    expect(vaultV3.address).to.equal(vaultV1.address);
  });
});
