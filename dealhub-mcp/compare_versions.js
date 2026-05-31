#!/usr/bin/env node
/**
 * DealHub Version Comparison — Products, Assignments & Pricing Rules
 *
 * Usage:
 *   node compare_versions.js <versionA-name> <versionB-name> [base-url]
 *
 * Example:
 *   node compare_versions.js V62_5 V64
 *
 * Compares two versions on:
 *   - Product list + pricing (price, list price, cost)
 *   - Product assignments (playbook/solution assignment)
 *   - Pricing / workflow rules (approval rules, discount rules, etc.)
 *   - Submit validation rules
 */

'use strict';

const { request: pwReq } = require('playwright');
const { chromium }       = require('playwright');
const XLSX               = require('xlsx');
const fs                 = require('fs');
const path               = require('path');
const os                 = require('os');

const [VA_NAME, VB_NAME] = process.argv.slice(2, 4);
if (!VA_NAME || !VB_NAME) {
  console.error('Usage: node compare_versions.js <versionA> <versionB> [base-url]');
  process.exit(1);
}

const SESSION_FILE = path.join(__dirname, 'session_eu1.json');

let BASE_URL = process.argv[4];
if (!BASE_URL && fs.existsSync(SESSION_FILE)) {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  if (s._host) BASE_URL = `https://${s._host}`;
}
if (!BASE_URL) BASE_URL = 'https://service-eu1.dealhub.io';
BASE_URL = BASE_URL.replace(/\/$/, '');

const OUT_FILE = path.join(
  os.homedir(), 'Downloads',
  `version_compare_${VA_NAME}_vs_${VB_NAME}_${new Date().toISOString().slice(0, 10)}.xlsx`
);

// ── Session ───────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const ctx = await pwReq.newContext({
        baseURL: BASE_URL,
        storageState: raw,
        extraHTTPHeaders: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      const res = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
      if (res.ok()) { await ctx.dispose(); console.log('Session valid'); return; }
      await ctx.dispose();
    } catch {}
  }

  console.log(`\nOpening browser for login → ${BASE_URL}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page    = await context.newPage();
  let saved = false;

  page.on('response', async (response) => {
    if (saved || response.status() !== 200) return;
    const url = response.url();
    if (!url.includes('dealhub.io')) return;
    if (!/\/(versions|playbooks?|products|workflowSpecialRule|submitValidation)/.test(url)) return;
    try {
      const state = await context.storageState();
      const host  = new URL(url).hostname;
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...state, _host: host }, null, 2));
      saved = true;
      console.log(`Session captured. Closing browser...`);
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

let _ctx = null;
async function getCtx() {
  if (_ctx) return _ctx;
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  _ctx = await pwReq.newContext({
    baseURL: BASE_URL,
    storageState: raw,
    extraHTTPHeaders: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  return _ctx;
}

async function get(urlPath) {
  const ctx = await getCtx();
  try {
    const res = await ctx.get(urlPath, { timeout: 30000 });
    if (!res.ok()) {
      const body = await res.text().catch(() => '');
      console.warn(`  WARN: GET ${urlPath} → ${res.status()}: ${body.slice(0, 120)}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn(`  ERROR: ${urlPath} → ${e.message}`);
    return null;
  }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchVersions() {
  const data = await get('/versions/admin?isArchived=false&versionsScreen=true');
  return Array.isArray(data?.versions) ? data.versions
       : Array.isArray(data)           ? data
       : [];
}

function findVersion(versions, name) {
  const lo = name.toLowerCase();
  return versions.find(v =>
    (v.name || v.versionName || '').toLowerCase() === lo ||
    (v.name || v.versionName || '').toLowerCase().includes(lo)
  );
}

async function fetchProducts(vGuid) {
  // Product catalog export: 2-step token flow
  // Step 1: get a short-lived download token
  const tokenRes = await getCtx().then(c => c.get(`/masterdata/exportProductToken?versionGUID=${vGuid}`, { timeout: 15000 }));
  if (!tokenRes || !tokenRes.ok()) return { xlsxBuf: null };
  const token = (await tokenRes.text()).replace(/"/g, '').trim();

  // Step 2: download the Excel binary
  const dlRes = await getCtx().then(c => c.get(`/masterdata/exportProduct?token=${token}`, {
    headers: { Accept: 'application/octet-stream' }, timeout: 30000,
  }));
  if (!dlRes || !dlRes.ok()) return { xlsxBuf: null };
  const xlsxBuf = await dlRes.body();
  return { xlsxBuf };
}

function parseProductXlsx(buf) {
  if (!buf) return { rows: [], asgRows: [], priceRows: [] };
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });

  function readSheet(sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let hdrIdx = 1;
    for (let i = 0; i < Math.min(raw.length, 5); i++) {
      if (raw[i].some(c => /^(SKU|Bundle SKU|Product SKU)$/i.test(String(c).trim()))) { hdrIdx = i; break; }
    }
    const headers = raw[hdrIdx].map(h => String(h).trim());
    const rows = [];
    for (let i = hdrIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      if (!r.some(c => String(c).trim())) continue;
      const obj = {};
      headers.forEach((h, j) => { obj[h] = String(r[j] ?? '').trim(); });
      rows.push(obj);
    }
    return rows;
  }

  return {
    rows:      readSheet('Products'),
    asgRows:   readSheet('Products Assignment'),
    priceRows: readSheet('Pricing Rules'),
  };
}

async function fetchPricingRules(vGuid) {
  const d = await get(`/workflowSpecialRule?versionGUID=${vGuid}`);
  if (!d) return [];
  // Response is nested: { specialRuleWorkflowBlock: { specialRules: [...] } }
  return d?.specialRuleWorkflowBlock?.specialRules || (Array.isArray(d) ? d : []);
}

async function fetchSubmitValidations(vGuid) {
  const d = await get(`/submitValidationSettings?versionGUID=${vGuid}`);
  if (!d) return [];
  // Response: { submitValidationRules: [...], productTags: [...], ... }
  return d?.submitValidationRules || (Array.isArray(d) ? d : []);
}

async function fetchPlaybooks(vGuid) {
  const d = await get(`/playbooks?versionGUID=${vGuid}`);
  if (!d) return [];
  return Array.isArray(d) ? d : Array.isArray(d.playbooks) ? d.playbooks : [];
}

async function fetchPlaybookDetail(pbGuid, vGuid) {
  return get(`/playbook?playbookGUID=${pbGuid}&versionGUID=${vGuid}`);
}

// ── Extract product assignments from playbooks ────────────────────────────────

async function fetchProductAssignments(vGuid) {
  const playbooks = await fetchPlaybooks(vGuid);
  const assignments = [];

  for (const pb of playbooks) {
    const pbGuid = pb.guid || pb.playbookGUID;
    const pbName = pb.name || pb.playbookName || pbGuid;
    const detail = await fetchPlaybookDetail(pbGuid, vGuid);
    if (!detail) continue;

    const solutions = detail.solutions || detail.groups || [];
    for (const sol of solutions) {
      const solName = sol.name || '';
      const solType = sol.groupType || sol.type || '';

      // Products assigned directly to this solution
      const solProducts = sol.solutionProducts || sol.products || sol.assignedProducts || [];
      for (const sp of solProducts) {
        const sku  = sp.sku || sp.productSKU || sp.id || '';
        const name = sp.name || sp.productName || '';
        const pType = sp.type || '';
        assignments.push({ playbook: pbName, solution: solName, solutionType: solType, sku, name, pType });
      }

      // Also check pricebook reference on solution
      if (sol.pricebookGuid && solProducts.length === 0) {
        assignments.push({ playbook: pbName, solution: solName, solutionType: solType, sku: '(all via pricebook)', name: sol.pricebookGuid, pType: '' });
      }
    }
  }
  return assignments;
}

// ── Normalize product for comparison ─────────────────────────────────────────

function normProduct(p) {
  return {
    sku:        p.sku || p.productSKU || p.id || '',
    name:       p.name || p.productName || '',
    type:       p.type || p.productType || '',
    price:      p.price ?? p.listPrice ?? p.standardPrice ?? '',
    cost:       p.cost ?? p.costPrice ?? '',
    currency:   p.currency || p.currencyCode || '',
    active:     p.isActive ?? p.active ?? '',
    tags:       (p.tags || p.tagRelations || []).map(t => t.name || t.tag || t).join(', '),
    category:   p.category || p.productCategory || '',
    primaryTag: p.primaryTag || p.primary_tag || '',
  };
}

// Convert an Excel-export product row (DealHub product catalog .xlsx) to normProduct shape
function xlsxRowToNorm(r) {
  return {
    sku:        r['SKU'] || r['Product SKU'] || '',
    name:       r['Name'] || r['NAME'] || '',
    type:       r['Product Type'] || r['Type'] || '',
    price:      r['Price'] || r['List Price'] || r['Standard Price'] || '',
    cost:       r['Cost'] || r['Cost Price'] || '',
    currency:   r['Currency'] || '',
    active:     r['Active'] || r['Is Active'] || '',
    tags:       r['Tags'] || '',
    category:   r['Category'] || '',
    primaryTag: r['Primary Tag'] || '',
  };
}

function normRule(r) {
  return {
    name:       r.name || r.ruleName || '',
    type:       r.type || r.ruleType || '',
    status:     r.status || r.ruleStatus || '',
    expression: r.expression || r.condition || r.rule || '',
    action:     r.action || r.actionType || '',
    priority:   r.priority ?? r.ordinal ?? '',
    tags:       Array.isArray(r.tagRelations) ? r.tagRelations.map(t => t.name || t).join(', ') : '',
  };
}

// ── Comparison helpers ────────────────────────────────────────────────────────

function diffMaps(mapA, mapB, keyField) {
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const onlyA = [], onlyB = [], changed = [], same = [];

  for (const k of allKeys) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    if (!a) { onlyB.push(b); continue; }
    if (!b) { onlyA.push(a); continue; }
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    if (aStr === bStr) same.push(a);
    else changed.push({ key: k, a, b });
  }
  return { onlyA, onlyB, changed, same };
}

// ── Excel builder ─────────────────────────────────────────────────────────────

function addSheet(wb, name, rows) {
  if (!rows.length) return;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31));
}

function buildExcel(vA, vB, prods, rules, svRules, assignments) {
  const wb = XLSX.utils.book_new();
  const na = vA.name, nb = vB.name;

  // ── Products comparison ───────────────────────────────────────────────────

  const prodHdr = ['SKU', 'Name', 'Type', 'Category', 'Primary Tag', 'Tags',
    `Price (${na})`, `Price (${nb})`, 'Price Δ',
    `Cost (${na})`, `Cost (${nb})`, 'Cost Δ',
    `Currency (${na})`, `Currency (${nb})`,
    `Active (${na})`, `Active (${nb})`,
    'Change'];

  const prodRows = [prodHdr];

  for (const { key, a, b } of prods.changed) {
    const changes = [];
    for (const f of ['price', 'cost', 'currency', 'active', 'tags', 'primaryTag', 'type', 'category']) {
      if (String(a[f]) !== String(b[f])) changes.push(f);
    }
    const priceDelta = (typeof b.price === 'number' && typeof a.price === 'number')
      ? (b.price - a.price).toFixed(2) : '';
    const costDelta = (typeof b.cost === 'number' && typeof a.cost === 'number')
      ? (b.cost - a.cost).toFixed(2) : '';

    prodRows.push([
      a.sku || b.sku, a.name || b.name, a.type || b.type, a.category || b.category,
      a.primaryTag || b.primaryTag, a.tags || b.tags,
      a.price, b.price, priceDelta,
      a.cost, b.cost, costDelta,
      a.currency, b.currency,
      a.active, b.active,
      changes.join(', '),
    ]);
  }

  for (const p of prods.onlyA) {
    prodRows.push([p.sku, p.name, p.type, p.category, p.primaryTag, p.tags,
      p.price, '', '', p.cost, '', '', p.currency, '', p.active, '', `removed in ${nb}`]);
  }
  for (const p of prods.onlyB) {
    prodRows.push([p.sku, p.name, p.type, p.category, p.primaryTag, p.tags,
      '', p.price, '', '', p.cost, '', '', p.currency, '', p.active, `added in ${nb}`]);
  }

  addSheet(wb, 'Products - Changes', prodRows);

  // Same products (no changes)
  const sameRows = [[...prodHdr.slice(0, 6), 'Price', 'Cost', 'Currency', 'Active']];
  for (const p of prods.same) {
    sameRows.push([p.sku, p.name, p.type, p.category, p.primaryTag, p.tags, p.price, p.cost, p.currency, p.active]);
  }
  addSheet(wb, 'Products - Unchanged', sameRows);

  // ── Pricing rules comparison ──────────────────────────────────────────────

  const ruleHdr = ['Name', 'Type', 'Priority', 'Tags', `Status (${na})`, `Status (${nb})`,
    `Expression (${na})`, `Expression (${nb})`, `Action (${na})`, `Action (${nb})`, 'Change'];
  const ruleRows = [ruleHdr];

  for (const { key, a, b } of rules.changed) {
    const changes = [];
    for (const f of ['status', 'expression', 'action', 'priority', 'type']) {
      if (String(a[f]) !== String(b[f])) changes.push(f);
    }
    ruleRows.push([
      a.name || b.name, a.type || b.type, a.priority ?? b.priority, a.tags || b.tags,
      a.status, b.status, a.expression, b.expression, a.action, b.action,
      changes.join(', '),
    ]);
  }
  for (const r of rules.onlyA) {
    ruleRows.push([r.name, r.type, r.priority, r.tags, r.status, '', r.expression, '', r.action, '', `removed in ${nb}`]);
  }
  for (const r of rules.onlyB) {
    ruleRows.push([r.name, r.type, r.priority, r.tags, '', r.status, '', r.expression, '', r.action, `added in ${nb}`]);
  }
  const rulesSameRows = [['Name', 'Type', 'Priority', 'Tags', 'Status', 'Expression', 'Action']];
  for (const r of rules.same) {
    rulesSameRows.push([r.name, r.type, r.priority, r.tags, r.status, r.expression, r.action]);
  }

  addSheet(wb, 'Pricing Rules - Changes', ruleRows);
  addSheet(wb, 'Pricing Rules - Unchanged', rulesSameRows);

  // ── Submit validation rules ───────────────────────────────────────────────

  const svHdr = ['Name', 'Type', 'Tags', `Status (${na})`, `Status (${nb})`,
    `Expression (${na})`, `Expression (${nb})`, 'Change'];
  const svRows = [svHdr];

  for (const { a, b } of svRules.changed) {
    const changes = [];
    for (const f of ['status', 'expression', 'action', 'type']) {
      if (String(a[f]) !== String(b[f])) changes.push(f);
    }
    svRows.push([a.name || b.name, a.type || b.type, a.tags || b.tags,
      a.status, b.status, a.expression, b.expression, changes.join(', ')]);
  }
  for (const r of svRules.onlyA) {
    svRows.push([r.name, r.type, r.tags, r.status, '', r.expression, '', `removed in ${nb}`]);
  }
  for (const r of svRules.onlyB) {
    svRows.push([r.name, r.type, r.tags, '', r.status, '', r.expression, `added in ${nb}`]);
  }

  addSheet(wb, 'Submit Validations', svRows);

  // ── Product assignments comparison ────────────────────────────────────────

  const asgHdr = ['Playbook', 'Solution', 'Solution Type', 'SKU', 'Product Name', 'Product Type', `In ${na}`, `In ${nb}`];
  const asgRows = [asgHdr];
  const asgKeyA = new Map(assignments.a.map(a => [`${a.playbook}|${a.solution}|${a.sku}`, a]));
  const asgKeyB = new Map(assignments.b.map(b => [`${b.playbook}|${b.solution}|${b.sku}`, b]));
  const allAsg  = new Set([...asgKeyA.keys(), ...asgKeyB.keys()]);

  for (const k of allAsg) {
    const a = asgKeyA.get(k);
    const b = asgKeyB.get(k);
    const r = a || b;
    const inA = a ? 'YES' : 'NO';
    const inB = b ? 'YES' : 'NO';
    if (inA !== inB) {
      asgRows.push([r.playbook, r.solution, r.solutionType, r.sku, r.name, r.pType, inA, inB]);
    }
  }
  // Also show unchanged if there are any
  if (asgRows.length === 1) {
    asgRows.push(['(no assignment differences found)', '', '', '', '', '', '', '']);
  }

  addSheet(wb, 'Assignments - Changes', asgRows);

  // Full assignment list for reference
  const asgAllHdr = ['Version', 'Playbook', 'Solution', 'Solution Type', 'SKU', 'Product Name', 'Product Type'];
  const asgAllRows = [asgAllHdr];
  for (const a of assignments.a) asgAllRows.push([na, a.playbook, a.solution, a.solutionType, a.sku, a.name, a.pType]);
  for (const b of assignments.b) asgAllRows.push([nb, b.playbook, b.solution, b.solutionType, b.sku, b.name, b.pType]);
  addSheet(wb, 'Assignments - All', asgAllRows);

  // ── Summary ───────────────────────────────────────────────────────────────

  const sumRows = [
    ['Version Comparison Summary', ''],
    ['', ''],
    ['Versions compared', `${na}  vs  ${nb}`],
    ['Tenant', BASE_URL],
    ['Generated', new Date().toISOString()],
    ['', ''],
    ['PRODUCTS', ''],
    [`  Only in ${na}`, prods.onlyA.length],
    [`  Only in ${nb}`, prods.onlyB.length],
    ['  Changed (price/cost/etc)', prods.changed.length],
    ['  Unchanged', prods.same.length],
    ['', ''],
    ['PRICING RULES', ''],
    [`  Only in ${na}`, rules.onlyA.length],
    [`  Only in ${nb}`, rules.onlyB.length],
    ['  Changed', rules.changed.length],
    ['  Unchanged', rules.same.length],
    ['', ''],
    ['SUBMIT VALIDATIONS', ''],
    [`  Only in ${na}`, svRules.onlyA.length],
    [`  Only in ${nb}`, svRules.onlyB.length],
    ['  Changed', svRules.changed.length],
    ['', ''],
    ['PRODUCT ASSIGNMENTS', ''],
    [`  ${na} assignments`, assignments.a.length],
    [`  ${nb} assignments`, assignments.b.length],
    ['  Differences', asgRows.length - 1],
  ];
  addSheet(wb, 'Summary', sumRows);

  XLSX.writeFile(wb, OUT_FILE);
  console.log(`\nExcel written → ${OUT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  await ensureSession();

  console.log(`\nFetching versions from ${BASE_URL}...`);
  const versions = await fetchVersions();
  console.log(`  ${versions.length} versions found`);

  const vA = findVersion(versions, VA_NAME);
  const vB = findVersion(versions, VB_NAME);

  if (!vA) {
    console.error(`Version "${VA_NAME}" not found. Available: ${versions.map(v => v.name || v.versionName).join(', ')}`);
    process.exit(1);
  }
  if (!vB) {
    console.error(`Version "${VB_NAME}" not found. Available: ${versions.map(v => v.name || v.versionName).join(', ')}`);
    process.exit(1);
  }

  const gA = vA.guid || vA.versionGUID;
  const gB = vB.guid || vB.versionGUID;
  vA.name = vA.name || vA.versionName;
  vB.name = vB.name || vB.versionName;

  console.log(`\nComparing:`);
  console.log(`  A: ${vA.name} (${gA}) [${vA.status || vA.versionStatus}]`);
  console.log(`  B: ${vB.name} (${gB}) [${vB.status || vB.versionStatus}]`);

  // ── Fetch products (via Excel export API) ──────────────────────────────
  console.log(`\nExporting product catalogs...`);
  const [xlsxA, xlsxB] = await Promise.all([fetchProducts(gA), fetchProducts(gB)]);
  const parsedA = parseProductXlsx(xlsxA.xlsxBuf);
  const parsedB = parseProductXlsx(xlsxB.xlsxBuf);
  console.log(`  ${vA.name}: ${parsedA.rows.length} products, ${parsedA.asgRows.length} assignments, ${parsedA.priceRows.length} pricing rules`);
  console.log(`  ${vB.name}: ${parsedB.rows.length} products, ${parsedB.asgRows.length} assignments, ${parsedB.priceRows.length} pricing rules`);

  const DROPPED = new Set(['Current Renewal Uplift','Downsell Amount','Downsell Percentage',
    'Previous_Renewal_Amount','Renewal Total','Expansion Total','Uplift Total']);

  function diffByKey(rowsA, rowsB, keyFn, skipFields) {
    const mA = new Map(rowsA.map(r => [keyFn(r), r]));
    const mB = new Map(rowsB.map(r => [keyFn(r), r]));
    const all = [...new Set([...mA.keys(), ...mB.keys()])];
    const onlyA=[], onlyB=[], changed=[], same=[];
    for (const k of all) {
      const a = mA.get(k), b = mB.get(k);
      if (!a) { onlyB.push(b); continue; }
      if (!b) { onlyA.push(a); continue; }
      const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
      const diffs  = [...fields].filter(f => !(skipFields||DROPPED).has(f) && (a[f]||'') !== (b[f]||''));
      if (diffs.length) changed.push({ key: k, a, b, diffs });
      else same.push(a);
    }
    return { onlyA, onlyB, changed, same };
  }

  // Normalize Excel rows to the same shape as normProduct before diffing
  const normA = parsedA.rows.map(xlsxRowToNorm);
  const normB = parsedB.rows.map(xlsxRowToNorm);
  const prods = diffByKey(normA, normB, r => r.sku || r.name, new Set());

  // ── Fetch pricing rules ─────────────────────────────────────────────────
  console.log(`\nFetching pricing/workflow rules...`);
  const [rulesA, rulesB] = await Promise.all([
    fetchPricingRules(gA),
    fetchPricingRules(gB),
  ]);
  console.log(`  ${vA.name}: ${rulesA.length} rules`);
  console.log(`  ${vB.name}: ${rulesB.length} rules`);

  const normRA = rulesA.map(normRule);
  const normRB = rulesB.map(normRule);
  const mapRA  = new Map(normRA.map(r => [r.name, r]));
  const mapRB  = new Map(normRB.map(r => [r.name, r]));
  const rules  = diffMaps(mapRA, mapRB, 'name');

  // ── Fetch submit validations ────────────────────────────────────────────
  console.log(`\nFetching submit validations...`);
  const [svA, svB] = await Promise.all([
    fetchSubmitValidations(gA),
    fetchSubmitValidations(gB),
  ]);
  console.log(`  ${vA.name}: ${svA.length} rules`);
  console.log(`  ${vB.name}: ${svB.length} rules`);

  const normSVA = svA.map(normRule);
  const normSVB = svB.map(normRule);
  const mapSVA  = new Map(normSVA.map(r => [r.name, r]));
  const mapSVB  = new Map(normSVB.map(r => [r.name, r]));
  const svRules = diffMaps(mapSVA, mapSVB, 'name');

  // ── Fetch product assignments ───────────────────────────────────────────
  console.log(`\nFetching product assignments...`);
  const [asgA, asgB] = await Promise.all([
    fetchProductAssignments(gA),
    fetchProductAssignments(gB),
  ]);
  console.log(`  ${vA.name}: ${asgA.length} assignments`);
  console.log(`  ${vB.name}: ${asgB.length} assignments`);

  // ── Print summary ───────────────────────────────────────────────────────
  console.log(`\n── Comparison Summary ──`);
  console.log(`  Products only in ${vA.name}: ${prods.onlyA.length}`);
  console.log(`  Products only in ${vB.name}: ${prods.onlyB.length}`);
  console.log(`  Products changed:            ${prods.changed.length}`);
  console.log(`  Products unchanged:          ${prods.same.length}`);
  console.log(`  Pricing rules only in ${vA.name}: ${rules.onlyA.length}`);
  console.log(`  Pricing rules only in ${vB.name}: ${rules.onlyB.length}`);
  console.log(`  Pricing rules changed:         ${rules.changed.length}`);
  console.log(`  Submit validations only in ${vA.name}: ${svRules.onlyA.length}`);
  console.log(`  Submit validations only in ${vB.name}: ${svRules.onlyB.length}`);
  console.log(`  Submit validations changed:    ${svRules.changed.length}`);

  buildExcel(vA, vB, prods, rules, svRules, { a: asgA, b: asgB });

  if (_ctx) await _ctx.dispose();
})().catch(e => { console.error('Error:', e.message, e.stack); process.exit(1); });
