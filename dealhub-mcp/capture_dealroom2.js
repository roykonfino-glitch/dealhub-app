'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT     = '/tmp/dealroom_full.txt';
const SESSION = path.join(__dirname, 'session_poc.json');
fs.writeFileSync(OUT, '');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null, acceptDownloads: true });
  const page = await context.newPage();

  // Save session whenever we hit poc.dealhub.io successfully
  let sessionSaved = false;
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('poc.dealhub.io') && !url.includes('dealhub.io')) return;
    if (res.status() === 401) return;

    // Save session once
    if (!sessionSaved && url.includes('poc.dealhub.io') && res.status() === 200) {
      try {
        const state = await context.storageState();
        fs.writeFileSync(SESSION, JSON.stringify({ ...state, _host: 'poc.dealhub.io' }, null, 2));
        sessionSaved = true;
        console.log('Session saved to session_poc.json');
      } catch {}
    }

    // Log request
    const req = res.request();
    let reqBody = '';
    try {
      if (['POST','PUT','PATCH'].includes(req.method())) {
        reqBody = req.postData() || '';
      }
    } catch {}

    // Log response
    let resBody = '';
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) resBody = await res.text();
    } catch {}

    const line = [
      `\n=== ${req.method()} ${url} → ${res.status()} ===`,
      reqBody  ? `REQ_BODY: ${reqBody}` : '',
      resBody  ? `RES_BODY: ${resBody}` : '',
    ].filter(Boolean).join('\n') + '\n';

    fs.appendFileSync(OUT, line);

    // Print to stdout for monitoring (truncated)
    if (url.includes('/htmlTemplate') || url.includes('/dealBox') || url.includes('/htmlapp')) {
      console.log(`${req.method()} ${url.split('poc.dealhub.io')[1]} → ${res.status()}`);
      if (reqBody) console.log('  REQ:', reqBody.slice(0, 300));
      if (resBody) console.log('  RES:', resBody.slice(0, 300));
    }
  });

  // Try existing sessions
  const tryFiles = ['session_eu1.json', 'session_current.json'];
  let loaded = false;
  for (const sf of tryFiles) {
    const fp = path.join(__dirname, sf);
    if (!fs.existsSync(fp)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
      await context.addCookies(state.cookies || []);
      loaded = true;
      break;
    } catch {}
  }

  await page.goto('https://poc.dealhub.io/ws', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('\n>>> Browser ready on poc.dealhub.io <<<');
  console.log('>>> All /htmlTemplate and /dealBox calls will be fully logged to:', OUT);
  console.log('>>> Please log in if needed, then open/create a DealRoom\n');

  await new Promise(r => setTimeout(r, 30 * 60 * 1000));
  await browser.close();
})();
