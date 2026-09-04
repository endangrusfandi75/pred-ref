const axios = require("axios");

const PRED_API = "https://www.pred.app/api/v1";
const PRIVY_APP_ID = "cmg3i7uma00vhjx0ect4xhd0l";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// LOGIN WITH PRIVY TOKEN
// ============================================================

async function loginWithPrivy(privyToken) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "x-privy-app-id": PRIVY_APP_ID,
    };

    const res = await axios.post(
      PRED_API + "/auth/login-with-signature",
      { token: privyToken },
      { headers }
    );

    return {
      success: true,
      accessToken: res.data.accessToken || res.data.access_token,
      refreshToken: res.data.refreshToken || res.data.refresh_token,
      userId: res.data.user_id || res.data.userId,
      proxyWalletAddr: res.data.proxy_wallet_addr || res.data.proxyWalletAddr,
      isEnabledTrading: res.data.is_enabled_trading,
    };
  } catch (e) {
    return {
      success: false,
      error: e.response ? JSON.stringify(e.response.data) : e.message,
    };
  }
}

// ============================================================
// SAFE APPROVAL (enable trading)
// ============================================================

async function approveSafe(accessToken, proxyWalletAddr) {
  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + accessToken,
    };

    const prepareRes = await axios.post(
      PRED_API + "/user/safe-approval/prepare",
      {},
      { headers }
    );

    if (!prepareRes.data || !prepareRes.data.signature) {
      return { success: false, error: "No signature in prepare response" };
    }

    const executeRes = await axios.post(
      PRED_API + "/user/safe-approval/execute",
      { signature: prepareRes.data.signature },
      { headers }
    );

    return { success: true, data: executeRes.data };
  } catch (e) {
    return {
      success: false,
      error: e.response ? JSON.stringify(e.response.data) : e.message,
    };
  }
}

// ============================================================
// APPLY REFERRAL CODE
// ============================================================

function parseJwt(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString());
  } catch (e) {
    return null;
  }
}

// ============================================================
// APPLY REFERRAL CODE
// ============================================================

async function applyReferralCode(accessToken, referralCode) {
  try {
    const res = await axios.post(
      PRED_API + "/campaigns/referrals/apply",
      { referral_code: referralCode },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
      }
    );
    return { success: true, data: res.data };
  } catch (e) {
    if (e.response && e.response.data && e.response.data.err_code === "REFERRAL_ALREADY_USED") {
      return { success: true, alreadyLinked: true, message: "Referral already linked via URL!" };
    }
    return {
      success: false,
      error: e.response ? JSON.stringify(e.response.data) : e.message,
    };
  }
}

// ============================================================
// GET REFERRAL INFO
// ============================================================

async function getReferralInfo(accessToken) {
  try {
    const res = await axios.get(PRED_API + "/campaigns/my-codes", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

// ============================================================
// SET USERNAME
// ============================================================

async function setUsername(accessToken, username) {
  try {
    const res = await axios.post(
      PRED_API + "/user/username",
      { username },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
      }
    );
    return { success: true, data: res.data };
  } catch (e) {
    return {
      success: false,
      error: e.response ? JSON.stringify(e.response.data) : e.message,
    };
  }
}

// ============================================================
// FULL LOGIN FLOW: Token Parse -> Safe Check -> Apply Referral
// ============================================================

async function fullLoginFlow(token, referralCode) {
  console.log("    [api] Step 1: Processing session token...");
  const payload = parseJwt(token);

  // Check if this token is already usable (got from pred.app access_token key or network)
  // Try to determine if it's a pred.app access token
  const isAlreadyAccessToken = payload && payload.iss && payload.iss.includes("pred.app");
  const hasUserId = payload && (payload.user_id || payload.sub);

  let accessToken = token;
  let userId = null;
  let proxyWalletAddr = null;
  let isEnabledTrading = false;

  if (isAlreadyAccessToken) {
    userId = payload ? (payload.user_id || payload.sub) : null;
    proxyWalletAddr = payload ? payload.privy_wallet_address : null;
    isEnabledTrading = payload ? payload.is_enabled_trading : false;
  } else {
    // Token might be a privy token or a pred.app token. Try to exchange.
    const loginResult = await loginWithPrivy(token);
    if (loginResult.success && loginResult.accessToken) {
      accessToken = loginResult.accessToken;
      userId = loginResult.userId;
      proxyWalletAddr = loginResult.proxyWalletAddr;
      isEnabledTrading = loginResult.isEnabledTrading;
    } else {
      // If exchange failed, try using the token directly — it might still work
      // (pred.app might accept its own format)
      console.log("    [api] Privy exchange failed, trying token directly: " + (loginResult.error || "unknown").slice(0, 100));
      if (payload && payload.sub) {
        userId = payload.sub;
        // Try to find real userId from iss
        if (payload.iss && (payload.iss === "pred" || payload.iss === "https://www.pred.app")) {
          userId = payload.user_id || payload.sub;
        }
      }
    }
  }

  console.log("    [api] Session active! User ID: " + userId);

  if (!isEnabledTrading && proxyWalletAddr) {
    console.log("    [api] Step 2: Approving Safe...");
    const approveResult = await approveSafe(
      accessToken,
      proxyWalletAddr
    );
    if (approveResult.success) {
      console.log("    [api] Safe approved!");
    } else {
      console.log("    [api] Safe approval notice: " + approveResult.error);
    }
    await sleep(2000);
  } else {
    console.log("    [api] Trading already enabled or no proxy wallet needed");
  }

  console.log("    [api] Step 3: Verifying/applying referral code...");
  const applyResult = await applyReferralCode(
    accessToken,
    referralCode
  );
  if (applyResult.success) {
    if (applyResult.alreadyLinked) {
      console.log("    [api] Referral code successfully linked automatically from URL!");
    } else {
      console.log("    [api] Referral code applied successfully!");
    }
  } else {
    console.log("    [api] Referral apply notice: " + applyResult.error);
  }

  return {
    success: true,
    accessToken: accessToken,
    userId: userId,
    proxyWalletAddr: proxyWalletAddr,
    isEnabledTrading: isEnabledTrading,
  };
}

module.exports = {
  loginWithPrivy,
  approveSafe,
  applyReferralCode,
  getReferralInfo,
  fullLoginFlow,
  setUsername,
  sleep,
};
