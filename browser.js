var puppeteer = require("puppeteer-extra");
var StealthPlugin = require("puppeteer-extra-plugin-stealth");
var { ethers } = require("ethers");
var { solveTurnstile, getTurnstileHookScript, extractTurnstileParams, injectTurnstileToken } = require("./captcha");
var { execSync, spawn } = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");

puppeteer.use(StealthPlugin());

var PRED_URL = "https://www.pred.app";

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function log(tag, msg) {
  // Set VERBOSE=1 in .env to enable detailed logs.
  const verbose = process.env.VERBOSE === '1';
  // Always show high‑level info (e.g., processing wallet status) if tag is 'info'
  if (tag === 'info') {
    console.log(`  [${tag}] ${msg}`);
    return;
  }
  if (verbose) {
    console.log(`  [${tag}] ${msg}`);
  }
}



// ============================================================
// RANDOM PROFILE / FINGERPRINT GENERATOR
// ============================================================

var CHROME_VERSIONS = [
  "126.0.6478.127", "126.0.6478.182", "127.0.6533.88", "127.0.6533.103",
  "128.0.6613.84", "128.0.6613.119", "128.0.6613.137", "129.0.6668.58",
  "129.0.6668.70", "129.0.6668.89", "130.0.6723.58", "130.0.6723.70", "131.0.6778.24"
];

// Daftar device dimuat dari fingerprint.txt (pool acak, di-random-pick per wallet)
var FP_POOL = [];
function loadFingerprintPool() {
  try {
    var fp = require("fs").readFileSync(__dirname + "/fingerprint.txt", "utf8");
    var lines = fp.split("\n");
    FP_POOL = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      var prt = line.split("|");
      if (prt.length < 8) continue;
      FP_POOL.push({
        type: prt[0].trim(),
        deviceName: prt[1].trim(),
        uaModel: prt[2].trim(),
        platform: prt[3].trim(),
        width: parseInt(prt[4], 10),
        height: parseInt(prt[5], 10),
        gpuVendor: prt[6].trim(),
        gpuRenderer: prt[7].trim()
      });
    }
  } catch (e) {
    console.error("[fingerprint] Gagal load fingerprint.txt: " + e.message);
  }
}
loadFingerprintPool();



var LOCALES = [
  { lang: "en-US,en;q=0.9", tz: "America/New_York" },
  { lang: "en-US,en;q=0.9", tz: "America/Los_Angeles" },
  { lang: "en-US,en;q=0.9", tz: "America/Chicago" },
  { lang: "en-GB,en;q=0.9", tz: "Europe/London" },
  { lang: "en-US,en;q=0.9,id;q=0.8", tz: "Asia/Jakarta" },
  { lang: "en-SG,en;q=0.9", tz: "Asia/Singapore" },
  { lang: "en-CA,en;q=0.9", tz: "America/Toronto" },
  { lang: "en-AU,en;q=0.9", tz: "Australia/Sydney" },
  { lang: "en-US,en;q=0.9,de;q=0.8", tz: "Europe/Berlin" },
  { lang: "en-US,en;q=0.9,ja;q=0.8", tz: "Asia/Tokyo" }
];

// Generator fingerprint: random-pick dari FP_POOL (fingerprint.txt), gabung chrome version + locale acak
function getProfileFingerprint(index) {
  var pool = FP_POOL;
  if (!pool || pool.length === 0) {
    // Fallback minimal kalau fingerprint.txt gagal load / kosong
    return {
      type: "desktop", deviceModel: "Windows PC", platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + CHROME_VERSIONS[0] + " Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
      locale: { lang: "en-US,en;q=0.9", tz: "America/New_York" },
      isMobile: false, hasTouch: false,
      deviceMemory: 8, hardwareConcurrency: 8
    };
  }
  var dev = pool[Math.floor(Math.random() * pool.length)];
  var cVer = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  var loc = LOCALES[Math.floor(Math.random() * LOCALES.length)];

  var type = dev.type;
  var ua;
  var platform = dev.platform;
  var isMobile = false;
  var hasTouch = false;
  var isTablet = false;

  if (type === "android") {
    ua = "Mozilla/5.0 (Linux; Android 1" + (Math.floor(index % 5) + 0) + "; " + dev.uaModel + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + cVer + " Mobile Safari/537.36";
    isMobile = true; hasTouch = true;
  } else if (type === "ios") {
    ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 1" + (Math.floor(index % 6) + 2) + "_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/" + cVer + " Mobile/15E148 Safari/604.1";
    isMobile = true; hasTouch = true;
  } else if (type === "tablet") {
    ua = "Mozilla/5.0 (iPad; CPU OS 1" + (Math.floor(index % 6) + 2) + "_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/" + cVer + " Mobile/15E148 Safari/604.1";
    isMobile = true; hasTouch = true; isTablet = true;
  } else {
    // desktop
    if (platform === "MacIntel") {
      ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + cVer + " Safari/537.36";
    } else if (platform === "Linux x86_64") {
      ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + cVer + " Safari/537.36";
    } else {
      var winVer = (Math.floor(Math.random() * 2) === 0) ? "10.0" : "11.0";
      ua = "Mozilla/5.0 (Windows NT " + winVer + "; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + cVer + " Safari/537.36";
    }
  }

  var mem = [4, 6, 8, 12, 16, 32, 64];
  return {
    type: isTablet ? "tablet" : (type === "ios" ? "ios" : (type === "android" ? "android" : "desktop")),
    deviceModel: dev.deviceName,
    platform: platform,
    userAgent: ua,
    viewport: { width: dev.width, height: dev.height },
    webgl: { vendor: dev.gpuVendor, renderer: dev.gpuRenderer },
    locale: loc,
    isMobile: isMobile,
    isTablet: isTablet,
    hasTouch: hasTouch,
    deviceMemory: mem[Math.floor(Math.random() * (isMobile ? 4 : 5))],
    hardwareConcurrency: Math.floor(Math.random() * 17) + 4
  };
}

// ============================================================
// CLICK HELPERS
// ============================================================

async function clickTextAll(page, text) {
  if (await clickText(page, text)) return true;
  for (var i = 0; i < page.frames().length; i++) {
    var frame = page.frames()[i];
    if (frame === page.mainFrame()) continue;
    try {
      if (await clickText(frame, text)) return true;
    } catch (e) {}
  }
  return false;
}

async function clickText(frame, text) {
  try {
    return await frame.evaluate(function(searchText) {
      var els = document.querySelectorAll("button, a, div[role='button'], li, span, p, label, [data-testid]");
      for (var i = 0; i < els.length; i++) {
        if (els[i].textContent && els[i].textContent.indexOf(searchText) >= 0) {
          try {
            els[i].scrollIntoView({ block: "center", behavior: "instant" });
          } catch (e) {}
          els[i].click();
          return true;
        }
      }
      // Fallback: search for exact text match over whole DOM text nodes
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if (node.nodeValue && node.nodeValue.indexOf(searchText) >= 0) {
          var el = node.parentElement;
          if (el) {
            try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) {}
            el.click();
            return true;
          }
        }
      }
      return false;
    }, text);
  } catch (e) {
    return false;
  }
}

// ============================================================
// FIND ALL TURNSTILE FRAMES + SITEKEY
// ============================================================

async function findAllTurnstileInfo(page) {
  var results = [];
  var frames = page.frames();

  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    try {
      var url = frame.url();

      // Pattern 1: challenges.cloudflare.com/turnstile
      if (url.indexOf("challenges.cloudflare.com/turnstile") >= 0) {
        var match = url.match(/sitekey=([^&]+)/);
        var actionMatch = url.match(/action=([^&]+)/);
        results.push({
          frame: frame,
          url: url,
          sitekey: match ? match[1] : null,
          action: actionMatch ? actionMatch[1] : "managed",
          source: "iframe-url"
        });
        continue;
      }

      // Pattern 2: auth.privy.io iframe (contains Turnstile widget)
      if (url.indexOf("auth.privy.io") >= 0) {
        try {
          var innerFrames = frame.childFrames();
          for (var j = 0; j < innerFrames.length; j++) {
            var innerUrl = innerFrames[j].url();
            if (innerUrl.indexOf("challenges.cloudflare.com") >= 0) {
              var innerMatch = innerUrl.match(/sitekey=([^&]+)/);
              results.push({
                frame: innerFrames[j],
                url: innerUrl,
                sitekey: innerMatch ? innerMatch[1] : null,
                action: "managed",
                source: "privy-iframe"
              });
            }
          }
        } catch (e) {}

        // Also check for Turnstile widget inside privy frame
        try {
          var sitekeyInFrame = await frame.evaluate(function() {
            var el = document.querySelector("[data-sitekey]");
            if (el) return el.getAttribute("data-sitekey");
            var scripts = document.querySelectorAll("script[src*='turnstile']");
            for (var s = 0; s < scripts.length; s++) {
              var m = scripts[s].src.match(/sitekey[=\/]([^&\/]+)/);
              if (m) return m[1];
            }
            return null;
          });
          if (sitekeyInFrame) {
            results.push({
              frame: frame,
              url: url,
              sitekey: sitekeyInFrame,
              action: "managed",
              source: "privy-evaluate"
            });
          }
        } catch (e) {}
      }

      // Pattern 3: data-sitekey in any frame
      try {
        var sk = await frame.evaluate(function() {
          var el = document.querySelector("[data-sitekey]");
          return el ? el.getAttribute("data-sitekey") : null;
        });
        if (sk) {
          results.push({
            frame: frame,
            url: url,
            sitekey: sk,
            action: "managed",
            source: "data-sitekey"
          });
        }
      } catch (e) {}

    } catch (e) {}
  }

  return results;
}

// ============================================================
// INJECT TURNSTILE TOKEN INTO SPECIFIC FRAME
// ============================================================

async function injectTokenIntoFrame(frame, token) {
  try {
    await frame.evaluate(function(tkn) {
      // Method 1: Direct input
      var input = document.querySelector('input[name="cf-turnstile-response"]');
      if (input) {
        input.value = tkn;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Method 2: Look for hidden input with different selector
      var inputs = document.querySelectorAll('input[type="hidden"]');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].name && inputs[i].name.indexOf("turnstile") >= 0) {
          inputs[i].value = tkn;
          inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
          inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      // Method 3: Try turnstile object
      if (window.turnstile) {
        try {
          var widgets = document.querySelectorAll('[data-sitekey]');
          for (var w = 0; w < widgets.length; w++) {
            try {
              window.turnstile.render(widgets[w], { sitekey: widgets[w].getAttribute("data-sitekey"), token: tkn });
            } catch (e2) {}
          }
        } catch (e) {}
      }

      // Method 4: Submit form if exists
      var form = document.querySelector("form");
      if (form) form.submit();
    }, token);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// INJECT TOKEN INTO ALL POSSIBLE LOCATIONS
// ============================================================

async function injectTokenEverywhere(page, token) {
  var injected = false;

  // 1. Try main page
  try {
    var mainResult = await page.evaluate(function(tkn) {
      var count = 0;
      var inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name*="turnstile"], input[name*="cf-"]');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = tkn;
        inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
        inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
        count++;
      }
      return count;
    }, token);
    if (mainResult > 0) injected = true;
  } catch (e) {}

  // 2. Try ALL frames
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    try {
      var frameUrl = frames[i].url();

      // Inject into challenges.cloudflare.com frames
      if (frameUrl.indexOf("challenges.cloudflare.com") >= 0) {
        var result = await injectTokenIntoFrame(frames[i], token);
        if (result) injected = true;
        log("inject", "Injected into challenges frame: " + frameUrl.slice(0, 80));
      }

      // Inject into auth.privy.io frames (they contain the widget)
      if (frameUrl.indexOf("auth.privy.io") >= 0) {
        try {
          await frames[i].evaluate(function(tkn) {
            var inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name*="turnstile"]');
            for (var j = 0; j < inputs.length; j++) {
              inputs[j].value = tkn;
              inputs[j].dispatchEvent(new Event("input", { bubbles: true }));
              inputs[j].dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, token);
          injected = true;
          log("inject", "Injected into privy frame");
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 3. Try via CDP (most reliable for cross-origin frames)
  try {
    var client = await page.target().createCDPSession();

    // Get all frames
    var frameTree = await client.send("Page.getFrameTree");

    function processFrame(frameInfo) {
      var frameId = frameInfo.frame.id;
      var frameUrl = frameInfo.frame.url || "";

      if (frameUrl.indexOf("challenges.cloudflare.com") >= 0 ||
          frameUrl.indexOf("auth.privy.io") >= 0) {
        // Add script to evaluate in this frame
        client.send("Page.addScriptToEvaluateOnNewDocument", {
          source: "window.__turnstileToken = '" + token + "';",
          worldName: "",
          includeCommandLineAPI: false,
        }).catch(function() {});
      }

      if (frameInfo.childFrames) {
        for (var i = 0; i < frameInfo.childFrames.length; i++) {
          processFrame(frameInfo.childFrames[i]);
        }
      }
    }

    if (frameTree && frameTree.frameTree) {
      processFrame(frameTree.frameTree);
    }
  } catch (e) {
    log("inject", "CDP inject failed: " + e.message);
  }

  return injected;
}

// ============================================================
// FIND SITEKEY FROM ALL SOURCES
// ============================================================

async function findSitekey(page) {
  // Source 1: data-sitekey attribute
  var sk = await page.evaluate(function() {
    var el = document.querySelector("[data-sitekey]");
    return el ? el.getAttribute("data-sitekey") : null;
  }).catch(function() { return null; });
  if (sk) { log("sitekey", "Found in main page: " + sk); return sk; }

  // Source 2: All frames
  var frames = page.frames();
  for (var i = 0; i < frames.length; i++) {
    try {
      var url = frames[i].url();

      // From iframe URL
      if (url.indexOf("challenge-platform") >= 0 || url.indexOf("turnstile") >= 0) {
        var match = url.match(/(0x4[A-Za-z0-9_-]{20,})/);
        if (match) { log("sitekey", "Found in iframe URL: " + match[1]); return match[1]; }
      }

      // From frame content
      try {
        var fsk = await frames[i].evaluate(function() {
          var el = document.querySelector("[data-sitekey]");
          if (el) return el.getAttribute("data-sitekey");
          return null;
        });
        if (fsk) { log("sitekey", "Found in frame: " + fsk); return fsk; }
      } catch (e) {}
    } catch (e) {}
  }

  // Source 3: Verified pred.app sitekey
  var knownSitekeys = [
    "0x4AAAAAAAM8ceq5KhP1uJBt",
    "0x4AAAAAAA_B4phBmvBO9Qwk",
  ];
  log("sitekey", "Using verified sitekey fallback: " + knownSitekeys[0]);
  return knownSitekeys[0];
}

// ============================================================
// SOLVE CAPTCHA WITH FULL DEBUG
// ============================================================

async function solveCaptchaFull(page, apiKey, pageUrl) {
  log("captcha", "--- CAPTCHA DEBUG START ---");

  // List all frames
  var frames = page.frames();
  log("captcha", "Total frames: " + frames.length);
  for (var i = 0; i < frames.length; i++) {
    try {
      log("captcha", "  Frame " + i + ": " + frames[i].url().slice(0, 100));
    } catch (e) {
      log("captcha", "  Frame " + i + ": [cross-origin]");
    }
  }

  // Extract params using hook data or fallback methods
  var params = await extractTurnstileParams(page);

  var sitekey = null;
  var solveOpts = {};

  if (params && params.sitekey) {
    sitekey = params.sitekey;
    if (params.action) solveOpts.action = params.action;
    if (params.cData) solveOpts.data = params.cData;
    if (params.chlPageData) solveOpts.pagedata = params.chlPageData;
    log("captcha", "Using params - sitekey: " + sitekey);
  } else {
    sitekey = "0x4AAAAAAAM8ceq5KhP1uJBt";
    log("captcha", "Using verified sitekey fallback: " + sitekey);
  }

  log("captcha", "Solving Turnstile with sitekey: " + sitekey);

  try {
    var token = await solveTurnstile(apiKey, sitekey, pageUrl, solveOpts);
    log("captcha", "Got solution token! Length=" + token.length);

    // Inject token using callback + DOM methods
    var injected = await injectTurnstileToken(page, token);
    log("captcha", "Injected via callback: " + injected);

    // Also try the old injection methods for good measure
    await injectTokenEverywhere(page, token);

    await sleep(5000);
    log("captcha", "--- CAPTCHA DEBUG END ---");
    return true;

  } catch (e) {
    log("captcha", "Solve failed: " + e.message);
    log("captcha", "--- CAPTCHA DEBUG END ---");
    return false;
  }
}

// ============================================================
// MAIN SIGNUP
// ============================================================

async function signupWithReferral(walletInfo, referralCode, captchaApiKey, delayMs) {
  var tag = "[" + walletInfo.index + "] " + walletInfo.address.slice(0, 10) + "...";
  var referralUrl = PRED_URL + "?referral_code=" + referralCode;
  var wallet = new ethers.Wallet(walletInfo.privateKey);
  var port = 9333 + (walletInfo.index % 100);
  var userDataDir = path.join(os.tmpdir(), "pred-chrome-" + walletInfo.index);

  // Kill old Chrome
  try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (e) {}

  var fp = getProfileFingerprint(walletInfo.index);
  console.log("  [device] " + fp.deviceModel);
  console.log("  [fingerprint] " + fp.platform + " | " + fp.viewport.width + "x" + fp.viewport.height + " | " + fp.webgl.renderer.slice(0, 30) + "...");

  // Fetch public IP
  var publicIP = "unknown";
  try {
    var ipRes = await axios.get("http://httpbin.org/ip", { timeout: 5000 });
    publicIP = ipRes.data && ipRes.data.origin ? ipRes.data.origin : "unknown";
  } catch (e) {
    try {
      var ipRes2 = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
      publicIP = ipRes2.data && ipRes2.data.ip ? ipRes2.data.ip : "unknown";
    } catch (e2) {}
  }
  console.log("  [ip] " + publicIP);

  // Direct connection (no proxy)
  var chromeArgs = [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=" + port,
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + userDataDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-gpu",
    "--disable-component-update",
    "--disable-background-downloads",
    "--disk-cache-dir=/dev/null",
    "--media-cache-size=1",
    "--disk-cache-size=1",
    "--user-agent=" + fp.userAgent,
    "--window-size=" + fp.viewport.width + "," + fp.viewport.height,
    "--lang=" + (fp.locale ? fp.locale.lang.split(',')[0] : "en-US"),
    "--disable-blink-features=AutomationControlled",
    "--no-pings",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-default-apps",
    "--no-zygote",
  ];

  var chromeExecutable = process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
  if (!fs.existsSync(chromeExecutable)) {
    if (fs.existsSync("/usr/bin/chromium")) {
      chromeExecutable = "/usr/bin/chromium";
    } else if (fs.existsSync("/usr/bin/chromium-browser")) {
      chromeExecutable = "/usr/bin/chromium-browser";
    }
  }

  var chromeProc = spawn(chromeExecutable, chromeArgs, { detached: true, stdio: "ignore" });
  chromeProc.unref();

  log(tag, "Waiting for Chrome CDP (" + chromeExecutable + ")...");
  await sleep(8000);

  var browser;
  try {
    browser = await puppeteer.connect({
      browserURL: "http://127.0.0.1:" + port,
      defaultViewport: null,
    });
  } catch (e) {
    try { if (chromeProc && chromeProc.pid) process.kill(-chromeProc.pid, "SIGKILL"); } catch (x) {}
    try { chromeProc.kill("SIGKILL"); } catch (x) {}
    try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (x) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (x) {}
    return { success: false, error: "Cannot connect to Chrome: " + e.message };
  }

  var pages = await browser.pages();
  var page = pages.length > 0 ? pages[0] : await browser.newPage();

  page.on("error", function(e) {
    log(tag, "Page crashed: " + (e ? e.message : "unknown"));
  });
  page.on("close", function() {
    log(tag, "Page closed");
  });

  log(tag, "Page ready, URL: " + page.url());

  try {
    // ── FIX: Set viewport & UA BEFORE navigating ────────────────────────────────
    await page.setViewport({
      width: fp.viewport.width,
      height: fp.viewport.height,
      isMobile: fp.isMobile,
      hasTouch: fp.hasTouch,
      deviceScaleFactor: fp.isMobile ? 2.5 : 1
    });
    await page.setUserAgent(fp.userAgent);

    // Set timezone via CDP to match locale region (anti timezone-fingerprint)
    try {
      var cdp = await page.createCDPSession();
      var tz = (fp.locale && fp.locale.tz) ? fp.locale.tz : "Asia/Jakarta";
      await cdp.send("Emulation.setTimezoneOverride", { timezoneId: tz });
      await cdp.send("Emulation.setLocaleOverride", { locale: (fp.locale && fp.locale.lang) ? fp.locale.lang.split(',')[0] : "id-ID" });
    } catch (e) {}

    // Inject fingerprint spoofing (navigator, WebGL, screen, timezone, touch)
    await page.evaluateOnNewDocument(function(profile) {
      // 0. Hide webdriver flag (headless detection)
      try {
        Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'languages', { get: function() { return profile.locale.lang.split(',').map(function(s) { return s.split(';')[0]; }); } });
      } catch (e) {}

      // 0b. Kill puppeteer-extra / CDP detection probes
      try {
        if (navigator.__proto__) {
          delete navigator.__proto__.webdriver;
        }
      } catch (e) {}

      // 1. Spoof navigator properties
      Object.defineProperty(navigator, 'platform', { get: function() { return profile.platform; } });
      Object.defineProperty(navigator, 'deviceMemory', { get: function() { return profile.deviceMemory; } });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return profile.hardwareConcurrency; } });
      Object.defineProperty(navigator, 'language', { get: function() { return profile.locale.lang.split(',')[0]; } });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return profile.hasTouch ? 5 : 0; } });

      // 1b. Fake a realistic plugins & userAgent string
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: function() {
            if (profile.isMobile) return [];
            return [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
          }
        });
      } catch (e) {}

      // 1c. Consistency: plugin length & mimeTypes length
      try {
        Object.defineProperty(navigator, 'userAgent', { get: function() { return profile.userAgent; } });
      } catch (e) {}

      // 2. Spoof screen resolution
      Object.defineProperty(screen, 'width', { get: function() { return profile.viewport.width; } });
      Object.defineProperty(screen, 'height', { get: function() { return profile.viewport.height; } });
      Object.defineProperty(screen, 'availWidth', { get: function() { return profile.viewport.width; } });
      Object.defineProperty(screen, 'availHeight', { get: function() { return profile.viewport.height - 40; } });
      Object.defineProperty(screen, 'colorDepth', { get: function() { return 24; } });
      Object.defineProperty(screen, 'pixelDepth', { get: function() { return 24; } });

      // 3. Spoof WebGL vendor and renderer
      var getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return profile.webgl.vendor;   // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return profile.webgl.renderer; // UNMASKED_RENDERER_WEBGL
        return getParameter.apply(this, arguments);
      };

      if (window.WebGL2RenderingContext) {
        var getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return profile.webgl.vendor;
          if (param === 37446) return profile.webgl.renderer;
          return getParameter2.apply(this, arguments);
        };
      }

      // 4. Add WebGL a little noise to break canonical fingerprinting
      try {
        var origExt = WebGLRenderingContext.prototype.getExtension;
        WebGLRenderingContext.prototype.getExtension = function(name) {
          if (name === 'WEBGL_debug_renderer_info' || name === 'WEBGL_debug_shaders') return null;
          return origExt.apply(this, arguments);
        };
      } catch (e) {}

      // 5. Chrome runtime object (Chrome-specific, realistic)
      try {
        if (!window.chrome) {
          window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
        }
        window.chrome.runtime = window.chrome.runtime || {};
      } catch (e) {}

      // 6. Permission state (notifications) to mimic real user
      try {
        if (navigator.permissions && navigator.permissions.query) {
          var origQuery = navigator.permissions.query;
          navigator.permissions.query = function(params) {
            if (params && params.name === 'notifications') {
              return Promise.resolve({ state: Notification.permission, onchange: null });
            }
            return origQuery.call(this, params);
          };
        }
      } catch (e) {}
    }, fp);

    // Inject fake MetaMask
    await page.evaluateOnNewDocument(function(addr) {
      var CHAIN_ID = "0x2105";
      var NET = "8453";
      var ACC = [addr];

      function FakeProvider() {
        this._events = {};
        this.chainId = CHAIN_ID;
        this.networkVersion = NET;
        this.selectedAddress = addr;
        this.isConnected = function() { return true; };
        this.isMetaMask = true;
      }
      FakeProvider.prototype.on = function(e, h) {
        if (!this._events[e]) this._events[e] = [];
        this._events[e].push(h);
        return this;
      };
      FakeProvider.prototype.removeListener = function(e, h) {
        if (this._events[e]) this._events[e] = this._events[e].filter(function(x) { return x !== h; });
        return this;
      };
      FakeProvider.prototype.emit = function(e) {
        var a = Array.prototype.slice.call(arguments, 1);
        if (this._events[e]) this._events[e].forEach(function(h) { try { h.apply(null, a); } catch (x) {} });
      };
      FakeProvider.prototype.request = function(o) {
        var m = o.method;
        var p = o.params || [];
        if (m === "eth_requestAccounts" || m === "eth_accounts") return Promise.resolve(ACC);
        if (m === "eth_chainId") return Promise.resolve(CHAIN_ID);
        if (m === "net_version") return Promise.resolve(NET);
        if (m === "personal_sign") return window.__predSign(p[0]);
        if (m === "eth_signTypedData_v4") {
          var d = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1];
          return window.__predSignTypedData(JSON.stringify(d));
        }
        if (m === "wallet_switchEthereumChain" || m === "wallet_addEthereumChain" ||
            m === "eth_requestPermissions" || m === "wallet_getPermissions" ||
            m === "wallet_requestPermissions") return Promise.resolve(null);
        if (m === "eth_getBalance") return Promise.resolve("0x0");
        return Promise.reject(new Error("Method " + m + " not supported"));
      };
      FakeProvider.prototype.sendAsync = function(o, fn) {
        this.request(o).then(function(r) { fn(null, { id: o.id, jsonrpc: "2.0", result: r }); }).catch(fn);
      };
      FakeProvider.prototype.send = function(m, p) {
        if (typeof m === "string") return this.request({ method: m, params: p });
        return this.sendAsync(m, p);
      };
      FakeProvider.prototype.enable = function() { return this.request({ method: "eth_requestAccounts" }); };

      window.ethereum = new FakeProvider();
      if (!window.web3) window.web3 = {};
      window.web3.currentProvider = window.ethereum;
    }, wallet.address);

    // Expose signing
    await page.exposeFunction("__predSign", async function(messageHex) {
      var msgBytes = ethers.isHexString(messageHex)
        ? ethers.getBytes(messageHex)
        : ethers.toUtf8Bytes(messageHex);
      return await wallet.signMessage(msgBytes);
    });

    await page.exposeFunction("__predSignTypedData", async function(typedDataJson) {
      var data = JSON.parse(typedDataJson);
      return await wallet.signTypedData(data.domain, data.types, data.message);
    });

    // Inject Turnstile hook to intercept sitekey & callback
    var hookScript = getTurnstileHookScript();
    await page.evaluateOnNewDocument(hookScript);

    // Use CDP to inject hook into ALL frames (including cross-origin Privy iframe)
    try {
      var cdpClient = await page.createCDPSession();
      await cdpClient.send("Page.addScriptToEvaluateOnNewDocument", {
        source: hookScript,
      });
      log(tag, "Hook injected via CDP into all frames");
    } catch (e) {
      log(tag, "CDP hook injection failed: " + e.message);
    }

    // ── FIX: Use domcontentloaded instead of networkidle2 (pred.app uses persistent WebSockets/analytics that prevent networkidle2) ──
    log(tag, "Navigating to referral URL (with all injections active)...");
    var navOk = false;
    for (var navTry = 0; navTry < 3; navTry++) {
      try {
        await page.goto(referralUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
        navOk = true;
        break;
      } catch (navErr) {
        log(tag, "Navigation attempt " + (navTry + 1) + " failed: " + navErr.message);
        if (navTry < 2) await sleep(5000);
      }
    }
    if (!navOk) {
      throw new Error("All navigation attempts failed");
    }
    try {
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
    } catch (e) {
      log(tag, "waitForNetworkIdle timed out (proceeding): " + e.message);
    }
    await sleep(4000);

    log(tag, "Page loaded: " + page.url());
    try { await page.screenshot({ path: "/tmp/pred-loaded-" + walletInfo.index + ".png" }); } catch (e) {}

    // ── FIX: Intercept network responses to capture auth tokens ────────
    var capturedPrivyToken = null;
    var capturedAccessToken = null;
    page.on("response", async function(response) {
      try {
        var url = response.url();
        var status = response.status();
        if (status < 200 || status >= 300) return;
        var isPredApi = url.indexOf("pred.app/api") >= 0;
        var isPrivyApi = url.indexOf("privy.io/api") >= 0;
        if (!isPredApi && !isPrivyApi) return;
        try {
          var text = await response.text();
          if (!text || text.length < 100 || text.indexOf(".") < 0) return;
          // Collect all JWT-looking strings from the response
          var candidates = [];
          try {
            var json = JSON.parse(text);
            (function collect(o) {
              if (!o || typeof o !== "object") return;
              if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) collect(o[i]); return; }
              for (var k in o) {
                var v = o[k];
                if (typeof v === "string") {
                  var m = v.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
                  if (m) candidates.push(m[0]);
                } else if (v && typeof v === "object") { collect(v); }
              }
            })(json);
          } catch (ej) {
            var m = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
            if (m) candidates = candidates.concat(m);
          }
          for (var ci = 0; ci < candidates.length; ci++) {
            var val = candidates[ci];
            if (val.length < 100) continue;
            var iss = "";
            try {
              var payload = JSON.parse(Buffer.from(val.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
              iss = (payload.iss || "") + "|" + (payload.aud || "");
            } catch (ep) {}
            if (iss.indexOf("pred.app") >= 0 || isPredApi) {
              if (!capturedAccessToken) { capturedAccessToken = val; log(tag, "PRED.APP ACCESS TOKEN captured: " + url.slice(0, 60)); }
            } else if (iss.indexOf("privy") >= 0 || isPrivyApi) {
              if (!capturedPrivyToken) { capturedPrivyToken = val; log(tag, "PRIVY TOKEN captured: " + url.slice(0, 60)); }
            }
          }
        } catch (e) {}
      } catch (e) {}
    });

    // Also intercept postMessage between auth.privy.io iframe and main page
    await page.evaluateOnNewDocument(function() {
      window.__privyTokens = [];
      window.addEventListener("message", function(event) {
        try {
          var data = event.data;
          if (typeof data === "string") {
            // Direct token string
            if (data.split && data.split(".").length === 3 && data.length > 100) {
              window.__privyTokens.push(data);
            }
            // JSON-wrapped token
            try {
              var parsed = JSON.parse(data);
              var tokenFields = ["token", "accessToken", "access_token", "privyToken", "privy_token"];
              for (var i = 0; i < tokenFields.length; i++) {
                if (parsed[tokenFields[i]] && typeof parsed[tokenFields[i]] === "string" && parsed[tokenFields[i]].split(".").length === 3) {
                  window.__privyTokens.push(parsed[tokenFields[i]]);
                }
              }
            } catch (e) {}
          } else if (data && typeof data === "object") {
            // Object with token field
            var tokenFields = ["token", "accessToken", "access_token", "privyToken", "privy_token"];
            for (var i = 0; i < tokenFields.length; i++) {
              if (data[tokenFields[i]] && typeof data[tokenFields[i]] === "string" && data[tokenFields[i]].split(".").length === 3 && data[tokenFields[i]].length > 100) {
                window.__privyTokens.push(data[tokenFields[i]]);
              }
            }
          }
        } catch (e) {}
      });
    });

    // Click Sign in (with retry — page may not be hydrated yet)
    log(tag, "Clicking Sign in...");
    var signInClicked = false;
    for (var si = 0; si < 6 && !signInClicked; si++) {
      signInClicked = await clickTextAll(page, "Sign in");
      if (signInClicked) break;
      var btnDump = await page.evaluate(function() {
        var out = [];
        var els = document.querySelectorAll("button, a, div[role='button']");
        for (var i = 0; i < els.length && i < 30; i++) {
          var t = (els[i].textContent || "").trim();
          if (t) out.push(t.slice(0, 40));
        }
        return out;
      }).catch(function() { return []; });
      log(tag, "Sign in not found (retry " + (si + 1) + "/6). Buttons: " + JSON.stringify(btnDump));
      await sleep(4000);
    }
    log(tag, "Sign in clicked: " + signInClicked);
    await sleep(3000);

    // Click Continue with a wallet (with retry)
    log(tag, "Clicking Continue with a wallet...");
    var contWallet = false;
    for (var cw = 0; cw < 5 && !contWallet; cw++) {
      contWallet = await clickTextAll(page, "Continue with a wallet");
      if (contWallet) break;
      log(tag, "Continue with a wallet not found, retry " + (cw + 1) + "/5...");
      await sleep(3000);
    }
    log(tag, "Continue with wallet clicked: " + contWallet);
    await sleep(3000);

    // Click MetaMask (with retry)
    log(tag, "Clicking MetaMask...");
    var mmClicked = false;
    for (var mc = 0; mc < 5 && !mmClicked; mc++) {
      mmClicked = await clickTextAll(page, "MetaMask");
      if (mmClicked) break;
      log(tag, "MetaMask not found, retry " + (mc + 1) + "/5...");
      await sleep(3000);
    }
    log(tag, "MetaMask clicked: " + mmClicked);
    await sleep(6000);

    // Screenshot after clicking MetaMask (shows CAPTCHA or auth prompt)
    try {
      await page.screenshot({ path: "/tmp/pred-debug-" + walletInfo.index + ".png" });
      log(tag, "Screenshot saved: /tmp/pred-debug-" + walletInfo.index + ".png");
    } catch (e) {}

    // ── FIX: Always attempt CAPTCHA solve (not just on error) ─────────────────
    // Some flows show CAPTCHA without explicit error text
    if (captchaApiKey) {
      for (var attempt = 0; attempt < 5; attempt++) {
        await sleep(3000);

        // Check page state
        var pageText = await page.evaluate(function() {
          return document.body ? document.body.innerText || "" : "";
        }).catch(function() { return ""; });

        var errorType = null;
        if (pageText.indexOf("did not pass CAPTCHA") >= 0) errorType = "captcha";
        else if (pageText.indexOf("adblocker or VPN") >= 0) errorType = "blocked";
        else if (pageText.indexOf("Something went wrong") >= 0) errorType = "generic";

        // Check if turnstile widget is present in ANY frame
        var hasTurnstile = false;
        try {
          var allFrames = page.frames();
          for (var fi = 0; fi < allFrames.length; fi++) {
            var frameUrl = "";
            try { frameUrl = allFrames[fi].url(); } catch (e) {}
            if (frameUrl.indexOf("challenges.cloudflare") >= 0 || frameUrl.indexOf("turnstile") >= 0) {
              hasTurnstile = true;
              break;
            }
          }
        } catch (e) {}
        if (!hasTurnstile) {
          hasTurnstile = await page.evaluate(function() {
            var frames = Array.from(document.querySelectorAll("iframe"));
            for (var i = 0; i < frames.length; i++) {
              if (frames[i].src && frames[i].src.indexOf("challenges.cloudflare") >= 0) return true;
              if (frames[i].src && frames[i].src.indexOf("turnstile") >= 0) return true;
            }
            return !!document.querySelector("[data-sitekey]");
          }).catch(function() { return false; });
        }

        // Check if auth already done (real Privy JWT in storage)
        var hasAuth = await page.evaluate(function() {
          function isRealJWT(val) {
            if (!val || val.length < 100) return false;
            var parts = val.split(".");
            if (parts.length !== 3) return false;
            try {
              var h = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
              if (!h.alg) return false;
              // Privy tokens have iss containing privy.io or aud containing privy
              try { var payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); return !!(payload.iss && payload.iss.indexOf("privy") >= 0); } catch(e) {}
              return false;
            } catch (e) { return false; }
          }
          for (var i = 0; i < localStorage.length; i++) {
            var v = localStorage.getItem(localStorage.key(i));
            if (isRealJWT(v)) return true;
          }
          for (var i = 0; i < sessionStorage.length; i++) {
            var v = sessionStorage.getItem(sessionStorage.key(i));
            if (isRealJWT(v)) return true;
          }
          return false;
        }).catch(function() { return false; });

        if (hasAuth) {
          log(tag, "Auth token detected, stopping CAPTCHA loop");
          break;
        }

        log(tag, "Attempt " + (attempt + 1) + " | error=" + (errorType || "none") + " | hasTurnstile=" + hasTurnstile);

        if (!errorType && !hasTurnstile) {
          log(tag, "No error/CAPTCHA widget detected yet, doing preemptive solve...");
          if (attempt === 0) {
            var solved0 = await solveCaptchaFull(page, captchaApiKey, referralUrl);
            log(tag, "Preemptive CAPTCHA solve: " + solved0);
            await sleep(8000);
          }
          // DON'T break here — continue loop to check for auth token or turnstile
          continue;
        }

        if (errorType === "blocked" || errorType === "generic") {
          log(tag, "Full reload needed...");
          await clickTextAll(page, "×");
          await sleep(1000);
          await page.goto(referralUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(3000);
          await clickTextAll(page, "Sign in");
          await sleep(3000);
          await clickTextAll(page, "Continue with a wallet");
          await sleep(3000);
          await clickTextAll(page, "MetaMask");
          await sleep(6000);
        } else if (errorType === "captcha") {
          await clickTextAll(page, "Retry");
          await sleep(4000);
        }

        try { await page.screenshot({ path: "/tmp/pred-pre-captcha-" + walletInfo.index + "-" + attempt + ".png" }); } catch (e) {}

        var solved = await solveCaptchaFull(page, captchaApiKey, referralUrl);
        log(tag, "CAPTCHA solve result: " + solved);

        if (solved) {
          await sleep(8000);
          var stillError = await page.evaluate(function() {
            var text = document.body.innerText || "";
            return text.indexOf("CAPTCHA") >= 0 || text.indexOf("went wrong") >= 0;
          }).catch(function() { return false; });

          if (!stillError) {
            log(tag, "CAPTCHA solved successfully!");
            break;
          }
          log(tag, "Still showing error after solve, retrying...");
        }

        try { await page.screenshot({ path: "/tmp/pred-postsolve-" + walletInfo.index + "-" + attempt + ".png" }); } catch (e) {}
      }
    }

    // Wait for auth
    log(tag, "Waiting for auth token (90s)...");

    function cleanupChrome() {
      try { if (browser) browser.disconnect(); } catch (e) {}
      try { if (chromeProc && chromeProc.pid) process.kill(-chromeProc.pid, "SIGKILL"); } catch (e) {}
      try { if (chromeProc) chromeProc.kill("SIGKILL"); } catch (e) {}
      try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (e) {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
      try { execSync("rm -rf /tmp/com.google.Chrome.* /tmp/.org.chromium.Chromium.* /tmp/.com.google.Chrome.* 2>/dev/null"); } catch (e) {}
    }

    // ── FIX: Search for JWT token in ALL frames (main page + all iframes) ───────
    function isJWT(val) {
      if (!val || val.length < 50) return false;
      var parts = val.split(".");
      if (parts.length !== 3) return false;
      try {
        var h = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
        if (!h.alg) return false;
        // Accept any JWT with alg + typ JWT, OR Privy tokens
        // Privy JWTs have iss containing privy
        try {
          var p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
          if (p.iss && (p.iss.indexOf("privy") >= 0 || p.iss.indexOf("pred.app") >= 0)) return true;
        } catch(e) {}
        return h.typ === "JWT" && val.length > 200;
      } catch (e) { return false; }
    }

    async function findTokenInFrame(frame, label) {
      try {
        return await frame.evaluate(function() {
          function isPredJWT(val) {
            if (!val || val.length < 50) return false;
            var p = val.split(".");
            if (p.length !== 3) return false;
            try {
              var h = JSON.parse(atob(p[0].replace(/-/g, "+").replace(/_/g, "/")));
              if (!h.alg) return false;
              try {
                var payload = JSON.parse(atob(p[1].replace(/-/g, "+").replace(/_/g, "/")));
                // ONLY pred.app access tokens — not privy tokens
                if (payload.iss && (payload.iss.indexOf("pred.app") >= 0)) return true;
              } catch (e) {}
              return false;
            } catch (e) { return false; }
          }
          // PRIORITIZE pred.app access_token key specifically
          try {
            var at = localStorage.getItem("access_token");
            if (at && isPredJWT(at)) return { token: at, source: "localStorage:access_token" };
          } catch (e) {}
          try {
            var at2 = localStorage.getItem("accessToken");
            if (at2 && isPredJWT(at2)) return { token: at2, source: "localStorage:accessToken" };
          } catch (e) {}
          // localStorage (only pred.app tokens)
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            var v = localStorage.getItem(k);
            if (isPredJWT(v)) return { token: v, source: "localStorage:" + k };
          }
          // sessionStorage
          for (var i = 0; i < sessionStorage.length; i++) {
            var k = sessionStorage.key(i);
            var v = sessionStorage.getItem(k);
            if (isPredJWT(v)) return { token: v, source: "sessionStorage:" + k };
          }
          // cookies (only pred.app token cookies)
          var cookies = document.cookie.split(";");
          for (var i = 0; i < cookies.length; i++) {
            var parts = cookies[i].split("=");
            if (parts.length >= 2) {
              var val = parts.slice(1).join("=").trim();
              if (isPredJWT(val)) return { token: val, source: "cookie:" + parts[0].trim() };
            }
          }
          // window-level token globals (only pred.app tokens)
          var globals = ["accessToken", "access_token", "token", "idToken", "authToken"];
          for (var gi = 0; gi < globals.length; gi++) {
            try {
              var gv = window[globals[gi]];
              if (typeof gv === "string" && isPredJWT(gv)) return { token: gv, source: "window." + globals[gi] };
            } catch (e) {}
          }
          return null;
        });
      } catch (e) { return null; }
    }

    var authToken = null;
    var startWait = Date.now();
    while (Date.now() - startWait < 90000) {
      // Check main page localStorage `access_token` FIRST (pred.app access token)
      authToken = await findTokenInFrame(page, "main");
      if (authToken) { log(tag, "Token found in main page: " + authToken.source); break; }

      // Check all iframes — Privy stores token in auth.privy.io frame
      var frames = page.frames();
      for (var fi = 0; fi < frames.length; fi++) {
        var frameUrl = "";
        try { frameUrl = frames[fi].url(); } catch (e) {}
        var frameToken = await findTokenInFrame(frames[fi], frameUrl.slice(0, 50));
        if (frameToken) {
          authToken = { token: frameToken.token, source: "frame[" + frameUrl.slice(0, 50) + "]:" + frameToken.source };
          log(tag, "Token found in frame: " + authToken.source);
          break;
        }
      }
      if (authToken) break;

      // Check network-captured pred.app access token (preferred), then privy token
      if (capturedAccessToken) {
        authToken = { token: capturedAccessToken, source: "network-access-token" };
        log(tag, "PRED.APP access token found from network interception!");
        break;
      }
      if (capturedPrivyToken) {
        authToken = { token: capturedPrivyToken, source: "network-privy-token" };
        log(tag, "Privy token found from network interception!");
        break;
      }

      // Check postMessage tokens (fallback, last resort)
      try {
        var pmTokens = await page.evaluate(function() {
          return window.__privyTokens || [];
        });
        if (pmTokens && pmTokens.length > 0) {
          // prefer a pred.app token in postMessage if present
          var found = null;
          for (var pi = pmTokens.length - 1; pi >= 0; pi--) {
            var pv = pmTokens[pi];
            try {
              var pj = JSON.parse(atob(pv.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
              if (pj.iss && pj.iss.indexOf("pred.app") >= 0) { found = { token: pv, source: "postMessage(pred)" }; break; }
            } catch (e) {}
          }
          if (!found) found = { token: pmTokens[pmTokens.length - 1], source: "postMessage" };
          authToken = found;
          log(tag, "Token found from postMessage!");
          break;
        }
      } catch (e) {}

      log(tag, "Token not found yet, waiting 3s... (" + Math.round((Date.now() - startWait) / 1000) + "s elapsed)");
      await sleep(3000);
    }

    await page.screenshot({ path: "/tmp/pred-final-" + walletInfo.index + ".png" }).catch(function() {});

    // Debug: dump page state
    try {
      var pageState = await page.evaluate(function() {
        var result = {
          url: location.href,
          title: document.title,
          bodySnippet: (document.body.innerText || "").slice(0, 300),
          iframes: [],
          lsKeys: [],
        };
        var iframes = document.querySelectorAll("iframe");
        for (var i = 0; i < iframes.length; i++) {
          result.iframes.push(iframes[i].src ? iframes[i].src.slice(0, 100) : "no-src");
        }
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          var v = localStorage.getItem(k);
          result.lsKeys.push(k + "=" + (v ? v.length : 0));
        }
        return result;
      });
      log(tag, "Final page: " + pageState.url);
      log(tag, "Body: " + pageState.bodySnippet.slice(0, 200));
      log(tag, "LS keys: " + pageState.lsKeys.join(", "));
      log(tag, "Iframes: " + pageState.iframes.join(" | "));
    } catch (e) { log(tag, "Page dump failed: " + e.message); }

    if (authToken) {
      log(tag, "AUTH TOKEN CAPTURED! Source: " + authToken.source);
      cleanupChrome();

      // Determine if this is already a pred.app access token
      var isPredAccess = (authToken.source.indexOf("pred") >= 0 && authToken.source.indexOf("access") >= 0);
      try {
        var tPayload = JSON.parse(Buffer.from(authToken.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
        if (tPayload.iss && (tPayload.iss.indexOf("pred.app") >= 0 || tPayload.iss.indexOf("pred") === 0)) {
          isPredAccess = true;
        }
      } catch (e) {}

      return {
        success: true,
        privyToken: authToken.token,
        accessToken: isPredAccess ? authToken.token : null,
        tokenSource: authToken.source,
        isPredAccessToken: isPredAccess
      };
    }

    log(tag, "Failed to capture auth token");
    cleanupChrome();
    return { success: false, error: "Could not capture auth token" };

  } catch (err) {
    log(tag, "Error: " + err.message);
    try { await page.screenshot({ path: "/tmp/pred-error-" + walletInfo.index + ".png" }); } catch (e) {}
    try { if (browser) browser.disconnect(); } catch (e) {}
    try { if (chromeProc && chromeProc.pid) process.kill(-chromeProc.pid, "SIGKILL"); } catch (e) {}
    try { if (chromeProc) chromeProc.kill("SIGKILL"); } catch (e) {}
    try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (e) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, error: err.message };
  }
}

// ============================================================
// MANUAL MODE
// ============================================================

async function openBrowserManual(walletInfo, referralCode) {
  var referralUrl = PRED_URL + "?referral_code=" + referralCode;
  console.log("\n" + "-".repeat(50));
  console.log("MANUAL MODE - Wallet [" + walletInfo.index + "]");
  console.log("-".repeat(50));
  console.log("Address    : " + walletInfo.address);
  console.log("Private Key: " + walletInfo.privateKey);
  console.log("-".repeat(50) + "\n");

  var chromeProc = spawn("/usr/bin/google-chrome", [referralUrl], {
    detached: true, stdio: "ignore",
  });
  chromeProc.unref();
  log("init", "Chrome launched");

  return new Promise(function(resolve) {
    setTimeout(function() {
      try { chromeProc.kill("SIGTERM"); } catch (e) {}
      resolve({ success: false, error: "Timeout" });
    }, 300000);
  });
}

module.exports = {
  signupWithReferral: signupWithReferral,
  openBrowserManual: openBrowserManual,
  sleep: sleep,
};
