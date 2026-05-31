'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const LOG = '/tmp/dealhub_all_calls.txt';
fs.writeFileSync(LOG, '--- capture started ---\n');

(async () => {
  const raw = JSON.parse(fs.readFileSync('session_eu1.json', 'utf8'));
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: raw,
    viewport: null,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // Capture ALL responses (any domain, any type)
  page.on('response', async (res) => {
    const url = res.url();
    if (url.startsWith('https://www.google') || url.includes('stonly') || url.includes('Incapsula')) return;
    const method = res.request().method();
    const ct     = res.headers()['content-type'] || '';
    const disp   = res.headers()['content-disposition'] || '';
    const line   = `${res.status()} ${method} ${url}${disp ? '  [DOWNLOAD: '+disp+']' : ''}  (${ct.split(';')[0]})`;
    fs.appendFileSync(LOG, line + '\n');
  });

  page.on('download', async (dl) => {
    fs.appendFileSync(LOG, `DOWNLOAD: ${dl.url()}  file: ${dl.suggestedFilename()}\n`);
  });

  await page.goto('https://service-eu1.dealhub.io/ws#/versions', { timeout: 30000 });
  console.log('Browser ready → ' + LOG);
  await new Promise(r => setTimeout(r, 900000));
  await browser.close();
})();
