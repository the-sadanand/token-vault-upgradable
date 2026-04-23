/**
 * upgrade-to-v3.js
 *
 * Upgrades an existing TokenVaultV2 proxy to TokenVaultV3 and runs the
 * V3 re-initializer (initializeV3) in the same transaction.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-to-v3.js --network <network>
 *
 * Optional env vars:
 *   PROXY_ADDRESS       – override the proxy address from deployment.json
 *   WITHDRAWAL_DELAY    – delay in seconds (default: 86400 = 24 h)
 */

const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== TokenVault V2 → V3 Upgrade ===");
  console.log("Upgrader:", deployer.address);

  // ── Read proxy address ────────────────────────────────────────────────────
  let proxyAddress = process.env.PROXY_ADDRESS;
  let deploymentData = {};

  const deployFile = path.join(__dirname, "..", "deployment.json");
  if (!proxyAddress && fs.existsSync(deployFile)) {
    deploymentData = JSON.parse(fs.readFileSync(deployFile, "utf8"));
    proxyAddress = deploymentData.proxyAddress;
  }

  if (!proxyAddress) {
    throw new Error(
      "No proxy address found. Set PROXY_ADDRESS env var or run upgrade-to-v2.js first."
    );
  }

  console.log("Proxy address      :", proxyAddress);

  // ── Configuration ──────────────────────────────────────────────────────────
  const withdrawalDelay = parseInt(
    process.env.WITHDRAWAL_DELAY || "86400",
    10
  );
  console.log(
    "Withdrawal delay   :",
    withdrawalDelay,
    "s (",
    (withdrawalDelay / 3600).toFixed(2),
    "h)"
  );

  // ── Validate upgrade (storage layout check) ───────────────────────────────
  console.log("\nValidating storage layout...");
  const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
  await upgrades.validateUpgrade(proxyAddress, TokenVaultV3, { kind: "uups" });
  console.log("Storage layout: OK ✓");

  // ── Perform upgrade ───────────────────────────────────────────────────────
  console.log("\nUpgrading to V3...");
  const vaultV3 = await upgrades.upgradeProxy(proxyAddress, TokenVaultV3, {
    kind: "uups",
    call: {
      fn: "initializeV3",
      args: [withdrawalDelay],
    },
  });
  await vaultV3.deployed();

  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("\n─── Upgrade Summary ──────────────────────────────");
  console.log("Proxy address     :", vaultV3.address);
  console.log("New implementation:", newImpl);
  console.log("Withdrawal delay  :", withdrawalDelay, "seconds");
  console.log("Version           :", await vaultV3.getImplementationVersion());
  console.log("──────────────────────────────────────────────────\n");

  // ── Persist updated addresses ──────────────────────────────────────────────
  deploymentData.implementationV3 = newImpl;
  deploymentData.withdrawalDelay = withdrawalDelay;
  deploymentData.upgradedToV3At = new Date().toISOString();

  fs.writeFileSync(deployFile, JSON.stringify(deploymentData, null, 2));
  console.log("deployment.json updated.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
