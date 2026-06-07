'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const zlib = require('zlib');

function loadCookiesFromHeaders(f) {
  try {
    const h = JSON.parse(fs.readFileSync(f,'utf8'));
    return (h.cookie||'').split('; ').map(p=>{const eq=p.indexOf('=');return{name:p.slice(0,eq),value:p.slice(eq+1),domain:'poc.dealhub.io',path:'/',httpOnly:false,secure:true,sameSite:'None'};}).filter(c=>c.name);
  } catch { return []; }
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const cookies = loadCookiesFromHeaders('/tmp/dr_post_headers.json');
  if (cookies.length) await context.addCookies(cookies);

  const page = await context.newPage();

  // Capture htmlTemplate API responses
  const captured = {};
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/htmlTemplate') && !url.includes('content')) {
      try {
        const body = await resp.text();
        captured[url] = { status: resp.status(), body };
        fs.writeFileSync('/tmp/dealroom_inspect.json', JSON.stringify(captured, null, 2));
        console.log('Captured:', url.split('?')[0], resp.status());
      } catch {}
    }
  });

  await page.goto('https://poc.dealhub.io/ws', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Navigate to the DealRoom you want me to study...');
  console.log('I will capture all API calls automatically.');

  // Wait 10 minutes
  await page.waitForTimeout(600000);
  await browser.close();
})().catch(e => { console.error(e.message); });
