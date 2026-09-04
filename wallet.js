const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const PROCESSED_FILE = path.join(__dirname, "processed_wallets.json");

// ============================================================
// HD WALLET DERIVATION
// ============================================================

function deriveWallets(mnemonic, count) {
  const wallets = [];
  const hdNode = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(mnemonic),
    "m/44'/60'/0'/0"
  );
  for (let i = 0; i < count; i++) {
    const wallet = hdNode.deriveChild(i);
    wallets.push({
      index: i,
      address: wallet.address,
      privateKey: wallet.privateKey,
    });
  }
  return wallets;
}

// ============================================================
// EIP-712 CREATE PROXY SIGNING (for Gnosis Safe on Base)
// ============================================================

const EIP712_DOMAIN = {
  name: "Safe Singleton Factory",
  version: "1.0.0",
  chainId: 8453,
  verifyingContract: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
};

const SAFE_TYPES = {
  Singleton: [
    { name: "singleton", type: "address" },
    { name: "initializer", type: "bytes" },
    { name: "salt", type: "uint256" },
  ],
};

function encodeCreateProxy(singleton, initializer, salt) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes", "uint256"],
    [singleton, initializer, salt]
  );
}

async function signCreateProxy(wallet, singleton, initializer, salt) {
  const message = {
    singleton,
    initializer,
    salt: salt.toString(),
  };

  const signature = await wallet.signTypedData(
    EIP712_DOMAIN,
    SAFE_TYPES,
    message
  );

  const sigBytes = ethers.getBytes(signature);
  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  const v = sigBytes[64];

  if (v < 27) {
    return ethers.concat([r, s, ethers.hexlify(v + 27)]);
  }
  return signature;
}

// ============================================================
// PROCESSED WALLETS TRACKING
// ============================================================

function loadProcessedWallets() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
    }
  } catch (e) {}
  return [];
}

function saveProcessedWallets(wallets) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(wallets, null, 2));
}

function saveProcessedWallet(wallet) {
  const wallets = loadProcessedWallets();
  const existing = wallets.findIndex(
    (w) => w.index === wallet.index || w.address === wallet.address
  );
  if (existing >= 0) {
    wallets[existing] = { ...wallets[existing], ...wallet };
  } else {
    wallets.push(wallet);
  }
  saveProcessedWallets(wallets);
}

function isAlreadyProcessed(index) {
  const wallets = loadProcessedWallets();
  return wallets.some(
    (w) => w.index === index && w.status === "success"
  );
}

function clearProcessedWallets() {
  saveProcessedWallets([]);
}

module.exports = {
  deriveWallets,
  signCreateProxy,
  encodeCreateProxy,
  EIP712_DOMAIN,
  SAFE_TYPES,
  loadProcessedWallets,
  saveProcessedWallets,
  saveProcessedWallet,
  isAlreadyProcessed,
  clearProcessedWallets,
};
