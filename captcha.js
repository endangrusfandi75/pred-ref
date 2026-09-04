const TwoCaptcha = require("@2captcha/captcha-solver");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 2Captcha Turnstile Solver (Official SDK)
// ============================================================

async function solveTurnstile(apiKey, siteKey, pageUrl, opts) {
  opts = opts || {};
  console.log("    [captcha] Submitting Turnstile via Official 2Captcha SDK...");
  console.log("    [captcha]   siteKey: " + siteKey);
  console.log("    [captcha]   pageUrl: " + pageUrl);
  if (opts.action) console.log("    [captcha]   action: " + opts.action);
  if (opts.data) console.log("    [captcha]   cData: " + opts.data);
  if (opts.pagedata) console.log("    [captcha]   pagedata: " + (opts.pagedata || "").slice(0, 50) + "...");

  const solver = new TwoCaptcha.Solver(apiKey, 3000);

  const params = {
    pageurl: pageUrl,
    sitekey: siteKey,
  };
  if (opts.action) params.action = opts.action;
  if (opts.data) params.data = opts.data;
  if (opts.pagedata) params.pagedata = opts.pagedata;
  if (opts.userAgent) params.userAgent = opts.userAgent;

  const res = await solver.cloudflareTurnstile(params);

  if (!res || !res.data) {
    throw new Error("2Captcha returned empty solution");
  }

  const token = res.data;
  console.log("    [captcha] Turnstile solved via SDK! Token length: " + token.length);
  return token;
}

// ============================================================
// Inject turnstile.render hook (call BEFORE page loads)
// This intercepts the sitekey, action, cData, chlPageData
// and stores the callback so we can trigger it with our token
// ============================================================

function getTurnstileHookScript() {
  return `
    (function() {
      window.__turnstileData = null;
      window.__turnstileCallback = null;
      window.__turnstileWidgetId = null;

      // Wait for turnstile object to appear and hook it
      var hookInterval = setInterval(function() {
        if (window.turnstile && window.turnstile.render) {
          var originalRender = window.turnstile.render.bind(window.turnstile);

          window.turnstile.render = function(container, params) {
            console.log('[turnstile-hook] render intercepted!');
            window.__turnstileData = {
              sitekey: params.sitekey || params['sitekey'],
              action: params.action || null,
              cData: params.cData || params['cdata'] || null,
              chlPageData: params.chlPageData || params['chlpagedata'] || null,
              appearance: params.appearance || null,
              size: params.size || null,
            };

            // Store the callback
            if (typeof params.callback === 'function') {
              window.__turnstileCallback = params.callback;
            }

            console.log('[turnstile-hook] sitekey=' + window.__turnstileData.sitekey);
            console.log('[turnstile-hook] action=' + window.__turnstileData.action);

            // Call original render
            var widgetId = originalRender(container, params);
            window.__turnstileWidgetId = widgetId;
            return widgetId;
          };

          clearInterval(hookInterval);
          console.log('[turnstile-hook] Hook installed successfully');
        }
      }, 100);

      // Cleanup after 30 seconds
      setTimeout(function() { clearInterval(hookInterval); }, 30000);
    })();
  `;
}

// ============================================================
// Extract Turnstile params from hooked data or page
// ============================================================

async function extractTurnstileParams(page) {
  var frames = page.frames();

  // Method 0: Check frame URLs for Turnstile pattern /0x4[A-Za-z0-9_-]{20,}/
  for (var i = 0; i < frames.length; i++) {
    try {
      var url = frames[i].url();
      if (url.indexOf("challenge-platform") >= 0 || url.indexOf("turnstile") >= 0) {
        var match = url.match(/(0x4[A-Za-z0-9_-]{20,})/);
        if (match) {
          console.log("    [captcha] Got sitekey from frame URL: " + match[1]);
          return { sitekey: match[1], action: null, cData: null, chlPageData: null };
        }
      }
    } catch (e) {}
  }

  // Method 1: From our hook
  try {
    var hooked = await page.evaluate(function() {
      return window.__turnstileData || null;
    });
    if (hooked && hooked.sitekey) {
      console.log("    [captcha] Got sitekey from hook: " + hooked.sitekey);
      return hooked;
    }
  } catch (e) {}

  // Method 1b: Check all frames for hooked data
  for (var i = 0; i < frames.length; i++) {
    try {
      var frameUrl = frames[i].url();
      if (frameUrl.indexOf("auth.privy.io") >= 0) {
        var hookedInFrame = await frames[i].evaluate(function() {
          return window.__turnstileData || null;
        });
        if (hookedInFrame && hookedInFrame.sitekey) {
          console.log("    [captcha] Got sitekey from privy frame hook: " + hookedInFrame.sitekey);
          return hookedInFrame;
        }
      }
    } catch (e) {}
  }

  // Method 2: data-sitekey attribute in any frame
  for (var i = 0; i < frames.length; i++) {
    try {
      var sk = await frames[i].evaluate(function() {
        var el = document.querySelector("[data-sitekey]");
        return el ? el.getAttribute("data-sitekey") : null;
      });
      if (sk) {
        console.log("    [captcha] Got sitekey from data-sitekey attr: " + sk);
        return { sitekey: sk, action: null, cData: null, chlPageData: null };
      }
    } catch (e) {}
  }

  // Method 3: From Turnstile script sources in frames
  for (var i = 0; i < frames.length; i++) {
    try {
      var sk2 = await frames[i].evaluate(function() {
        var scripts = document.querySelectorAll("script[src*='turnstile'], script[src*='challenges.cloudflare']");
        for (var s = 0; s < scripts.length; s++) {
          var m = scripts[s].src.match(/(0x4[A-Za-z0-9_-]{20,})/);
          if (m) return m[1];
        }
        var allScripts = document.querySelectorAll("script:not([src])");
        for (var s = 0; s < allScripts.length; s++) {
          var txt = allScripts[s].textContent || "";
          var m2 = txt.match(/sitekey['":\s]+['"]?(0x4[a-zA-Z0-9_-]{20,})/);
          if (m2) return m2[1];
        }
        return null;
      });
      if (sk2) {
        console.log("    [captcha] Got sitekey from script source: " + sk2);
        return { sitekey: sk2, action: null, cData: null, chlPageData: null };
      }
    } catch (e) {}
  }

  // Fallback to verified pred.app sitekey
  console.log("    [captcha] Using verified pred.app sitekey: 0x4AAAAAAAM8ceq5KhP1uJBt");
  return { sitekey: "0x4AAAAAAAM8ceq5KhP1uJBt", action: null, cData: null, chlPageData: null };
}

// ============================================================
// Inject Turnstile token + trigger callback
// ============================================================

async function injectTurnstileToken(page, token) {
  var injected = false;
  var frames = page.frames();

  for (var i = 0; i < frames.length; i++) {
    try {
      var res = await frames[i].evaluate(function(tkn) {
        var actions = [];

        // 1. Set all input elements
        var inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name*="turnstile"], input[id*="turnstile"]');
        for (var j = 0; j < inputs.length; j++) {
          inputs[j].value = tkn;
          inputs[j].dispatchEvent(new Event("input", { bubbles: true }));
          inputs[j].dispatchEvent(new Event("change", { bubbles: true }));
          actions.push("input:" + (inputs[j].name || inputs[j].id));
        }

        // 2. Override getResponse on window.turnstile
        if (window.turnstile) {
          try {
            window.turnstile.getResponse = function() { return tkn; };
            actions.push("turnstile.getResponse");
          } catch (e) {}

          // 2b. Try to find widget ID and call execute/reset
          try {
            var widgetIds = window.turnstile._widgets || [];
            for (var w = 0; w < widgetIds.length; w++) {
              try {
                window.turnstile.execute(widgetIds[w]);
                actions.push("execute:" + widgetIds[w]);
              } catch (ex) {}
            }
          } catch (ew) {}

          // 2c. Override isExpired
          try {
            window.turnstile.isExpired = function() { return false; };
            actions.push("isExpired");
          } catch (e) {}
        }

        // 3. Trigger hooked callback if intercepted
        if (typeof window.__turnstileCallback === "function") {
          try {
            window.__turnstileCallback(tkn);
            actions.push("callback");
          } catch (e) {}
        }

        // 4. Dispatch turnstile-verified event on all relevant elements
        try {
          var event = new CustomEvent("turnstile-verified", { detail: { token: tkn } });
          document.dispatchEvent(event);
          actions.push("dispatchEvent");
        } catch (e) {}

        // 5. Try to find and call Privy's internal callback
        try {
          // Privy stores callbacks in various ways
          var keys = Object.keys(window);
          for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            if (key.indexOf("turnstile") >= 0 || key.indexOf("captcha") >= 0 || key.indexOf("Turnstile") >= 0) {
              var val = window[key];
              if (typeof val === "function") {
                try { val(tkn); actions.push("fn:" + key); } catch (ef) {}
              }
            }
          }
        } catch (ep) {}

        return actions.length ? actions.join(", ") : null;
      }, token);

      if (res) {
        console.log("    [captcha] Frame " + i + " injected: " + res);
        injected = true;
      }
    } catch (e) {}
  }

  await sleep(1000);
  return injected;
}

module.exports = {
  solveTurnstile,
  getTurnstileHookScript,
  extractTurnstileParams,
  injectTurnstileToken,
};
