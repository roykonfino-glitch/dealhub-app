#!/usr/bin/env node
/**
 * Opens DealHub in a headed browser with the saved session.
 * Intercepts all POST /outputData/save requests and logs the exact payload.
 * Open the document editor and click Save manually.
 * Ctrl+C to stop.
 */

const { chromium } = require('playwright');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const BASE_URL     = 'https://poc.dealhub.io';
const SESSION_FILE = path.join(__dirname, 'session_state.json');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({
    storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
    ignoreHTTPSErrors: true,
    viewport: null,
  });

  const page = await context.newPage();

  // Intercept all requests, log POSTs to outputData/save
  await page.route('**/*', async (route, request) => {
    const url = request.url();
    if (url.includes('/outputData/save') && request.method() === 'POST') {
      console.log('\n=== INTERCEPTED /outputData/save ===');
      console.log('Headers:', JSON.stringify(request.headers(), null, 2));

      const buf = request.postDataBuffer();
      if (buf) {
        const ct = (request.headers()['content-encoding'] || '').toLowerCase();
        let body;
        if (ct.includes('gzip') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
          try {
            body = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
            console.log('Body (gzip decoded, keys):', Object.keys(body));
            console.log('outputData type:', typeof body.outputData);
            fs.writeFileSync('/tmp/intercepted_save_payload.json', JSON.stringify(body, null, 2));
            console.log('Full payload saved to /tmp/intercepted_save_payload.json');
          } catch (e) {
            console.log('Gzip decode failed:', e.message);
            fs.writeFileSync('/tmp/intercepted_save_raw.bin', buf);
            console.log('Raw binary saved to /tmp/intercepted_save_raw.bin');
          }
        } else {
          try {
            body = JSON.parse(buf.toString('utf8'));
            console.log('Body (JSON, keys):', Object.keys(body));
            fs.writeFileSync('/tmp/intercepted_save_payload.json', JSON.stringify(body, null, 2));
          } catch {
            console.log('Body (raw):', buf.toString('utf8').slice(0, 200));
          }
        }
      }
    }

    const response = await route.fetch();
    if (url.includes('/outputData/save')) {
      const text = await response.text();
      console.log('Save response:', response.status(), text.slice(0, 200));
    }
    await route.fulfill({ response });
  });

  console.log('\nOpening DealHub...');
  console.log('Navigate to a document and click SAVE.');
  console.log('The exact payload will be logged here.\n');

  await page.goto(BASE_URL + '/outputDocumentList', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await new Promise(() => {});
})().catch(e => { console.error(e); process.exit(1); });

process.on('SIGINT', () => {
  console.log('\nDone.');
  process.exit(0);
});
