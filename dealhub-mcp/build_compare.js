'use strict';
const ExcelJS = require('exceljs');
const XLSX    = require('xlsx');
const os      = require('os');
const path    = require('path');

const FILE_A = '/Users/roykonfino/Downloads/Products-V62_5-2026-05-31_13-11-09.xlsx';
const FILE_B = '/Users/roykonfino/Downloads/Products-V64-2026-05-31_13-10-41.xlsx';
const VA = 'V62_5', VB = 'V64';

function readSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return { headers: [], rows: [] };
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
  return { headers, rows };
}

const DROPPED = new Set(['Current Renewal Uplift','Downsell Amount','Downsell Percentage',
  'Previous_Renewal_Amount','Renewal Total','Expansion Total','Uplift Total']);

function diffRows(rowsA, rowsB, keyFields, skipFields) {
  const skip = skipFields || DROPPED;
  const key = r => keyFields.map(f => r[f]||'').join('||');
  const mA = new Map(rowsA.map(r => [key(r), r]));
  const mB = new Map(rowsB.map(r => [key(r), r]));
  const all = [...new Set([...mA.keys(), ...mB.keys()])];
  const onlyA=[], onlyB=[], changed=[], same=[];
  for (const k of all) {
    const a = mA.get(k), b = mB.get(k);
    if (!a) { onlyB.push(b); continue; }
    if (!b) { onlyA.push(a); continue; }
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [...fields].filter(f => !skip.has(f) && (a[f]||'') !== (b[f]||''));
    if (diffs.length) changed.push({ a, b, diffs });
    else same.push(a);
  }
  return { onlyA, onlyB, changed, same };
}

const wbA = XLSX.readFile(FILE_A, { cellDates: true });
const wbB = XLSX.readFile(FILE_B, { cellDates: true });

const prodA  = readSheet(wbA, 'Products');
const prodB  = readSheet(wbB, 'Products');
const asgA   = readSheet(wbA, 'Products Assignment');
const asgB   = readSheet(wbB, 'Products Assignment');
const prA    = readSheet(wbA, 'Pricing Rules');
const prB    = readSheet(wbB, 'Pricing Rules');

const prodDiff  = diffRows(prodA.rows,  prodB.rows,  ['SKU'], new Set());
const asgDiff   = diffRows(asgA.rows,   asgB.rows,   ['SKU','Name']);
const priceDiff = diffRows(prA.rows,    prB.rows,    ['SKU','Name'], new Set());

// ── Styling ───────────────────────────────────────────────────────────────────
const COLORS = {
  REMOVED:  'FFFDE8E8',
  ADDED:    'FFE8F5E9',
  BEFORE:   'FFFFF8E1',
  AFTER:    'FFFFE0B2',
  HEADER:   'FF1E3A8A',
  SUBHDR:   'FFdBeafe',
  WHITE:    'FFFFFFFF',
  GRAY_ROW: 'FFf9fafb',
};

const b = { style: 'thin', color: { argb: 'FFe5e7eb' } };
const BORDER = { top: b, left: b, bottom: b, right: b };

function hdr(bgArgb) {
  return {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    border: BORDER,
  };
}
function cell(bgArgb, bold) {
  return {
    font: { size: 10, bold: !!bold },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } },
    alignment: { vertical: 'middle', wrapText: true },
    border: BORDER,
  };
}
function subhdr() {
  return {
    font: { bold: true, size: 10, color: { argb: 'FF1e3a8a' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.SUBHDR } },
    alignment: { vertical: 'middle' },
    border: BORDER,
  };
}

function applyRow(ws, rowNum, values, style, height) {
  const row = ws.getRow(rowNum);
  row.height = height || 20;
  values.forEach((v, i) => {
    const c = row.getCell(i + 1);
    c.value = v;
    Object.assign(c, style);
  });
  row.commit();
}

function boldCell(ws, rowNum, colNum) {
  const c = ws.getRow(rowNum).getCell(colNum);
  c.font = { ...c.font, bold: true, size: 10 };
}

(async () => {
  const outWb = new ExcelJS.Workbook();
  outWb.creator = 'DealHub Compare';

  // ══════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════
  const sw = outWb.addWorksheet('Summary');
  sw.views = [{ showGridLines: false }];
  sw.columns = [
    { width: 36 }, { width: 14 }, { width: 14 }, { width: 50 },
  ];

  let r = 1;
  sw.mergeCells(r, 1, r, 4);
  Object.assign(sw.getCell(r, 1), {
    value: `Cynet Sandbox  ·  Product Comparison  ·  ${VA}  vs  ${VB}`,
    style: { font: { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }, fill: { type:'pattern', pattern:'solid', fgColor:{ argb: COLORS.HEADER } }, alignment: { horizontal:'center', vertical:'middle' } },
  });
  sw.getRow(r).height = 36; r++;

  sw.mergeCells(r, 1, r, 4);
  Object.assign(sw.getCell(r, 1), {
    value: `Generated ${new Date().toISOString().slice(0,10)}  ·  service-eu1.dealhub.io`,
    style: { font:{ size:10, color:{argb:'FF6b7280'}, italic:true }, alignment:{ horizontal:'center' }, fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FFf3f4f6'}} },
  });
  sw.getRow(r).height = 18; r += 2;

  function sumSection(title, rows) {
    sw.mergeCells(r, 1, r, 4);
    Object.assign(sw.getCell(r, 1), { value: title, style: hdr('FF374151') });
    sw.getRow(r).height = 22; r++;

    for (const [label, val, note, valColor] of rows) {
      const bg = COLORS.GRAY_ROW;
      Object.assign(sw.getCell(r, 1), { value: label, style: cell(bg) });
      Object.assign(sw.getCell(r, 2), {
        value: val,
        style: { font:{ bold:true, size:10, color:{ argb: valColor||'FF374151' } }, fill:{type:'pattern',pattern:'solid',fgColor:{argb:bg}}, alignment:{ horizontal:'center',vertical:'middle' }, border:BORDER },
      });
      sw.mergeCells(r, 3, r, 4);
      Object.assign(sw.getCell(r, 3), {
        value: note||'',
        style: { font:{ size:9, italic:true, color:{argb:'FF6b7280'} }, fill:{type:'pattern',pattern:'solid',fgColor:{argb:bg}}, alignment:{vertical:'middle',wrapText:true}, border:BORDER },
      });
      sw.getRow(r).height = 18; r++;
    }
    r++;
  }

  sumSection('📦  PRODUCTS', [
    [`Total in ${VA}`,   prodA.rows.length,  '', 'FF374151'],
    [`Total in ${VB}`,   prodB.rows.length,  '', 'FF374151'],
    [`Removed in ${VB}`, prodDiff.onlyA.length, prodDiff.onlyA.map(x=>x.SKU+' ('+x.NAME+')').join(', '), 'FFdc2626'],
    [`Added in ${VB}`,   prodDiff.onlyB.length, prodDiff.onlyB.map(x=>x.SKU).join(', ')||'—', 'FF16a34a'],
    ['Changed',          prodDiff.changed.length, prodDiff.changed.map(c=>`${c.a.SKU}: ${c.diffs.join(', ')}`).join(' | '), 'FFd97706'],
    ['Unchanged',        prodDiff.same.length, '', 'FF6b7280'],
  ]);

  sumSection('🔗  PRODUCT ASSIGNMENTS', [
    [`Total in ${VA}`,   asgA.rows.length,  '', 'FF374151'],
    [`Total in ${VB}`,   asgB.rows.length,  '', 'FF374151'],
    [`Removed in ${VB}`, asgDiff.onlyA.length, asgDiff.onlyA.map(x=>`${x.SKU} / ${x.Name}`).join(', '), 'FFdc2626'],
    [`Added in ${VB}`,   asgDiff.onlyB.length, '—', 'FF16a34a'],
    ['Order changed',    asgDiff.changed.length, asgDiff.changed.map(c=>`${c.a.SKU} / ${c.a.Name}`).join(', '), 'FFd97706'],
    ['Columns dropped',  '7', `${VB} removed: Current Renewal Uplift, Downsell Amt/%, Previous Renewal Amt, Renewal/Expansion/Uplift Total`, 'FF6b7280'],
  ]);

  sumSection('💰  PRICING RULES', [
    [`Total in ${VA}`,   prA.rows.length,  '', 'FF374151'],
    [`Total in ${VB}`,   prB.rows.length,  '', 'FF374151'],
    [`Removed in ${VB}`, priceDiff.onlyA.length, 'All-In-One_EB tiers (25 rules) + All-In-One/Flat Renewal _copy', 'FFdc2626'],
    [`Added in ${VB}`,   priceDiff.onlyB.length, 'Platinum Credential Theft Monitoring MSP Upsell (10) + Protect/100-299 EPs Reseller', 'FF16a34a'],
    ['Changed',          priceDiff.changed.length, priceDiff.changed.map(c=>`${c.a.SKU} / ${c.a.Name}: ${c.diffs.join(', ')}`).join(' | '), 'FFd97706'],
    ['Unchanged',        priceDiff.same.length, '', 'FF6b7280'],
  ]);

  // ══════════════════════════════════════════════════════════════
  // PRODUCTS sheet
  // ══════════════════════════════════════════════════════════════
  const pw = outWb.addWorksheet('Products');
  pw.views = [{ showGridLines: false }];
  const prodCols = ['STATUS','SKU','NAME','Type','Primary TAG','TAGS','Package - For PB Product Selection','MANUAL MODIFICATION'];
  pw.columns = [14,22,30,12,18,34,36,14].map((w,i) => ({ header: prodCols[i], width: w }));
  applyRow(pw, 1, prodCols, hdr(COLORS.HEADER), 24);

  let pr = 2;

  if (prodDiff.onlyA.length) {
    pw.mergeCells(pr, 1, pr, prodCols.length);
    Object.assign(pw.getCell(pr,1), { value: `▼  Removed in ${VB}  (${prodDiff.onlyA.length})`, style: subhdr() });
    pw.getRow(pr).height = 18; pr++;
    for (const row of prodDiff.onlyA) {
      applyRow(pw, pr, prodCols.map(h => h==='STATUS'?`Removed in ${VB}`: row[h]||''), cell(COLORS.REMOVED));
      pr++;
    }
    pr++;
  }

  if (prodDiff.onlyB.length) {
    pw.mergeCells(pr, 1, pr, prodCols.length);
    Object.assign(pw.getCell(pr,1), { value: `▲  Added in ${VB}  (${prodDiff.onlyB.length})`, style: subhdr() });
    pw.getRow(pr).height = 18; pr++;
    for (const row of prodDiff.onlyB) {
      applyRow(pw, pr, prodCols.map(h => h==='STATUS'?`Added in ${VB}`: row[h]||''), cell(COLORS.ADDED));
      pr++;
    }
    pr++;
  }

  if (prodDiff.changed.length) {
    pw.mergeCells(pr, 1, pr, prodCols.length);
    Object.assign(pw.getCell(pr,1), { value: `✏  Changed  (${prodDiff.changed.length})`, style: subhdr() });
    pw.getRow(pr).height = 18; pr++;
    for (const { a, b, diffs } of prodDiff.changed) {
      applyRow(pw, pr, prodCols.map(h => h==='STATUS'?`${VA} — before`: a[h]||''), cell(COLORS.BEFORE));
      applyRow(pw, pr+1, prodCols.map(h => h==='STATUS'?`${VB} — after`: b[h]||''), cell(COLORS.AFTER));
      diffs.forEach(f => {
        const ci = prodCols.indexOf(f) + 1;
        if (ci > 0) { boldCell(pw, pr, ci); boldCell(pw, pr+1, ci); }
      });
      pr += 2; pr++;
    }
  }

  pw.mergeCells(pr, 1, pr, prodCols.length);
  Object.assign(pw.getCell(pr,1), { value: `✔  Unchanged  (${prodDiff.same.length})`, style: subhdr() });
  pw.getRow(pr).height = 18; pr++;
  for (const row of prodDiff.same) {
    applyRow(pw, pr, prodCols.map(h => h==='STATUS'?'Unchanged': row[h]||''), cell(COLORS.WHITE));
    pr++;
  }

  pw.getRow(1).freeze = true;
  pw.autoFilter = { from: 'A1', to: `${String.fromCharCode(64+prodCols.length)}1` };

  // ══════════════════════════════════════════════════════════════
  // ASSIGNMENTS sheet
  // ══════════════════════════════════════════════════════════════
  const aw = outWb.addWorksheet('Product Assignments');
  aw.views = [{ showGridLines: false }];
  const asgCols = ['STATUS','SKU','Playbook','Name','Assignment','Order','Rule','Duration'];
  aw.columns = [14,26,12,28,14,7,56,36].map((w,i) => ({ width: w }));
  applyRow(aw, 1, asgCols, hdr(COLORS.HEADER), 24);

  let ar2 = 2;

  if (asgDiff.onlyA.length) {
    aw.mergeCells(ar2, 1, ar2, asgCols.length);
    Object.assign(aw.getCell(ar2,1), { value: `▼  Removed in ${VB}  (${asgDiff.onlyA.length})`, style: subhdr() });
    aw.getRow(ar2).height = 18; ar2++;
    for (const row of asgDiff.onlyA) {
      applyRow(aw, ar2, asgCols.map(h => h==='STATUS'?`Removed in ${VB}`: row[h]||''), cell(COLORS.REMOVED));
      ar2++;
    }
    ar2++;
  }

  if (asgDiff.changed.length) {
    aw.mergeCells(ar2, 1, ar2, asgCols.length);
    Object.assign(aw.getCell(ar2,1), { value: `✏  Order changed  (${asgDiff.changed.length})`, style: subhdr() });
    aw.getRow(ar2).height = 18; ar2++;
    for (const { a, b, diffs } of asgDiff.changed) {
      applyRow(aw, ar2,   asgCols.map(h => h==='STATUS'?`${VA} — before`: a[h]||''), cell(COLORS.BEFORE));
      applyRow(aw, ar2+1, asgCols.map(h => h==='STATUS'?`${VB} — after`:  b[h]||''), cell(COLORS.AFTER));
      diffs.forEach(f => {
        const ci = asgCols.indexOf(f)+1;
        if (ci>0) { boldCell(aw, ar2, ci); boldCell(aw, ar2+1, ci); }
      });
      ar2 += 3;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // PRICING RULES sheet
  // ══════════════════════════════════════════════════════════════
  const rw = outWb.addWorksheet('Pricing Rules');
  rw.views = [{ showGridLines: false }];
  const rCols = ['STATUS','SKU','Name','Playbook','Order','Price format','Currency'];
  rw.columns = [14,28,40,12,7,14,10].map((w,i) => ({ width: w }));
  applyRow(rw, 1, rCols, hdr(COLORS.HEADER), 24);

  let rr2 = 2;

  // Group removed by SKU
  const removedBySku = {};
  for (const row of priceDiff.onlyA) {
    const k = row.SKU||'(none)';
    (removedBySku[k] = removedBySku[k]||[]).push(row);
  }
  if (Object.keys(removedBySku).length) {
    rw.mergeCells(rr2, 1, rr2, rCols.length);
    Object.assign(rw.getCell(rr2,1), { value: `▼  Removed in ${VB}  (${priceDiff.onlyA.length} rules)`, style: subhdr() });
    rw.getRow(rr2).height = 18; rr2++;
    for (const [sku, rows] of Object.entries(removedBySku)) {
      for (const row of rows) {
        applyRow(rw, rr2, rCols.map(h => h==='STATUS'?`Removed in ${VB}`: row[h]||''), cell(COLORS.REMOVED));
        rr2++;
      }
    }
    rr2++;
  }

  const addedBySku = {};
  for (const row of priceDiff.onlyB) {
    const k = row.SKU||'(none)';
    (addedBySku[k] = addedBySku[k]||[]).push(row);
  }
  if (Object.keys(addedBySku).length) {
    rw.mergeCells(rr2, 1, rr2, rCols.length);
    Object.assign(rw.getCell(rr2,1), { value: `▲  Added in ${VB}  (${priceDiff.onlyB.length} rules)`, style: subhdr() });
    rw.getRow(rr2).height = 18; rr2++;
    for (const [sku, rows] of Object.entries(addedBySku)) {
      for (const row of rows) {
        applyRow(rw, rr2, rCols.map(h => h==='STATUS'?`Added in ${VB}`: row[h]||''), cell(COLORS.ADDED));
        rr2++;
      }
    }
    rr2++;
  }

  if (priceDiff.changed.length) {
    rw.mergeCells(rr2, 1, rr2, rCols.length);
    Object.assign(rw.getCell(rr2,1), { value: `✏  Changed  (${priceDiff.changed.length})`, style: subhdr() });
    rw.getRow(rr2).height = 18; rr2++;
    for (const { a, b, diffs } of priceDiff.changed) {
      applyRow(rw, rr2,   rCols.map(h => h==='STATUS'?`${VA} — before`: a[h]||''), cell(COLORS.BEFORE));
      applyRow(rw, rr2+1, rCols.map(h => h==='STATUS'?`${VB} — after`:  b[h]||''), cell(COLORS.AFTER));
      diffs.forEach(f => {
        const ci = rCols.indexOf(f)+1;
        if (ci>0) { boldCell(rw, rr2, ci); boldCell(rw, rr2+1, ci); }
      });
      rr2 += 3;
    }
  }

  rw.mergeCells(rr2, 1, rr2, rCols.length);
  Object.assign(rw.getCell(rr2,1), { value: `✔  Unchanged  (${priceDiff.same.length} rules)`, style: subhdr() });
  rw.getRow(rr2).height = 18; rr2++;
  for (const row of priceDiff.same) {
    applyRow(rw, rr2, rCols.map(h => h==='STATUS'?'Unchanged': row[h]||''), cell(COLORS.WHITE));
    rr2++;
  }

  // ── Write ──────────────────────────────────────────────────────
  const OUT = path.join(os.homedir(), 'Downloads', `Cynet_Products_${VA}_vs_${VB}_CLEAN.xlsx`);
  await outWb.xlsx.writeFile(OUT);
  console.log('Written →', OUT);
})();
