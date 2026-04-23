/**
 * deploy-v1.js
 *
 * Deploys the MockERC20 token and TokenVaultV1 as a UUPS proxy.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v1.js --network <network>
 *
 * Set the following env vars (or edit the constants below) before running:
 *   TOKEN_ADDRESS   – existing ERC-20 address (optional; deploys MockERC20 if unset)
 *   ADMIN_ADDRESS   – address that receives admin roles (defaults to deployer)
 *   DEPOSIT_FEE     – fee in basis points, e.g. "500" for 5 % (default: 500)
 */

const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== TokenVault V1 Deployment ===");
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance :",
    ethers.utils.formatEther(await deployer.getBalance()),
    "ETH\n"
  );

  // ── Configuration ──────────────────────────────────────────────────────────
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address;
  const depositFee = parseInt(process.env.DEPOSIT_FEE || "500", 10);
  let tokenAddress = process.env.TOKEN_ADDRESS;

  // ── Deploy mock token (if not provided) ───────────────────────────────────
  if (!tokenAddress) {
    console.log("Deploying MockERC20...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy(
      "Vault Token",
      "VTK",
      ethers.utils.parseEther("1000000") // 1 M initial supply to deployer
    );
    await token.deployed();
    tokenAddress = token.address;
    console.log("MockERC20 deployed to  :", tokenAddress);
  } else {
    console.log("Using existing token   :", tokenAddress);
  }

  // ── Deploy vault proxy ────────────────────────────────────────────────────
  console.log("\nDeploying TokenVaultV1 proxy (UUPS)...");
  const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
  const vault = await upgrades.deployProxy(
    TokenVaultV1,
    [tokenAddress, adminAddress, depositFee],
    { kind: "uups" }
  );
  await vault.deployed();

  const implAddress = await upgrades.erc1967.getImplementationAddress(
    vault.address
  );

  console.log("\n─── Deployment Summary ───────────────────────────");
  console.log("Proxy address     :", vault.address);
  console.log("Implementation    :", implAddress);
  console.log("Token             :", tokenAddress);
  console.log("Admin             :", adminAddress);
  console.log("Deposit fee       :", depositFee, "bp");
  console.log("Version           :", await vault.getImplementationVersion());
  console.log("──────────────────────────────────────────────────\n");

  // ── Persist addresses for upgrade scripts ─────────────────────────────────
  const deploymentData = {
    network: hre.network.name,
    proxyAddress: vault.address,
    implementationV1: implAddress,
    tokenAddress,
    adminAddress,
    depositFee,
    deployedAt: new Date().toISOString(),
  };

  const outFile = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(outFile, JSON.stringify(deploymentData, null, 2));
  console.log("Deployment data saved to deployment.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
