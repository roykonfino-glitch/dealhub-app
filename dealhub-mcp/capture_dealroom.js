const { chromium } = require('playwright');
const fs = require('fs');

const OUT = '/tmp/dealroom_calls.txt';
fs.writeFileSync(OUT, '');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null, acceptDownloads: true });
  const page = await context.newPage();

  // Log all requests + responses
  page.on('request', req => {
    const url = req.url();
    if (url.includes('dealhub.io') || url.includes('localhost')) {
      const line = `REQ  ${req.method()} ${url}\n`;
      fs.appendFileSync(OUT, line);
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('dealhub.io')) return;
    let body = '';
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) body = await res.text();
    } catch {}
    const line = `RES  ${res.status()} ${url}${body ? '\n     ' + body.slice(0, 500) : ''}\n`;
    fs.appendFileSync(OUT, line);
    process.stdout.write(line);
  });

  // Try to load existing session
  const sessionFiles = ['session_eu1.json', 'session_current.json'];
  const __dirname2 = '/Users/roykonfino/Desktop/dealhub-app/dealhub-mcp';
  let loaded = false;
  for (const sf of sessionFiles) {
    const fp = `${__dirname2}/${sf}`;
    if (fs.existsSync(fp)) {
      try {
        const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const host = state._host || 'service-eu1.dealhub.io';
        await context.addCookies(state.cookies || []);
        await page.goto(`https://${host}/ws`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        loaded = true;
        console.log(`Loaded session from ${sf} → https://${host}/ws`);
        break;
      } catch(e) { console.log('Session load failed:', e.message); }
    }
  }
  if (!loaded) {
    await page.goto('https://service-eu1.dealhub.io/ws', { waitUntil: 'domcontentloaded' });
    console.log('No session — please log in manually.');
  }

  console.log('\n>>> Browser ready. Go ahead and create a DealRoom — every API call is being logged. <<<\n');
  console.log('Calls are also saved to:', OUT);

  // Keep browser open for 30 minutes
  await new Promise(r => setTimeout(r, 30 * 60 * 1000));
  await browser.close();
})();
