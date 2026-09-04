require("dotenv").config();
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { deriveWallets, isAlreadyProcessed, saveProcessedWallet, loadProcessedWallets, clearProcessedWallets } = require("./wallet");
const { signupWithReferral, openBrowserManual, sleep } = require("./browser");
const { fullLoginFlow, getReferralInfo, applyReferralCode, setUsername } = require("./api");

const USERNAME_FILE = path.join(__dirname, "username.txt");

function popUsername() {
  try {
    if (!fs.existsSync(USERNAME_FILE)) return null;
    const content = fs.readFileSync(USERNAME_FILE, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    const idx = Math.floor(Math.random() * lines.length);
    const name = lines.splice(idx, 1)[0].trim();
    fs.writeFileSync(USERNAME_FILE, lines.join("\n"));
    return name;
  } catch (e) {
    return null;
  }
}

function askQuestion(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function logWallet(w) {
  console.log("  Index: " + w.index);
  console.log("  Address: " + w.address);
  console.log("  Private Key: " + w.privateKey);
}

// ============================================================
// MENU
// ============================================================

async function showMenu() {
  console.log("\n\n" + "=".repeat(50));
  console.log("       pred.app Referral Bot v2.0");
  console.log("       (2Captcha + Puppeteer)");
  console.log("=".repeat(50));
  console.log("\nPilih mode operasi:");
  console.log("  1) Generate New Wallet");
  console.log("  2) Run Bot Auto (Puppeteer + CAPTCHA solver)");
  console.log("  3) Run Bot Manual (Chrome asli, tanpa Puppeteer)");
  console.log("  4) Check Referral Status");
  console.log("  5) View Processed Wallets");
  console.log("  6) Reset Wallet Data (Hapus MNEMONIC di .env & processed_wallets.json)");
  console.log("  0) Exit\n");
}

// ============================================================
// MODE: Generate New Wallet
// ============================================================

async function modeGenerateWallet() {
  const count = parseInt(process.env.MAX_INDEX || "200");

  // Generate random mnemonic baru
  const newWallet = ethers.Wallet.createRandom();
  const mnemonic = newWallet.mnemonic.phrase;
  const hdNode = ethers.HDNodeWallet.fromMnemonic(newWallet.mnemonic, "m/44'/60'/0'/0");

  // Simpan otomatis ke .env
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^MNEMONIC=.*/m, "MNEMONIC=" + mnemonic);
    fs.writeFileSync(envPath, envContent);
  }
  process.env.MNEMONIC = mnemonic;

  console.log("\n" + "=".repeat(60));
  console.log("  WALLET BARU TELAH DIBUAT & DISIMPAN KE .env!");
  console.log("=".repeat(60));
  console.log("  Mnemonic : " + mnemonic);
  console.log("  Total    : " + count + " wallet (sesuai MAX_INDEX di .env)");
  console.log("-".repeat(60));

  const wallets = [];
  for (let i = 0; i < count; i++) {
    const w = hdNode.deriveChild(i);
    wallets.push({ index: i, address: w.address, privateKey: w.privateKey });
  }

  for (let i = 0; i < Math.min(count, 5); i++) {
    console.log("  [" + wallets[i].index + "] " + wallets[i].address);
  }
  if (count > 5) {
    console.log("  ... dan " + (count - 5) + " wallet lainnya.");
  }
  console.log("-".repeat(60) + "\n");
}

// ============================================================
// MODE: Run Bot Auto
// ============================================================

async function modeRunBotAuto() {
  const { MNEMONIC, REFERRAL_CODE, MAX_INDEX, DELAY_MS, CAPTCHA_API_KEY } = process.env;
  if (!MNEMONIC) { console.error("\nSet MNEMONIC di .env!"); return; }
  if (!CAPTCHA_API_KEY) { console.error("\nSet CAPTCHA_API_KEY di .env untuk auto mode!"); return; }

  const maxIndex = parseInt(MAX_INDEX || "50");
  const delayMs = parseInt(DELAY_MS || "5000");
  const referralCode = REFERRAL_CODE || "REF886AC1C25E";

  console.log("\n=== pred.app Referral Bot (Auto + 2Captcha) ===");
  console.log("Referral Code: " + referralCode);
  console.log("Scan Index: 0 - " + (maxIndex - 1));
  console.log("CAPTCHA API: configured\n");

  const wallets = deriveWallets(MNEMONIC, maxIndex);
  const remaining = wallets.filter((w) => !isAlreadyProcessed(w.index));

  console.log("Total Wallet: " + maxIndex);
  console.log("Sudah Selesai: " + (maxIndex - remaining.length));
  console.log("Tersisa: " + remaining.length + "\n");

  if (remaining.length === 0) {
    console.log("Semua wallet (0 - " + (maxIndex - 1) + ") sudah berhasil diproses!\n");
    return;
  }

  console.log("\nMemulai pemrosesan otomatis " + remaining.length + " wallet (tanpa konfirmasi)...\n");

  for (let i = 0; i < wallets.length; i++) {
    const walletInfo = wallets[i];

    if (isAlreadyProcessed(walletInfo.index)) {
      console.log("  [" + walletInfo.index + "] " + walletInfo.address.slice(0, 10) + "... | skip (sudah selesai)");
      continue;
    }

    console.log("\n" + "=".repeat(50));
    console.log("PROSES WALLET [" + walletInfo.index + " / " + (maxIndex - 1) + "]");
    console.log("=".repeat(50));
    console.log("Address    : " + walletInfo.address);
    console.log("=".repeat(50));

    try {
      const result = await signupWithReferral(walletInfo, referralCode, CAPTCHA_API_KEY, delayMs);

      if (result.success && result.privyToken) {
        console.log("\n    Running full login flow...");
        const loginResult = await fullLoginFlow(result.privyToken, referralCode);

        let usernameSet = null;
        if (loginResult.success && loginResult.accessToken) {
          const name = popUsername();
          if (name) {
            console.log("    [username] Setting username: " + name);
            const usernameResult = await setUsername(loginResult.accessToken, name);
            if (usernameResult.success) {
              console.log("    [username] OK: " + name);
              usernameSet = name;
            } else {
              console.log("    [username] Gagal: " + usernameResult.error);
            }
          } else {
            console.log("    [username] Nama habis di username.txt, skip.");
          }
        }

        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: loginResult.success ? "success" : "partial",
          privyToken: result.privyToken,
          userId: loginResult.userId,
          accessToken: loginResult.accessToken,
          proxyWalletAddr: loginResult.proxyWalletAddr,
          isEnabledTrading: loginResult.isEnabledTrading,
          username: usernameSet,
          error: loginResult.error,
          timestamp: new Date().toISOString(),
        });

        if (loginResult.success) {
          console.log("\n  [OK] SUKSES! Index " + walletInfo.index + " | User ID: " + loginResult.userId);
          if (usernameSet) {
            console.log("  [OK] Username: " + usernameSet);
          }
        } else {
          console.log("\n  [!] Login API parsial: " + loginResult.error);
        }
      } else {
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "failed",
          error: result.error,
          timestamp: new Date().toISOString(),
        });
        console.log("\n  [X] Gagal: " + result.error);
      }
    } catch (err) {
      console.log("\n  [X] Error: " + err.message);
    }

    console.log("  Menunggu jeda " + (delayMs / 1000) + " detik sebelum wallet berikutnya...");
    try {
      const { execSync } = require("child_process");
      execSync("rm -rf /tmp/pred-* /tmp/com.google.Chrome.* /tmp/.org.chromium.Chromium.* /tmp/.com.google.Chrome.* 2>/dev/null");
    } catch (e) {}
    await sleep(delayMs);
  }

  console.log("\n" + "=".repeat(60));
  console.log("  SEMUA WALLET SELESAI DIPROSES!");
  console.log("=".repeat(60) + "\n");
}

// ============================================================
// MODE: Run Bot Manual
// ============================================================

async function modeRunBotManual() {
  const { MNEMONIC, REFERRAL_CODE, MAX_INDEX, DELAY_MS } = process.env;
  if (!MNEMONIC) { console.error("\nSet MNEMONIC di .env!"); return; }

  const maxIndex = parseInt(MAX_INDEX || "50");
  const delayMs = parseInt(DELAY_MS || "3000");
  const referralCode = REFERRAL_CODE || "REF886AC1C25E";

  console.log("\n=== pred.app Referral Bot (Manual) ===");
  console.log("Referral Code: " + referralCode);
  console.log("Scan Index: 0 - " + (maxIndex - 1) + "\n");

  const wallets = deriveWallets(MNEMONIC, maxIndex);

  for (const walletInfo of wallets) {
    if (isAlreadyProcessed(walletInfo.index)) {
      console.log("  [" + walletInfo.index + "] " + walletInfo.address.slice(0, 10) + "... | skip");
      continue;
    }

    console.log("\n" + "-".repeat(50));
    console.log("WALLET [" + walletInfo.index + "]");
    console.log("-".repeat(50));
    console.log("Address    : " + walletInfo.address);
    console.log("Private Key: " + walletInfo.privateKey);
    console.log("-".repeat(50));

    const proceed = await askQuestion("Lanjut buka browser? (y/n): ");
    if (proceed.toLowerCase() !== "y") continue;

    try {
      const result = await openBrowserManual(walletInfo, referralCode);

      if (result.success && result.privyToken) {
        const loginResult = await fullLoginFlow(result.privyToken, referralCode);

        let usernameSet = null;
        if (loginResult.success && loginResult.accessToken) {
          const name = popUsername();
          if (name) {
            console.log("    [username] Setting username: " + name);
            const usernameResult = await setUsername(loginResult.accessToken, name);
            if (usernameResult.success) {
              console.log("    [username] OK: " + name);
              usernameSet = name;
            } else {
              console.log("    [username] Gagal: " + usernameResult.error);
            }
          } else {
            console.log("    [username] Nama habis di username.txt, skip.");
          }
        }

        console.log("Token captured!");
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          privyToken: result.privyToken,
          userId: loginResult ? loginResult.userId : null,
          accessToken: loginResult ? loginResult.accessToken : null,
          username: usernameSet,
          status: "success",
          timestamp: new Date().toISOString(),
        });
        console.log("SELESAI! Token tersimpan.");
      } else {
        console.log("Gagal: " + result.error);
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "failed",
          error: result.error,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.log("Error: " + err.message);
    }

    await sleep(delayMs);
  }
}

// ============================================================
// MODE: Check Referral Status
// ============================================================

async function modeCheckReferral() {
  const processed = loadProcessedWallets();
  const successWallets = processed.filter(w => w.status === "success" && w.accessToken);
  if (successWallets.length === 0) {
    console.log("\nTidak ada wallet yang berhasil login.\n");
    return;
  }
  console.log("\nChecking referral status untuk " + successWallets.length + " wallet...\n");
  for (const w of successWallets) {
    try {
      const info = await getReferralInfo(w.accessToken);
      const tag = "[" + w.index + "] " + w.address.slice(0, 10) + "...";
      if (info) console.log(tag + " Referral data: " + JSON.stringify(info).slice(0, 200));
    } catch (err) {
      console.log("[" + w.index + "] Error: " + err.message);
    }
    await sleep(1000);
  }
}

// ============================================================
// MODE: View Processed Wallets
// ============================================================

function modeViewProcessed() {
  const processed = loadProcessedWallets();
  if (processed.length === 0) {
    console.log("\nBelum ada wallet yang diproses.\n");
    return;
  }
  console.log("\n" + "=".repeat(60));
  console.log("  PROCESSED WALLETS (" + processed.length + ")");
  console.log("=".repeat(60));
  for (const w of processed) {
    const status = w.status === "success" ? "OK" : "FAIL";
    console.log("  [" + w.index + "] " + (w.address || "").slice(0, 12) + "... | " + status + " | " + (w.timestamp || "N/A"));
    if (w.userId) console.log("         User ID: " + w.userId);
    if (w.error) console.log("         Error: " + (w.error || "").slice(0, 60));
  }
  console.log("=".repeat(60) + "\n");
}

// ============================================================
// MODE: Reset Wallet Data
// ============================================================

async function modeResetWallets() {
  console.log("\n" + "=".repeat(60));
  console.log("  RESET WALLET DATA");
  console.log("=".repeat(60));
  console.log("Perhatian: Ini akan mengosongkan processed_wallets.json");
  console.log("dan menghapus MNEMONIC dari .env.\n");

  const confirm = await askQuestion("Apakah Anda yakin ingin melakukan reset? (y/n): ");
  if (confirm.toLowerCase() !== "y") {
    console.log("Reset dibatalkan.\n");
    return;
  }

  // 1. Kosongkan processed_wallets.json
  clearProcessedWallets();
  console.log("  [OK] processed_wallets.json berhasil dikosongkan.");

  // 2. Hapus MNEMONIC di .env
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^MNEMONIC=.*/m, "MNEMONIC=");
    fs.writeFileSync(envPath, envContent);
    process.env.MNEMONIC = "";
    console.log("  [OK] MNEMONIC di .env berhasil dikosongkan.");
  }

  console.log("\n[SUCCESS] Reset wallet selesai!\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  try {
    console.log("Menjalankan bot otomatis (Mode 2)...");
    await modeRunBotAuto();
    console.log("\nProses selesai.");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
