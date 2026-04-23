/**
 * upgrade-to-v2.js
 *
 * Upgrades an existing TokenVaultV1 proxy to TokenVaultV2 and runs the
 * V2 re-initializer (initializeV2) in the same transaction.
 *
 * Reads the proxy address from deployment.json (written by deploy-v1.js) or
 * from the PROXY_ADDRESS env var.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-to-v2.js --network <network>
 *
 * Optional env vars:
 *   PROXY_ADDRESS   – override the proxy address from deployment.json
 *   YIELD_RATE      – annual yield rate in basis points (default: 500 = 5 %)
 *   PAUSER_ADDRESS  – address that receives PAUSER_ROLE (defaults to deployer)
 */

const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== TokenVault V1 → V2 Upgrade ===");
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
      "No proxy address found. Set PROXY_ADDRESS env var or run deploy-v1.js first."
    );
  }

  console.log("Proxy address      :", proxyAddress);

  // ── Configuration ──────────────────────────────────────────────────────────
  const yieldRate = parseInt(process.env.YIELD_RATE || "500", 10);
  const pauserAddress = process.env.PAUSER_ADDRESS || deployer.address;

  console.log("Yield rate         :", yieldRate, "bp");
  console.log("Pauser address     :", pauserAddress);

  // ── Validate upgrade (storage layout check) ───────────────────────────────
  console.log("\nValidating storage layout...");
  const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
  await upgrades.validateUpgrade(proxyAddress, TokenVaultV2, { kind: "uups" });
  console.log("Storage layout: OK ✓");

  // ── Perform upgrade ───────────────────────────────────────────────────────
  console.log("\nUpgrading to V2...");
  const vaultV2 = await upgrades.upgradeProxy(proxyAddress, TokenVaultV2, {
    kind: "uups",
    call: {
      fn: "initializeV2",
      args: [yieldRate, pauserAddress],
    },
  });
  await vaultV2.deployed();

  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("\n─── Upgrade Summary ──────────────────────────────");
  console.log("Proxy address     :", vaultV2.address);
  console.log("New implementation:", newImpl);
  console.log("Yield rate        :", yieldRate, "bp");
  console.log("Pauser            :", pauserAddress);
  console.log("Version           :", await vaultV2.getImplementationVersion());
  console.log("──────────────────────────────────────────────────\n");

  // ── Persist updated addresses ──────────────────────────────────────────────
  deploymentData.implementationV2 = newImpl;
  deploymentData.yieldRate = yieldRate;
  deploymentData.pauserAddress = pauserAddress;
  deploymentData.upgradedToV2At = new Date().toISOString();

  fs.writeFileSync(deployFile, JSON.stringify(deploymentData, null, 2));
  console.log("deployment.json updated.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
