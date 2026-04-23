# TokenVault — Production-Grade UUPS Upgradeable Smart Contract System

A fully auditable, three-version upgradeable ERC-20 token vault built with the
[UUPS (Universal Upgradeable Proxy Standard)](https://eips.ethereum.org/EIPS/eip-1822)
pattern using Hardhat and OpenZeppelin Upgrades.

---

## Features by Version

| Feature | V1 | V2 | V3 |
|---|:---:|:---:|:---:|
| Deposit with fee | ✅ | ✅ | ✅ |
| Withdrawal | ✅ | ✅ | ✅ |
| Role-based access control | ✅ | ✅ | ✅ |
| Yield accrual (simple interest) | — | ✅ | ✅ |
| Deposit pause / unpause | — | ✅ | ✅ |
| Time-delayed withdrawal queue | — | — | ✅ |
| Emergency withdrawal | — | — | ✅ |

---

## Project Structure

```
token-vault/
├── contracts/
│   ├── TokenVaultV1.sol          # Core vault (UUPS base)
│   ├── TokenVaultV2.sol          # + Yield + Pause
│   ├── TokenVaultV3.sol          # + Withdrawal delay + Emergency exit
│   └── mocks/
│       └── MockERC20.sol         # Test token
├── test/
│   ├── TokenVaultV1.test.js
│   ├── upgrade-v1-to-v2.test.js
│   ├── upgrade-v2-to-v3.test.js
│   └── security.test.js
├── scripts/
│   ├── deploy-v1.js
│   ├── upgrade-to-v2.js
│   └── upgrade-to-v3.js
├── hardhat.config.js
├── package.json
├── submission.yml
└── README.md
```

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 8

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Compile contracts

```bash
npm run compile
```

### 3. Run the full test suite

```bash
npm test
```

Or run individual suites:

```bash
npm run test:v1           # TokenVaultV1 unit tests
npm run test:upgrade-v2   # V1 → V2 upgrade tests
npm run test:upgrade-v3   # V2 → V3 upgrade tests
npm run test:security     # Security & storage tests
```

---

## Deployment (local node)

### Terminal 1 — start local Hardhat node

```bash
npx hardhat node
```

### Terminal 2 — deploy and upgrade

```bash
# Deploy V1
npm run deploy-v1

# Upgrade to V2 (reads proxy address from deployment.json)
npm run upgrade-v2

# Upgrade to V3
npm run upgrade-v3
```

### Environment variables (optional)

| Variable | Default | Description |
|---|---|---|
| `TOKEN_ADDRESS` | *(deploys MockERC20)* | Existing ERC-20 token address |
| `ADMIN_ADDRESS` | deployer | Address receiving admin roles |
| `DEPOSIT_FEE` | `500` | Deposit fee in basis points (5%) |
| `YIELD_RATE` | `500` | Annual yield rate in basis points (5%) |
| `PAUSER_ADDRESS` | deployer | Address receiving PAUSER_ROLE |
| `WITHDRAWAL_DELAY` | `86400` | Withdrawal delay in seconds (24 h) |
| `PROXY_ADDRESS` | *(from deployment.json)* | Override proxy address |

---

## Architecture

### UUPS Proxy Pattern

```
User ──calls──► ERC-1967 Proxy ──delegatecall──► Implementation (V1/V2/V3)
                  (storage)                           (logic only)
```

- All user state lives in the **proxy's storage**.
- The implementation address is stored in the ERC-1967 admin slot.
- Only addresses holding `UPGRADER_ROLE` can swap the implementation.

### Storage Layout

Each contract in the inheritance chain reserves **50 storage slots** (4 custom
variables + 46-slot gap). Later versions append their own 50-slot block after
the parent's block.

```
TokenVaultV1  [slot 0] token
              [slot 1] depositFee
              [slot 2] _balances (mapping)
              [slot 3] _totalDeposits
              [slots 4-49] __gap (46 slots)

TokenVaultV2  [slot 50] yieldRate
              [slot 51] _userYieldAccrued (mapping)
              [slot 52] _lastClaimTime (mapping)
              [slot 53] _depositsPaused
              [slots 54-99] __gapV2 (46 slots)

TokenVaultV3  [slot 100] withdrawalDelay
              [slot 101] _withdrawalRequests (mapping)
              [slots 102-149] __gapV3 (48 slots)
```

### Access Control

| Role | Grantee (default) | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | deployer / `_admin` | Grant/revoke any role |
| `UPGRADER_ROLE` | deployer / `_admin` | Call `upgradeTo` |
| `PAUSER_ROLE` | configured in V2 init | Pause/unpause deposits |

---

## Business Logic

### Deposit fee (V1+)

```
fee       = amount × depositFee / 10 000
netCredit = amount − fee
```

Depositing 1 000 tokens at 5% (500 bp) → user receives **950 token credit**.

### Yield calculation (V2+, simple interest)

```
yield = balance × yieldRate × timeElapsed / (365 days × 10 000)
```

Yield is snapshotted into `_userYieldAccrued` on every deposit/withdraw call and
can be claimed at any time via `claimYield()`.

### Withdrawal delay (V3+)

1. `requestWithdrawal(amount)` — queues the request, records `block.timestamp`
2. Wait `withdrawalDelay` seconds
3. `executeWithdrawal()` — transfers funds; reverts if delay not met

`emergencyWithdraw()` skips the queue and transfers the entire balance immediately.

---

## Security Considerations

- **`_disableInitializers()`** in every implementation constructor prevents an
  attacker from calling `initialize` directly on the bare implementation.
- **`reinitializer(N)`** ensures each version's setup function runs exactly once.
- **CEI pattern** (Checks → Effects → Interactions) used throughout to prevent
  reentrancy exploits.
- **`SafeERC20`** wrapping defends against non-standard token implementations.
- **`ReentrancyGuardUpgradeable`** applied to all state-changing external functions.
- **Storage gaps** prevent slot collisions when new variables are added in upgrades.

---

## Running Gas Reports

```bash
REPORT_GAS=true npm test
```

---

## License

MIT
