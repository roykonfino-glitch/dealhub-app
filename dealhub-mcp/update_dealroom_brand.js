'use strict';
const { chromium } = require('playwright');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');
const { buildDrData } = require('./dealroom_builder');

const GUID       = 'SZunSzxV8nc5ZvbL';
const HOST       = 'poc.dealhub.io';
const BASE       = `https://${HOST}`;

const LOGO_URL   = 'https://insiderone.com/assets/media/2025/12/Logo.png';
const HERO_URL   = 'https://insiderone.com/assets/media/2025/12/hp-hero.webp';
const PRIMARY    = '#E84B1C';
const BG_DARK    = '#0D0E1A';

function loadCookiesFromHeaders(headerFile) {
  try {
    const h = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
    return (h.cookie || '').split('; ').map(pair => {
      const eq = pair.indexOf('=');
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1),
               domain: HOST, path: '/', httpOnly: false, secure: true, sameSite: 'None' };
    }).filter(c => c.name);
  } catch { return []; }
}

async function dhPost(page, urlPath, body) {
  const gzipBuf = zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
  const res = await page.request.post(`${BASE}${urlPath}`, {
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Accept': 'application/json, text/plain, */*' },
    data: gzipBuf, timeout: 15000,
  });
  const txt = await res.text();
  if (!res.ok()) { console.warn(`WARN ${urlPath} → ${res.status()}: ${txt.slice(0, 200)}`); return null; }
  try { return JSON.parse(txt); } catch { return { ok: true }; }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });

  const capturedCookies = loadCookiesFromHeaders('/tmp/dr_post_headers.json');
  if (capturedCookies.length) {
    await context.addCookies(capturedCookies);
  } else {
    for (const sf of ['session_poc.json', 'session_eu1.json', 'session_current.json']) {
      const fp = path.join(__dirname, sf);
      if (!fs.existsSync(fp)) continue;
      try { await context.addCookies(JSON.parse(fs.readFileSync(fp, 'utf8')).cookies || []); } catch {}
    }
  }

  const page = await context.newPage();

  let authed = false;
  for (let i = 0; i < 3; i++) {
    const r = await page.request.get(`${BASE}/versions/admin?isArchived=false&versionsScreen=true`, { headers: { Accept: 'application/json' } });
    if (r.ok()) { authed = true; break; }
    if (i === 0) console.log('Session auth failed, retrying...');
    await page.waitForTimeout(2000);
  }
  if (!authed) { console.error('Auth failed — session expired, re-capture cookies'); await browser.close(); process.exit(1); }
  console.log('Authenticated.');

  // Fetch current template to preserve name / metadata
  const r = await page.request.get(`${BASE}/htmlTemplate?htmlGUID=${GUID}`, { headers: { Accept: 'application/json' } });
  const tplData = await r.json();
  const tpl = tplData.htmlTemplate;
  console.log('Fetched template:', tpl.name);

  // Build rich DealRoom data from brand
  const drData = buildDrData({
    logoUrl:     LOGO_URL,
    heroUrl:     HERO_URL,
    primary:     PRIMARY,
    bgDark:      BG_DARK,
    companyName: 'InsiderOne',
  });

  console.log('Saving updated content (' + drData.sections.length + ' sections)...');
  const result = await dhPost(page, '/htmlTemplate/content', {
    guid: GUID,
    data: JSON.stringify(drData),
    changeLogRecords: null,
  });

  if (result) {
    console.log('\nDealRoom updated successfully!');
    console.log('  Sections: header, overview, pricing, resources, signature');
    console.log('  Logo:    ', LOGO_URL);
    console.log('  Hero:    ', HERO_URL);
    console.log('  Color:   ', PRIMARY);
    console.log('\nOpen: https://poc.dealhub.io/ws#/versions/hAU7WSGsAS9ZjmjH/output-documents');
  }

  await browser.close();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
