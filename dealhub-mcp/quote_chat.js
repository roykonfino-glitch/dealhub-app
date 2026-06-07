#!/usr/bin/env node
/**
 * DealHub Quote Chat
 *
 * Usage:
 *   node quote_chat.js --latest                          # fetch & analyse the 50 most recent quotes
 *   node quote_chat.js --won                             # fetch 100 quotes, show latest 20 WON with summary
 *   node quote_chat.js "account name"                    # search by account name
 *   node quote_chat.js --account-id <id>                 # search by DealHub or Salesforce account ID
 *   node quote_chat.js --id <dealhub_quote_id>           # fetch a specific quote by ID
 *   node quote_chat.js --list                            # list recent accounts
 *   node quote_chat.js "name" --ask "question"           # custom question
 *
 * Uses EU1 by default. Override with --url https://other-tenant.dealhub.io
 */

'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');

const CREDS_FILE    = path.join(__dirname, '.account_creds.json');
const LEGACY_TOKEN  = path.join(__dirname, '.account_token');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  || (() => {
    try { return require('fs').readFileSync(path.join(__dirname, '../dealhub-web/.env.local'), 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim(); } catch { return null; }
  })();

// ── Credentials ───────────────────────────────────────────────────────────────

function resolveCred(urlArg) {
  const all = (() => { try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return {}; } })();
  if (urlArg) {
    const host = new URL(urlArg.includes('://') ? urlArg : 'https://' + urlArg).hostname;
    if (all[host]) return { api: 'https://' + host, token: all[host] };
  }
  // Default to EU1 if saved
  if (all['service-eu1.dealhub.io']) return { api: 'https://service-eu1.dealhub.io', token: all['service-eu1.dealhub.io'] };
  // Legacy fallback
  if (fs.existsSync(LEGACY_TOKEN)) return { api: 'https://app.dealhub.io', token: fs.readFileSync(LEGACY_TOKEN, 'utf8').trim() };
  const hosts = Object.keys(all);
  if (hosts.length === 1) return { api: 'https://' + hosts[0], token: all[hosts[0]] };
  console.error('No credentials. Run: node analyze_account.js --token <token> --url <url>');
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function dhGet(api, urlPath, token) {
  return new Promise(resolve => {
    const req = https.get(api + urlPath, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ ok: false }); }
      });
    });
    req.setTimeout(25000, () => { req.destroy(); resolve({ ok: false, timeout: true }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

async function dhGetRetry(api, urlPath, token, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const r = await dhGet(api, urlPath, token);
    if (r.ok) return r.data;
    if (i < retries) process.stdout.write('[retry] ');
  }
  return null;
}

// ── DealHub fetchers ──────────────────────────────────────────────────────────

// ID detection: DealHub (16-char), Salesforce (15 or 18-char alphanumeric)
const isAccountId = s => /^[A-Za-z0-9]{15,18}$/.test(s);

async function searchByAccount(api, token, query, maxPages = 60, byAccountId = false) {
  const lo   = query.toLowerCase();
  const byId = byAccountId || isAccountId(query);
  const matched = [];
  let pagesAfterMatch = 0;
  const STOP_AFTER = byId ? 60 : 2; // scan all pages when searching by ID

  process.stdout.write(`Searching "${query}" across quotes`);
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 10;
    const data = await dhGetRetry(api, `/api/v2/quotes?limit=10&offset=${offset}&feature=info`, token);
    if (!data) { process.stdout.write('!'); pagesAfterMatch++; continue; }
    if (!data.quotes?.length) { process.stdout.write('\n'); break; }

    const prevLen = matched.length;
    for (const q of data.quotes) {
      const name = (q.info?.account_name || '').toLowerCase();
      const cid  = q.info?.customer_id || '';
      const ecid = q.info?.external_customer_id || '';
      const hit  = byId
        ? cid === query || ecid === query || cid.toLowerCase() === lo || ecid.toLowerCase() === lo
        : name.includes(lo) || cid.toLowerCase() === lo;
      if (hit) matched.push(q);
    }

    if (matched.length > prevLen) { process.stdout.write('+'); pagesAfterMatch = 0; }
    else { process.stdout.write('.'); if (matched.length > 0) pagesAfterMatch++; }

    if (!data.info?.more_results_matching_the_request) { process.stdout.write('\n'); break; }
    if (matched.length >= 50) { process.stdout.write('\n'); break; }
    if (matched.length > 0 && pagesAfterMatch >= STOP_AFTER) { process.stdout.write('\n'); break; }
  }
  return matched;
}

async function fetchQuoteDetail(api, token, quoteId) {
  return dhGetRetry(api, `/api/v2/quote/${quoteId}?feature=all`, token);
}

async function listAccounts(api, token) {
  const seen = {};
  for (let page = 0; page < 3; page++) {
    const data = await dhGetRetry(api, `/api/v2/quotes?limit=10&offset=${page * 10}&feature=info`, token);
    if (!data?.quotes?.length) break;
    data.quotes.forEach(q => {
      const n = q.info?.account_name;
      if (n) seen[n] = (seen[n] || 0) + 1;
    });
    if (!data.info?.more_results_matching_the_request) break;
  }
  return seen;
}

// ── Claude API ────────────────────────────────────────────────────────────────

function claudeRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(payload);
    req.end();
  });
}

async function analyzeWithClaude(quoteData, userQuestion, accountName) {
  if (!ANTHROPIC_KEY) {
    console.error('\nNo ANTHROPIC_API_KEY found. Set it as an env var or check .env.local');
    process.exit(1);
  }

  // Compress quote data to fit context
  const quotesSummary = quoteData.map((q, i) => {
    const info = q.info || {};
    const summary = q.summary || {};
    const answers = Array.isArray(q.answers) ? q.answers.slice(0, 30).map(a => `  ${a.question}: ${a.answer}`).join('\n') : '';
    const lineItems = Array.isArray(q.line_items) ? q.line_items.slice(0, 10).map(li => `  - ${li.product_name || li.name} qty:${li.quantity} price:${li.price}`).join('\n') : '';
    return [
      `--- Quote ${i + 1} (${q.dealhub_quote_id || q.system_id || 'unknown'}) ---`,
      `Account: ${info.account_name || 'N/A'}`,
      `Status: ${q.status || 'N/A'}`,
      `Created: ${info.created_at || 'N/A'}  Updated: ${info.updated_at || 'N/A'}`,
      `Opportunity: ${info.external_opportunity_id || 'N/A'}`,
      summary.total_net_price ? `Total: ${summary.currency || ''} ${summary.total_net_price}` : '',
      answers ? `Answers:\n${answers}` : '',
      lineItems ? `Line Items:\n${lineItems}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const systemPrompt = `You are a DealHub CPQ expert analyzing quote data for sales intelligence.
Be concise and structured. Lead with the most important insights.
Format numbers clearly. Flag anything unusual or notable.
Account being analysed: ${accountName}`;

  const userMsg = userQuestion
    ? `${userQuestion}\n\nQuote data:\n${quotesSummary}`
    : `Analyse these ${quoteData.length} quote(s) and give me:\n1. Key deal stats (size, status breakdown)\n2. What they're buying (products/line items)\n3. Any notable patterns or flags\n4. Quick summary\n\nQuote data:\n${quotesSummary}`;

  process.stdout.write('\nAsking Claude...\n\n');

  const response = await claudeRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }],
  });

  return response.content?.[0]?.text || 'No response from Claude.';
}

// ── Interactive loop ──────────────────────────────────────────────────────────

async function interactiveLoop(api, token, quoteData, accountName) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  while (true) {
    const q = await ask('\nYou: ');
    if (!q.trim() || /^(exit|quit|bye)$/i.test(q.trim())) { rl.close(); break; }
    try {
      const answer = await analyzeWithClaude(quoteData, q.trim(), accountName);
      console.log('\nClaude:', answer);
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const urlIdx  = args.indexOf('--url');
  const urlArg  = urlIdx !== -1 ? args[urlIdx + 1] : null;
  const idIdx       = args.indexOf('--id');
  const idArg       = idIdx !== -1 ? args[idIdx + 1] : null;
  const acctIdIdx   = args.indexOf('--account-id');
  const acctIdArg   = acctIdIdx !== -1 ? args[acctIdIdx + 1] : null;
  const latest      = args.includes('--latest');
  const won         = args.includes('--won');
  const askIdx      = args.indexOf('--ask');
  const askArg      = askIdx !== -1 ? args.slice(askIdx + 1).join(' ') : null;
  const skipIdxs = new Set([
    ...(urlIdx     !== -1 ? [urlIdx,     urlIdx     + 1] : []),
    ...(idIdx      !== -1 ? [idIdx,      idIdx      + 1] : []),
    ...(acctIdIdx  !== -1 ? [acctIdIdx,  acctIdIdx  + 1] : []),
    ...(askIdx     !== -1 ? [askIdx,     ...args.slice(askIdx + 1).map((_, i) => askIdx + 1 + i)] : []),
  ]);
  const query   = args.find((a, i) => !skipIdxs.has(i) && !a.startsWith('--'));

  const { api, token } = resolveCred(urlArg);
  console.log(`Tenant: ${api}\n`);

  // --list mode
  if (query === '--list' || (!query && !idArg && !acctIdArg && !latest && !won)) {
    const accounts = await listAccounts(api, token);
    console.log('Recent accounts:');
    Object.entries(accounts).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${c}x  ${n}`));
    return;
  }

  let quoteData = [];
  let accountName = query || acctIdArg || idArg || 'Latest 50 quotes';

  // --won: fetch 100 quotes, filter for won status, analyse latest 20
  if (won) {
    console.log('Fetching 100 most recent quotes to find latest wins...');
    const summaries = [];
    for (let page = 0; page < 10 && summaries.length < 100; page++) {
      const data = await dhGetRetry(api, `/api/v2/quotes?limit=10&offset=${page * 10}&feature=info`, token);
      if (!data?.quotes?.length) break;
      summaries.push(...data.quotes);
      process.stdout.write(`  Page ${page + 1}: ${summaries.length} quotes scanned\r`);
      if (!data.info?.more_results_matching_the_request) break;
    }
    process.stdout.write('\n');
    const wonQuotes = summaries.filter(q => /won/i.test(q.status || '')).slice(0, 20);
    if (!wonQuotes.length) { console.log('No won quotes found in the latest 100.'); process.exit(0); }
    console.log(`\nFound ${wonQuotes.length} won quotes. Fetching details...`);
    for (let i = 0; i < wonQuotes.length; i++) {
      const id = wonQuotes[i].dealhub_quote_id || wonQuotes[i].system_id;
      if (!id) { quoteData.push(wonQuotes[i]); continue; }
      process.stdout.write(`  [${i + 1}/${wonQuotes.length}] ${id}...`);
      const detail = await fetchQuoteDetail(api, token, id);
      quoteData.push(detail || wonQuotes[i]);
      process.stdout.write(' done\n');
    }
    accountName = `Latest 20 Won Quotes`;
  }

  // --latest: fetch the 50 most recent quotes across all accounts
  else if (latest) {
    console.log('Fetching the 50 most recent quotes...');
    const summaries = [];
    for (let page = 0; page < 5 && summaries.length < 50; page++) {
      const data = await dhGetRetry(api, `/api/v2/quotes?limit=10&offset=${page * 10}&feature=info`, token);
      if (!data?.quotes?.length) break;
      summaries.push(...data.quotes);
      process.stdout.write(`  Page ${page + 1}: ${summaries.length} quotes\n`);
      if (!data.info?.more_results_matching_the_request) break;
    }
    console.log(`\nFetching details for ${Math.min(summaries.length, 10)} quotes...`);
    for (let i = 0; i < Math.min(summaries.length, 10); i++) {
      const id = summaries[i].dealhub_quote_id || summaries[i].system_id;
      if (!id) { quoteData.push(summaries[i]); continue; }
      process.stdout.write(`  [${i + 1}/10] ${id}...`);
      const detail = await fetchQuoteDetail(api, token, id);
      quoteData.push(detail || summaries[i]);
      process.stdout.write(' done\n');
    }
    // Append remaining as summaries (no detail fetch)
    quoteData.push(...summaries.slice(10));
    accountName = 'Latest 50 quotes';
  }

  // --id: fetch a specific quote
  else if (idArg) {
    console.log(`Fetching quote ${idArg}...`);
    const q = await fetchQuoteDetail(api, token, idArg);
    if (!q) { console.log('Quote not found or timed out.'); process.exit(1); }
    quoteData = [q];
    accountName = q.info?.account_name || idArg;
    console.log(`Loaded quote for: ${accountName}`);
  } else {
    // Search by account ID (--account-id) or account name
    const searchTerm = acctIdArg || query;
    const summaries = await searchByAccount(api, token, searchTerm, 60, !!acctIdArg);
    if (!summaries.length) {
      console.log(`\nNo quotes found matching "${searchTerm}".`);
      console.log('Tips: try a partial name, use --id <quote_id>, --account-id <id>, or run --list to see recent accounts.');
      process.exit(0);
    }
    accountName = summaries[0].info?.account_name || searchTerm;
    console.log(`\nFound ${summaries.length} quotes for "${accountName}". Fetching details...`);

    // Fetch full details for up to 10 quotes (to keep context manageable)
    const toFetch = summaries.slice(0, 10);
    for (let i = 0; i < toFetch.length; i++) {
      const id = toFetch[i].dealhub_quote_id || toFetch[i].system_id;
      if (!id) { quoteData.push(toFetch[i]); continue; }
      process.stdout.write(`  [${i + 1}/${toFetch.length}] ${id}...`);
      const detail = await fetchQuoteDetail(api, token, id);
      quoteData.push(detail || toFetch[i]);
      process.stdout.write(' done\n');
    }
  }

  // Initial analysis
  const analysis = await analyzeWithClaude(quoteData, askArg || null, accountName);
  console.log(analysis);

  // Interactive follow-up (only if running in a terminal)
  if (process.stdin.isTTY && !askArg) {
    console.log('\n─────────────────────────────────────');
    console.log('Ask follow-up questions (or "exit" to quit)');
    await interactiveLoop(api, token, quoteData, accountName);
  }
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
