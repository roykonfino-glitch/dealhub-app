#!/usr/bin/env node
/**
 * DealHub Playbook Question Impact Analysis
 *
 * Usage:
 *   node question_impact_analysis.js <base-url> [playbook-name]
 *
 * Examples:
 *   node question_impact_analysis.js https://quartexsoftware.dealhub.io
 *   node question_impact_analysis.js https://service-us2.dealhub.io "My Playbook"
 */

'use strict';

const { chromium }       = require('playwright');
const { request: pwReq } = require('playwright');
const XLSX               = require('xlsx');
const fs                 = require('fs');
const path               = require('path');
const os                 = require('os');

const BASE_URL      = (process.argv[2] || '').replace(/\/$/, '');
const PB_FILTER     = (process.argv[3] || '').toLowerCase();

if (!BASE_URL) {
  console.error('Usage: node question_impact_analysis.js <base-url> [playbook-name-filter]');
  process.exit(1);
}

const host         = new URL(BASE_URL).hostname.replace(/\./g, '_');
const SESSION_FILE = path.join(__dirname, `session_${host}.json`);
const OUT_FILE     = path.join(os.homedir(), 'Downloads',
  `Impact_Analysis_${host}_${new Date().toISOString().slice(0, 10)}.xlsx`);

// ── Session ───────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const ctx = await pwReq.newContext({
        baseURL: BASE_URL,
        storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
        extraHTTPHeaders: { Accept: 'application/json' },
      });
      const res = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
      if (res.ok()) {
        console.log('✓ Existing session valid');
        await ctx.dispose();
        return;
      }
      await ctx.dispose();
    } catch {}
    console.log('Session expired — re-authenticating...');
  }

  console.log(`\nOpening browser → ${BASE_URL}`);
  console.log('Log in and navigate into the admin area. Script will auto-continue.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page    = await context.newPage();
  let saved = false;

  page.on('response', async (response) => {
    if (saved || response.status() !== 200) return;
    if (!response.url().includes('dealhub.io')) return;
    if (!/\/(versions|playbooks|workflowSpecialRule|submitValidation)/.test(response.url())) return;
    try {
      const state = await context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
      saved = true;
      console.log('✓ Session captured — closing browser...');
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
async function api() {
  if (_ctx) return _ctx;
  _ctx = await pwReq.newContext({
    baseURL: BASE_URL,
    storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
    extraHTTPHeaders: { Accept: 'application/json' },
  });
  return _ctx;
}

async function get(urlPath) {
  const ctx = await api();
  const res = await ctx.get(urlPath);
  if (!res.ok()) { console.warn(`  WARN ${res.status()} ${urlPath}`); return null; }
  return res.json();
}

// ── Core analysis ─────────────────────────────────────────────────────────────

function extractRules(playbook) {
  const rules = [];
  const groups = playbook.solutions || [];

  for (const g of groups) {
    const gName = g.name;

    // Group-level visibility rule
    const cpr = (g.cpr || '').trim();
    if (cpr && cpr !== 'true') rules.push({ text: cpr, consumerName: gName, displayName: g.displayedName || gName, subObject: gName, subType: 'groupVisibilityRule' });
    const commPR = g.commonPresentationRule?.rule;
    if (commPR) rules.push({ text: commPR, consumerName: gName, displayName: g.displayedName || gName, subObject: gName, subType: 'groupCommonPR' });

    for (const q of (g.solutionAttributes || [])) {
      const qName = q.name;
      const qLabel = q.question || q.name;
      const push = (text, subType) => { if (text) rules.push({ text, consumerName: qName, displayName: qLabel, subObject: gName, subType }); };

      const hidden = q.hiddenRule || '';
      if (hidden && hidden !== 'false') push(hidden, 'hiddenRule');
      const ro = q.readOnlyRule || '';
      if (ro && ro !== 'false' && ro !== 'true') push(ro, 'readOnlyRule');
      const cw = q.calculateWhenRule || '';
      if (cw && cw !== 'true') push(cw, 'calculateWhenRule');
      if (q.defaultValue) push(q.defaultValue, 'defaultValue');
      for (const pr of (q.presentationRules || [])) { if (pr.rule) push(pr.rule, 'presentationRules'); }
      for (const cr of (q.conditionalRules  || [])) {
        const r = cr.rule || cr.expression || cr.condition || '';
        if (r) push(r, 'conditionalRules');
      }
    }
  }
  return rules;
}

function runAnalysis(playbook, approvalRules) {
  const groups = playbook.solutions || [];

  // Index all questions
  const allQs = [];
  for (const g of groups) {
    for (const q of (g.solutionAttributes || [])) {
      allQs.push({
        groupName: g.name,
        qName:     q.name,
        label:     q.question || q.name,
        qtype:     q.type || '',
        ref:       `[${g.name}.${q.name}]`,
      });
    }
  }

  // Collect all rule texts
  const pbRules = extractRules(playbook).map(r => ({ ...r, type: 'Playbook Rule' }));
  const awRules = [];
  for (const rule of (approvalRules || [])) {
    const expr = rule.expression || rule.ruleExpression || '';
    if (expr) awRules.push({ text: expr, type: 'Approval Workflow', consumerName: rule.name || '', displayName: rule.name || '', subObject: '', subType: 'expression' });
  }
  const allRules = [...pbRules, ...awRules];

  // Build dependency records
  const deps = [];
  for (const q of allQs) {
    for (const rule of allRules) {
      if (rule.text.includes(q.ref)) {
        deps.push({
          questionRef:  q.ref,
          type:         rule.type,
          consumerName: rule.consumerName,
          displayName:  rule.displayName,
          subObject:    rule.subObject,
          subType:      rule.subType,
          ruleText:     rule.text,
        });
      }
    }
  }

  // Per-question stats
  const stats = new Map();
  for (const q of allQs) stats.set(q.ref, { refCount: 0, types: new Set() });
  for (const d of deps) {
    const s = stats.get(d.questionRef);
    if (s) { s.refCount++; s.types.add(d.type); }
  }

  return { allQs, deps, stats };
}

// ── Excel output ──────────────────────────────────────────────────────────────

function buildExcel(playbookName, versionName, allQs, deps, stats) {
  const wb = XLSX.utils.book_new();
  const today = new Date().toISOString().slice(0, 10);

  const used   = allQs.filter(q => stats.get(q.ref).refCount > 0);
  const unused = allQs.filter(q => stats.get(q.ref).refCount === 0);
  const pbDeps = deps.filter(d => d.type === 'Playbook Rule');
  const awDeps = deps.filter(d => d.type === 'Approval Workflow');
  const unusedPct = allQs.length > 0 ? Math.round(unused.length / allQs.length * 100) + '%' : '0%';

  // Sheet 1: All Questions
  const wsQ = XLSX.utils.aoa_to_sheet([
    ['#', 'Group', 'Question ID', 'Display Name', 'Type', '# References', 'Referenced In', 'Status'],
    ...allQs.map((q, i) => {
      const s = stats.get(q.ref);
      return [i + 1, q.groupName, q.ref, q.label, q.qtype, s.refCount, [...s.types].join(', ') || '', s.refCount > 0 ? 'Used' : 'Unused'];
    }),
  ]);
  wsQ['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 45 }, { wch: 35 }, { wch: 18 }, { wch: 12 }, { wch: 20 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsQ, `All Questions (${allQs.length})`);

  // Sheet 2: All Dependencies
  const wsDeps = XLSX.utils.aoa_to_sheet([
    ['#', 'Question Ref', 'Type', 'Object', 'Consumer Name', 'Display Name', 'Sub-Object', 'Sub-Type', 'Value / Rule'],
    ...deps.map((d, i) => [i + 1, d.questionRef, d.type, 'Question', d.consumerName, d.displayName, d.subObject, d.subType, d.ruleText]),
  ]);
  wsDeps['!cols'] = [{ wch: 5 }, { wch: 45 }, { wch: 18 }, { wch: 10 }, { wch: 30 }, { wch: 30 }, { wch: 25 }, { wch: 20 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wsDeps, `All Dependencies (${deps.length})`);

  // Sheet 3: Unused
  const wsU = XLSX.utils.aoa_to_sheet([
    ['#', 'Group', 'Question ID', 'Display Name', 'Type'],
    ...unused.map((q, i) => [i + 1, q.groupName, q.ref, q.label, q.qtype]),
  ]);
  wsU['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 45 }, { wch: 35 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsU, `Unused (${unused.length})`);

  // Sheet 4: By Type
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Type', '# Records', 'Unique Questions'],
    ['Playbook Rule',     pbDeps.length, new Set(pbDeps.map(d => d.questionRef)).size],
    ['Approval Workflow', awDeps.length, new Set(awDeps.map(d => d.questionRef)).size],
  ]), 'By Type');

  // Sheet 5: Summary
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Metric', 'Value'],
    ['Account',            new URL(BASE_URL).hostname],
    ['Version',            versionName],
    ['Playbook',           playbookName],
    ['Exported On',        today],
    ['', ''],
    ['TOTAL QUESTIONS',          allQs.length],
    ['  — Used (referenced)',     used.length],
    ['  — Unused (0 references)', unused.length],
    ['  — Unused %',             unusedPct],
    ['', ''],
    ['TOTAL DEPENDENCY RECORDS', deps.length],
    ['  — Playbook Rule',        pbDeps.length],
    ['  — Approval Workflow',    awDeps.length],
  ]), 'Summary');

  XLSX.writeFile(wb, OUT_FILE);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await ensureSession();

    // Pick DRAFT version (prefer DRAFT, fall back to ACTIVE)
    console.log('\nFetching versions...');
    const versions = await get('/versions/admin?isArchived=false&versionsScreen=true') || [];
    const version  = versions.find(v => v.status === 'DRAFT') || versions.find(v => v.status === 'ACTIVE') || versions[0];
    if (!version) throw new Error('No versions found');
    const vguid = version.guid || version.versionGUID;
    console.log(`✓ Version: "${version.name}" [${version.status}]`);

    // Pick playbook
    console.log('Fetching playbooks...');
    const playbooks = await get(`/playbooks?versionGUID=${vguid}`) || [];
    if (!playbooks.length) throw new Error('No playbooks found in this version');

    let playbook_meta = playbooks[0];
    if (PB_FILTER) {
      const match = playbooks.find(p => (p.name || '').toLowerCase().includes(PB_FILTER));
      if (match) playbook_meta = match;
      else console.warn(`  No playbook matching "${PB_FILTER}" — using first: "${playbooks[0].name}"`);
    } else if (playbooks.length > 1) {
      console.log(`  Found ${playbooks.length} playbooks:`);
      playbooks.forEach((p, i) => console.log(`    [${i}] ${p.name}`));
      console.log(`  Using first. Pass a name filter as 2nd arg to select a specific one.`);
    }

    const pbGuid = playbook_meta.guid || playbook_meta.playbookGUID;
    console.log(`✓ Playbook: "${playbook_meta.name}"`);

    // Fetch full playbook
    console.log('Fetching full playbook data...');
    const playbook = await get(`/playbook?playbookGUID=${pbGuid}`);
    if (!playbook) throw new Error('Failed to fetch playbook');
    const groups = playbook.solutions || [];
    const totalQ = groups.reduce((n, g) => n + (g.solutionAttributes || []).length, 0);
    console.log(`✓ ${groups.length} groups, ${totalQ} questions`);

    // Fetch approval workflows
    console.log('Fetching approval workflows...');
    const wfRaw = await get(`/workflowSpecialRule/list?versionGUID=${vguid}`);
    const approvalRules = Array.isArray(wfRaw) ? wfRaw : (wfRaw?.specialRules || wfRaw?.specialRuleWorkflowBlock?.specialRules || []);
    console.log(`✓ ${approvalRules.length} approval rules`);

    // Run analysis
    console.log('\nRunning impact analysis...');
    const { allQs, deps, stats } = runAnalysis(playbook, approvalRules);

    const used   = allQs.filter(q => stats.get(q.ref).refCount > 0);
    const unused = allQs.filter(q => stats.get(q.ref).refCount === 0);

    console.log(`\n── Results ──`);
    console.log(`  Total questions:       ${allQs.length}`);
    console.log(`  Used (referenced):     ${used.length}`);
    console.log(`  Unused (orphans):      ${unused.length} (${Math.round(unused.length / allQs.length * 100)}%)`);
    console.log(`  Total dependencies:    ${deps.length}`);
    console.log(`  Playbook rule refs:    ${deps.filter(d => d.type === 'Playbook Rule').length}`);
    console.log(`  Approval workflow refs:${deps.filter(d => d.type === 'Approval Workflow').length}`);

    console.log('\nTop 10 most referenced questions:');
    allQs
      .map(q => ({ q, s: stats.get(q.ref) }))
      .filter(x => x.s.refCount > 0)
      .sort((a, b) => b.s.refCount - a.s.refCount)
      .slice(0, 10)
      .forEach(x => console.log(`  [${x.s.refCount}x] ${x.q.ref} "${x.q.label}"`));

    // Build Excel
    buildExcel(playbook_meta.name, version.name, allQs, deps, stats);
    console.log(`\n✓ Excel saved → ${OUT_FILE}`);

  } catch (e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
})();
