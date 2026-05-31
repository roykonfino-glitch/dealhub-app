#!/usr/bin/env node
/**
 * DealHub Account Quote Analysis
 *
 * Usage:
 *   node analyze_account.js --token <bearer-token> --url <https://tenant.dealhub.io>
 *                                                          # save credentials for a tenant
 *   node analyze_account.js --list                        # list accounts in recent quotes
 *   node analyze_account.js "<account name>"              # analyse (partial match)
 *   node analyze_account.js "<account name>" --deep       # include line items (slower)
 *
 * Multiple tenants: use --url to switch between them. Credentials are stored per host.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CREDS_FILE = path.join(__dirname, '.account_creds.json');
const PAGE       = 10;
const MAX_PAGES  = 30;
const TARGET     = 50;

// ── Credential store (keyed by hostname) ─────────────────────────────────────

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return {}; }
}

function saveCred(host, token) {
  const all = loadCreds();
  all[host] = token;
  fs.writeFileSync(CREDS_FILE, JSON.stringify(all, null, 2));
}

function resolveCred(urlArg) {
  const all = loadCreds();
  if (urlArg) {
    const host = new URL(urlArg.includes('://') ? urlArg : 'https://' + urlArg).hostname;
    if (!all[host]) { console.error(`No token saved for ${host}. Run with --token <token> --url <url>`); process.exit(1); }
    return { api: 'https://' + host, token: all[host] };
  }
  // Fall back to legacy .account_token
  const legacyFile = path.join(__dirname, '.account_token');
  if (fs.existsSync(legacyFile)) {
    const token = fs.readFileSync(legacyFile, 'utf8').trim();
    return { api: 'https://app.dealhub.io', token };
  }
  const hosts = Object.keys(all);
  if (hosts.length === 1) return { api: 'https://' + hosts[0], token: all[hosts[0]] };
  if (hosts.length > 1) {
    console.error('Multiple tenants saved. Specify one with --url <url>:\n  ' + hosts.join('\n  '));
    process.exit(1);
  }
  console.error('No credentials saved. Run: node analyze_account.js --token <token> --url <https://tenant.dealhub.io>');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(api, urlPath, token) {
  return new Promise((resolve) => {
    const req = https.get(`${api}${urlPath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { console.error('\nAuth failed — check token'); process.exit(1); }
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyze(quotes) {
  if (!quotes.length) return null;
  const sizes = [], statuses = {}, currencies = {}, products = {};
  let wins = 0;

  for (const q of quotes) {
    const st = q.status || '';
    if (st) statuses[st] = (statuses[st] || 0) + 1;
    if (/won/i.test(st)) wins++;

    const s = q.summary || {};
    if (s.currency) currencies[s.currency] = (currencies[s.currency] || 0) + 1;
    const price = s.total_net_price ?? s.total_list_price;
    if (typeof price === 'number' && price > 0) sizes.push(price);

    for (const li of (q.line_items || [])) {
      const name = li.product_name || li.name || '';
      if (name) products[name] = (products[name] || 0) + 1;
    }
  }

  return { count: quotes.length, sizes, statuses, currencies, products, wins };
}

function fmt(n) {
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function topN(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function printReport(name, r) {
  if (!r) { console.log('No quotes found.'); return; }
  const bar = '─'.repeat(52);
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  ${name}`);
  console.log(`  ${r.count} quotes analysed`);
  console.log(`${'═'.repeat(52)}`);

  console.log(`\n  STATUS BREAKDOWN`);
  console.log(`  ${bar}`);
  topN(r.statuses, 8).forEach(([k, v]) =>
    console.log(`  ${(k + ' ').padEnd(20, '.')} ${v}  (${Math.round(v/r.count*100)}%)`));

  if (r.sizes.length) {
    const sorted = [...r.sizes].sort((a, b) => a - b);
    const avg    = r.sizes.reduce((a, b) => a + b, 0) / r.sizes.length;
    const med    = sorted[Math.floor(sorted.length / 2)];
    const cur    = topN(r.currencies, 1)[0]?.[0] || '';
    console.log(`\n  DEAL SIZE — ${cur} (${r.sizes.length} quotes with value)`);
    console.log(`  ${bar}`);
    console.log(`  Min:    ${fmt(sorted[0])}`);
    console.log(`  Avg:    ${fmt(avg)}`);
    console.log(`  Median: ${fmt(med)}`);
    console.log(`  Max:    ${fmt(sorted[sorted.length - 1])}`);
  }

  if (Object.keys(r.products).length) {
    console.log(`\n  TOP PRODUCTS`);
    console.log(`  ${bar}`);
    topN(r.products, 10).forEach(([k, v]) => console.log(`  • ${k} (×${v})`));
  }

  console.log(`\n${'═'.repeat(52)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);

  const tokenIdx = args.indexOf('--token');
  const urlIdx   = args.indexOf('--url');
  const urlArg   = urlIdx !== -1 ? args[urlIdx + 1] : null;

  if (tokenIdx !== -1) {
    const token = args[tokenIdx + 1];
    if (!token || token.startsWith('--')) { console.error('Usage: --token <token> --url <url>'); process.exit(1); }
    if (!urlArg) { console.error('--url <https://tenant.dealhub.io> is required when saving a token'); process.exit(1); }
    const host = new URL(urlArg.includes('://') ? urlArg : 'https://' + urlArg).hostname;
    saveCred(host, token);
    console.log(`Token saved for ${host}`);
    return;
  }

  const { api, token } = resolveCred(urlArg);
  const deep  = args.includes('--deep');
  const skipIndices = new Set([urlIdx + 1, ...(tokenIdx !== -1 ? [tokenIdx + 1] : [])]);
  const query = args.find((a, i) => !a.startsWith('--') && !skipIndices.has(i));

  if (!query) {
    console.log(`Tenant: ${api}`);
    console.log('Loading recent quotes to list accounts...');
    const all = [];
    for (let page = 0; page < 2; page++) {
      const data = await get(api, `/api/v2/quotes?limit=${PAGE}&offset=${page * PAGE}&feature=info`, token);
      if (!data?.quotes?.length) break;
      all.push(...data.quotes);
      if (!data.info?.more_results_matching_the_request) break;
    }
    const seen = {};
    all.forEach(q => {
      const n = q.info?.account_name;
      if (n && !seen[n]) seen[n] = 0;
      if (n) seen[n]++;
    });
    console.log(`\nAccounts in recent ${all.length} quotes (use the name to analyse):\n`);
    Object.entries(seen).sort((a, b) => b[1] - a[1]).forEach(([name, d]) =>
      console.log(`  ${d.toString().padStart(3)}  ${name}`));
    console.log('\nUsage: node analyze_account.js "<name>"');
    return;
  }

  const features = deep ? ['info', 'summary', 'line_items'] : ['info', 'summary'];
  console.log(`Tenant: ${api}`);
  console.log(`Fetching quotes until ${TARGET} found for "${query}"...`);

  const matched = [];
  const lo = query.toLowerCase();
  for (let page = 0; page < MAX_PAGES && matched.length < TARGET; page++) {
    const offset = page * PAGE;
    const feat   = features.map(f => `feature=${f}`).join('&');
    const data   = await get(api, `/api/v2/quotes?limit=${PAGE}&offset=${offset}&${feat}`, token);
    if (!data?.quotes?.length) break;
    for (const q of data.quotes) {
      const name = (q.info?.account_name || '').toLowerCase();
      const cid  = (q.info?.customer_id || '').toLowerCase();
      if (name.includes(lo) || cid === lo) matched.push(q);
    }
    process.stdout.write(`  Scanned ${(page + 1) * PAGE} quotes, found ${matched.length} for account...\r`);
    if (!data.info?.more_results_matching_the_request) break;
  }
  process.stdout.write('\n');

  if (!matched.length) {
    console.log(`No quotes found matching "${query}". Run with no args to list accounts.`);
    return;
  }

  const acctName = matched[0].info?.account_name || query;
  console.log(`Found ${matched.length} quotes for: ${acctName}`);
  printReport(acctName, analyze(matched));
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
