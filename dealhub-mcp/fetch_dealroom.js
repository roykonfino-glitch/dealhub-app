'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DR_GUID = '2f88Ed4cf4079b42';
const HOST = 'go-dealroom.dealhub.io';
const BASE = `https://${HOST}`;

function loadCookies(headerFile, domain) {
  try {
    const h = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
    return (h.cookie || '').split('; ').map(p => {
      const eq = p.indexOf('=');
      return { name: p.slice(0, eq), value: p.slice(eq + 1), domain, path: '/', httpOnly: false, secure: true, sameSite: 'None' };
    }).filter(c => c.name);
  } catch { return []; }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Load cookies for both domains
  const pocCookies = loadCookies('/tmp/dr_post_headers.json', 'poc.dealhub.io');
  const drCookies  = pocCookies.map(c => ({ ...c, domain: 'go-dealroom.dealhub.io' }));
  await context.addCookies([...pocCookies, ...drCookies]);

  const page = await context.newPage();

  const r = await page.request.get(`${BASE}/htmlTemplate?htmlGUID=${DR_GUID}`, {
    headers: { Accept: 'application/json' },
  });
  console.log('Status:', r.status());
  const body = await r.text();
  fs.writeFileSync('/tmp/iconnections_full.json', body);
  console.log('Saved', body.length, 'bytes to /tmp/iconnections_full.json');

  if (r.ok()) {
    const tpl = JSON.parse(body).htmlTemplate;
    const d = JSON.parse(tpl.data || '{}');
    fs.writeFileSync('/tmp/iconnections_parsed.json', JSON.stringify(d, null, 2));
    console.log('\nSections:', d.sections.length);
    d.sections.forEach((s, i) => console.log(i, s.type, '"' + (s.title || '') + '"'));
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
