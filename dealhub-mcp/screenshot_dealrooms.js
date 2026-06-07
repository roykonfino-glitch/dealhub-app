const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URLS = [
  'https://go-dealroom.dealhub.io/dealhub#!/hub?dealGUID=VHYElo71PfkyaMqy',
  'https://go-dealroom.dealhub.io/dealhub#!/hub?dealGUID=ghYMSvexsvtpuc4s',
  'https://go-dealroom.dealhub.io/dealhub#!/hub?dealGUID=4gZLUfO7pkFHwrnG',
];

const OUT_DIR = '/tmp/dr_screenshots';
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  // Intercept htmlTemplate API calls to grab JSON data
  const capturedData = {};
  context.on('response', async res => {
    const url = res.url();
    if (url.includes('htmlTemplate') || url.includes('dealroom') || url.includes('hub')) {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await res.text();
          capturedData[url] = body;
          console.log('Captured:', url.slice(0, 80));
        }
      } catch {}
    }
  });

  for (let i = 0; i < URLS.length; i++) {
    const url = URLS[i];
    const label = `dr_${i + 1}`;
    console.log(`\n=== Opening DealRoom ${i + 1} ===`);
    console.log(url);

    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000); // let SPA render

      // Full page screenshot
      const fullPath = path.join(OUT_DIR, `${label}_full.png`);
      await page.screenshot({ path: fullPath, fullPage: true });
      console.log('Full screenshot:', fullPath);

      // Get page title
      const title = await page.title();
      console.log('Title:', title);

      // Find all section elements and screenshot each
      const sections = await page.$$('[class*="section"], [class*="widget"], [data-type]');
      console.log(`Found ${sections.length} section elements`);

      // Also scroll through and take viewport screenshots
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const viewH = 900;
      let scrollPos = 0;
      let shot = 0;
      while (scrollPos < pageHeight) {
        await page.evaluate(y => window.scrollTo(0, y), scrollPos);
        await page.waitForTimeout(500);
        const shotPath = path.join(OUT_DIR, `${label}_scroll_${shot}.png`);
        await page.screenshot({ path: shotPath });
        shot++;
        scrollPos += viewH - 100; // 100px overlap
      }
      console.log(`Took ${shot} scroll screenshots`);

    } catch (e) {
      console.log('Error:', e.message);
      // Screenshot whatever loaded
      try {
        await page.screenshot({ path: path.join(OUT_DIR, `${label}_error.png`), fullPage: true });
      } catch {}
    }

    await page.close();
  }

  // Save all captured JSON
  const jsonPath = path.join(OUT_DIR, 'captured_api.json');
  fs.writeFileSync(jsonPath, JSON.stringify(capturedData, null, 2));
  console.log('\nAPI data saved to:', jsonPath);
  console.log('Screenshots in:', OUT_DIR);

  await browser.close();
})();
