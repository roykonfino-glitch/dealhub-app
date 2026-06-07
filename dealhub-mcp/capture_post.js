'use strict';
/**
 * Intercepts the POST /htmlTemplate request made by the DealHub UI
 * and prints the exact headers + body so we can replicate it.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });

  // Load existing cookies
  for (const sf of ['session_eu1.json','session_current.json','session_poc.json']) {
    const fp = path.join(__dirname, sf);
    if (!fs.existsSync(fp)) continue;
    try { await context.addCookies(JSON.parse(fs.readFileSync(fp,'utf8')).cookies||[]); } catch {}
  }

  const page = await context.newPage();

  // Intercept POST /htmlTemplate at the network level
  await page.route('**/htmlTemplate', async route => {
    const req = route.request();
    if (req.method() !== 'POST') { await route.continue(); return; }

    const headers = req.headers();
    let bodyBuf = req.postDataBuffer();

    // Try to decompress if gzipped
    let bodyStr = '';
    if (bodyBuf) {
      try {
        bodyStr = zlib.gunzipSync(bodyBuf).toString('utf8');
        console.log('\n=== DECOMPRESSED BODY (gzip) ===');
      } catch {
        try {
          bodyStr = bodyBuf.toString('utf8');
          console.log('\n=== BODY (raw) ===');
        } catch {
          bodyStr = '<binary, length=' + bodyBuf.length + '>';
        }
      }
    }

    console.log('Headers:', JSON.stringify(headers, null, 2));
    console.log('Body:', bodyStr.slice(0, 3000));
    fs.writeFileSync('/tmp/dr_post_headers.json', JSON.stringify(headers, null, 2));
    fs.writeFileSync('/tmp/dr_post_body.json', bodyStr);
    console.log('\nSaved to /tmp/dr_post_headers.json and /tmp/dr_post_body.json');

    // Let the request through
    await route.continue();
  });

  await page.goto('https://poc.dealhub.io/ws', { waitUntil: 'domcontentloaded' });
  console.log('\n>>> Log in and create a NEW DealRoom template (just click Create/Add new) <<<');
  console.log('>>> The POST body will be captured and printed here <<<\n');

  await new Promise(r => setTimeout(r, 15 * 60 * 1000));
  await browser.close();
})();
