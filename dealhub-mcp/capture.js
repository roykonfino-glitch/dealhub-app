#!/usr/bin/env node
/**
 * DealHub network capture — filters poc.dealhub.io API calls only
 * Usage: node capture.js <dealhub-url> [output-file]
 *
 * Opens a headed Chromium window. Use DealHub normally — every XHR/fetch
 * to poc.dealhub.io is captured. Press Ctrl+C to stop; traffic is written
 * to the output file (default: captured_requests.json).
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const TARGET_URL  = process.argv[2];
const OUTPUT_FILE   = process.argv[3] || 'captured_requests.json';
const SESSION_FILE  = path.join(__dirname, 'session_state.json');

if (!TARGET_URL) {
  console.error('Usage: node capture.js <dealhub-url> [output-file]');
  process.exit(1);
}

// Hosts to skip entirely (analytics, telemetry, CDN assets)
const SKIP_HOSTS = [
  'fullstory.com', 'rs.fullstory.com', 'edge.fullstory.com',
  'sentry.io', 'google-analytics.com', 'googlevideo.com',
  'googleapis.com', 'stonly.com', 'api.stonly.com',
  'azureedge.net', 'googlevideo.com',
];

const captured = [];

function save() {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2));
}

function saveSession(cookies) {
  const state = {
    cookies: cookies.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   '.dealhub.io',
      path:     '/',
      expires:  -1,
      httpOnly: false,
      secure:   true,
      sameSite: 'None',
    })),
    origins: [],
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: null,
  });
  const page = await context.newPage();

  await page.route('**/*', async (route, request) => {
    const url  = request.url();
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

    // Skip analytics/CDN
    if (SKIP_HOSTS.some(h => host.includes(h))) {
      await route.continue();
      return;
    }

    const resourceType = request.resourceType();
    const isApiCall =
      resourceType === 'fetch' ||
      resourceType === 'xhr' ||
      (resourceType === 'document' && request.method() !== 'GET');

    // Only capture API calls to DealHub
    if (!isApiCall || !host.includes('dealhub.io')) {
      await route.continue();
      return;
    }

    const entry = {
      id:              captured.length + 1,
      timestamp:       new Date().toISOString(),
      method:          request.method(),
      url,
      resourceType,
      requestHeaders:  request.headers(),
      requestBody:     null,
      status:          null,
      responseHeaders: null,
      responseBody:    null,
    };

    try {
      const buf = request.postDataBuffer();
      if (buf && buf.length > 0) {
        // Try JSON first; if binary (gzip magic bytes 1f 8b), store as base64
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          entry.requestBody = buf.toString('base64');
          entry.requestEncoding = 'base64-gzip';
        } else {
          try { entry.requestBody = JSON.parse(buf.toString('utf8')); }
          catch { entry.requestBody = buf.toString('utf8'); }
        }
      }
    } catch {}

    try {
      const response = await route.fetch();
      entry.status          = response.status();
      entry.responseHeaders = response.headers();
      const buf = await response.body();

      // Handle gzip responses — store as base64 so bytes are preserved
      const ct = (entry.responseHeaders['content-encoding'] || '').toLowerCase();
      if (ct.includes('gzip')) {
        entry.responseBody    = buf.toString('base64');
        entry.responseEncoding = 'base64-gzip';
      } else {
        try { entry.responseBody = JSON.parse(buf.toString()); }
        catch { entry.responseBody = buf.toString().slice(0, 8000); }
      }

      await route.fulfill({ response });
    } catch {
      await route.continue();
    }

    captured.push(entry);
    console.log(`[${entry.id}] ${entry.method} ${entry.status ?? '?'} ${url.replace('https://poc.dealhub.io', '')}`);
    save();

    // Auto-update session_state.json whenever a successful DealHub request is captured
    if (host.includes('poc.dealhub.io') && entry.status === 200) {
      try {
        const cookies = await context.cookies('https://poc.dealhub.io');
        if (cookies.some(c => c.name === 'DEALHUB_PLAY_SESSION')) saveSession(cookies);
      } catch {}
    }
  });

  console.log(`\nOpening: ${TARGET_URL}`);
  console.log(`Capturing DealHub API calls → ${OUTPUT_FILE}`);
  console.log('Use the browser normally. Press Ctrl+C when done.\n');

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  await new Promise(() => {});
})().catch(err => {
  console.error(err);
  process.exit(1);
});

process.on('SIGINT', () => {
  save();
  console.log(`\nCaptured ${captured.length} requests → ${OUTPUT_FILE}`);
  process.exit(0);
});
