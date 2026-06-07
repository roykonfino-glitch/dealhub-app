'use strict';
/**
 * DealHub Auth Server — runs locally, opens DealHub login window,
 * captures session cookies, and serves them to the web app.
 *
 * Usage:
 *   node auth-server.js
 *
 * Then open https://dealhub-web.vercel.app/dealroom — it auto-connects.
 */

const http     = require('http');
const { chromium } = require('playwright');

const PORT = 7369;

let browser    = null;
let loginState = { status: 'idle' }; // idle | waiting | done | error

// ── HTTP server (no deps beyond Node built-ins) ───────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, code = 200) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // GET /status — health check
  if (req.method === 'GET' && url === '/status') {
    return json(res, { running: true });
  }

  // GET /session — poll for login result
  if (req.method === 'GET' && url === '/session') {
    return json(res, loginState);
  }

  // POST /login — start the Playwright login flow
  if (req.method === 'POST' && url === '/login') {
    try {
      if (browser) { await browser.close().catch(() => {}); browser = null; }
      loginState = { status: 'waiting' };

      browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 600, height: 800 } });
      const page    = await context.newPage();

      // Watch all responses for the DealHub service host redirect
      context.on('response', async (response) => {
        if (loginState.status !== 'waiting') return;
        const respUrl = response.url();
        // Match any *.dealhub.io that is NOT the login page itself
        const m = respUrl.match(/^https?:\/\/((?:[a-z0-9]+\.)?dealhub\.io)/i);
        if (!m || respUrl.includes('login.dealhub.io')) return;

        try {
          const cookies = await context.cookies();
          const dhCookies = cookies.filter(c => c.domain.replace(/^\./, '').endsWith('dealhub.io'));
          const cookieStr = dhCookies.map(c => `${c.name}=${c.value}`).join('; ');

          // Only consider it done once we have real auth tokens
          if (!cookieStr.includes('authToken') && !cookieStr.includes('DEALHUB_PLAY_SESSION')) return;

          const host = m[1];
          loginState = { status: 'done', cookies: cookieStr, host };
          console.log(`\n✓ Logged in — host: ${host}`);
          console.log('  Cookies captured. Closing browser in 2s...\n');
          setTimeout(() => browser?.close().catch(() => {}), 2000);
        } catch { /* context may have closed */ }
      });

      await page.goto('https://login.dealhub.io/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('Login window open — complete sign-in in the browser...');
      return json(res, { ok: true });
    } catch (e) {
      loginState = { status: 'error', error: e.message };
      return json(res, { error: e.message }, 500);
    }
  }

  // POST /reset — reset state so another login can start
  if (req.method === 'POST' && url === '/reset') {
    loginState = { status: 'idle' };
    return json(res, { ok: true });
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nDealHub Auth Server running at http://localhost:${PORT}`);
  console.log('Open https://dealhub-web.vercel.app/dealroom and click "Connect".\n');
});

process.on('SIGINT',  () => { browser?.close().catch(() => {}); process.exit(0); });
process.on('SIGTERM', () => { browser?.close().catch(() => {}); process.exit(0); });
