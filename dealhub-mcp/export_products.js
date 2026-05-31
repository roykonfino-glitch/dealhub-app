#!/usr/bin/env node
/**
 * DealHub Product Catalog Export
 *
 * Exports a version's full product catalog (Products, Assignments, Pricing Rules,
 * BundleInfo, ProductsConditionalNames) to an Excel file — same format as the
 * manual "Export to Excel" button in the DealHub admin UI.
 *
 * Usage:
 *   node export_products.js <version-name> [base-url]
 *
 * Examples:
 *   node export_products.js V64
 *   node export_products.js V62_5 https://service-eu1.dealhub.io
 *
 * Session is read from session_eu1.json (or session_current.json as fallback).
 * Run tag_impact_analysis.js or export_playbook.js first to capture a session.
 *
 * How it works (discovered by intercepting browser traffic):
 *   1. GET /masterdata/exportProductToken?versionGUID={guid}  → short-lived token
 *   2. GET /masterdata/exportProduct?token={token}            → Excel binary
 */

'use strict';

const { request: pwReq } = require('playwright');
const { chromium }       = require('playwright');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const VERSION_NAME = process.argv[2];
if (!VERSION_NAME) {
  console.error('Usage: node export_products.js <version-name> [base-url]');
  process.exit(1);
}

const SESSION_FILES = ['session_eu1.json', 'session_current.json', 'session_us2.json'];
const SESSION_FILE  = SESSION_FILES.find(f => fs.existsSync(path.join(__dirname, f)));

let BASE_URL = process.argv[3];
if (!BASE_URL && SESSION_FILE) {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, SESSION_FILE), 'utf8'));
  if (s._host) BASE_URL = `https://${s._host}`;
}
if (!BASE_URL) BASE_URL = 'https://service-eu1.dealhub.io';
BASE_URL = BASE_URL.replace(/\/$/, '');

// ── Session ───────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (!SESSION_FILE) {
    await captureSession();
    return;
  }
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, SESSION_FILE), 'utf8'));
  try {
    const ctx = await pwReq.newContext({
      baseURL: BASE_URL, storageState: raw,
      extraHTTPHeaders: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    const res = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
    if (res.ok()) { await ctx.dispose(); console.log('Session valid'); return; }
    await ctx.dispose();
  } catch {}
  await captureSession();
}

async function captureSession() {
  const outFile = path.join(__dirname, 'session_eu1.json');
  console.log(`\nOpening browser for login → ${BASE_URL}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page    = await context.newPage();
  let saved = false;
  page.on('response', async (res) => {
    if (saved || res.status() !== 200) return;
    const url = res.url();
    if (!url.includes('dealhub.io')) return;
    if (!/\/(versions|masterdata|playbooks?)/.test(url)) return;
    try {
      const state = await context.storageState();
      const host  = new URL(url).hostname;
      fs.writeFileSync(outFile, JSON.stringify({ ...state, _host: host }, null, 2));
      saved = true;
      console.log(`Session captured for: ${host}`);
    } catch {}
  });
  await page.goto(`${BASE_URL}/ws`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(resolve => {
    const iv = setInterval(() => { if (saved) { clearInterval(iv); resolve(); } }, 500);
    setTimeout(() => { clearInterval(iv); resolve(); }, 300000);
  });
  await browser.close();
}

// ── API ───────────────────────────────────────────────────────────────────────

async function makeCtx() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, SESSION_FILE || 'session_eu1.json'), 'utf8'));
  return pwReq.newContext({
    baseURL: BASE_URL, storageState: raw,
    extraHTTPHeaders: { 'User-Agent': 'Mozilla/5.0' },
  });
}

async function findVersionGuid(ctx, name) {
  const res  = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
  const data = await res.json();
  const list = Array.isArray(data) ? data : Array.isArray(data.versions) ? data.versions : [];
  const lo   = name.toLowerCase();
  const v    = list.find(v => (v.name||'').toLowerCase() === lo ||
                               (v.name||'').toLowerCase().includes(lo));
  return v ? { guid: v.guid || v.versionGUID, name: v.name } : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  await ensureSession();

  const ctx = await makeCtx();

  console.log(`\nFinding version "${VERSION_NAME}"...`);
  const version = await findVersionGuid(ctx, VERSION_NAME);
  if (!version) {
    console.error(`Version "${VERSION_NAME}" not found.`);
    process.exit(1);
  }
  console.log(`Found: ${version.name} (${version.guid})`);

  // Step 1 — get export token
  const tokenRes = await ctx.get(`/masterdata/exportProductToken?versionGUID=${version.guid}`);
  if (!tokenRes.ok()) {
    console.error('Failed to get export token:', tokenRes.status());
    process.exit(1);
  }
  const token = (await tokenRes.text()).replace(/"/g, '').trim();
  console.log(`Export token: ${token}`);

  // Step 2 — download Excel
  const dlRes = await ctx.get(`/masterdata/exportProduct?token=${token}`, {
    headers: { Accept: 'application/octet-stream' },
  });
  if (!dlRes.ok()) {
    console.error('Download failed:', dlRes.status());
    process.exit(1);
  }

  const buf  = await dlRes.body();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' +
               new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const out  = path.join(os.homedir(), 'Downloads', `Products-${version.name}-${date}.xlsx`);
  fs.writeFileSync(out, buf);

  console.log(`\nExported ${buf.length.toLocaleString()} bytes → ${out}`);

  await ctx.dispose();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
