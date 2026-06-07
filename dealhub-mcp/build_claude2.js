#!/usr/bin/env node
/**
 * Builds "Claude 2" — full iConnections Order Form template (3 pages)
 * Sections: header info, order details, what's included, 2× pricing tables,
 *           grand total, notes, general terms, signature
 */

const { request: pwRequest } = require('playwright');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const BASE_URL     = 'https://poc.dealhub.io';
const SESSION_FILE = path.join(__dirname, 'session_state.json');
const PLAYBOOK     = '2b7fE5300233940A';
const VERSION      = '238a077587a3EAcC';
const DOC_NAME     = 'Claude 2';

function dhId() { return (Date.now() + Math.floor(Math.random() * 9999)).toString(); }

function gzip(obj) {
  return new Promise((ok, fail) =>
    zlib.gzip(Buffer.from(JSON.stringify(obj), 'utf8'), (e, b) => e ? fail(e) : ok(b))
  );
}

// ── Part builders ─────────────────────────────────────────────────────────────

function textPart(title, html, condition) {
  const id  = dhId();
  const cid = dhId();
  return {
    guid: id, selectedGuid: cid,
    template: 'docComposerTextSection.html',
    expanded: true, shown: true, title, type: 'TEXT', includePageNumber: false,
    content: [{ guid: cid, title, desc: html, url: '', condition: condition ?? null,
      pageBreakAfter: false, footerHR: false, lockedForChanges: false }],
  };
}

const ALL_COLS = [
  { label: 'ORDINAL',              displayName: 'Ordinal',            hA: 'LEFT', bA: 'RIGHT' },
  { label: 'GROUP',                displayName: 'Group',              hA: 'LEFT', bA: 'LEFT'  },
  { label: 'ITEM_NAME',            displayName: 'Item Name',          hA: 'LEFT', bA: 'LEFT'  },
  { label: 'DESCRIPTION',          displayName: 'Description',        hA: 'LEFT', bA: 'LEFT'  },
  { label: 'SKU',                  displayName: 'SKU',                hA: 'LEFT', bA: 'LEFT'  },
  { label: 'TAG',                  displayName: 'Primary Tag',        hA: 'LEFT', bA: 'LEFT'  },
  { label: 'BASE_PRICE',           displayName: 'List Price/Unit',    hA: 'LEFT', bA: 'RIGHT' },
  { label: 'DURATION',             displayName: 'Duration',           hA: 'LEFT', bA: 'RIGHT' },
  { label: 'QUANTITY',             displayName: 'Quantity',           hA: 'LEFT', bA: 'RIGHT' },
  { label: 'IS_RENEWABLE',         displayName: 'Is Renewable',       hA: 'LEFT', bA: 'LEFT'  },
  { label: 'START_DATE',           displayName: 'Start Date',         hA: 'LEFT', bA: 'LEFT'  },
  { label: 'END_DATE',             displayName: 'End Date',           hA: 'LEFT', bA: 'LEFT'  },
  { label: 'NUMBER',               displayName: 'Number',             hA: 'LEFT', bA: 'RIGHT' },
  { label: 'MULTIPLY_ALL_FACTORS', displayName: 'Total Quantity',     hA: 'LEFT', bA: 'RIGHT' },
  { label: 'LIST_PRICE',           displayName: 'List Price',         hA: 'LEFT', bA: 'RIGHT' },
  { label: 'POSITIVE_LIST_PRICE',  displayName: 'Positive List Price',hA: 'LEFT', bA: 'RIGHT' },
  { label: 'NEGATIVE_LIST_PRICE',  displayName: 'Negative List Price',hA: 'LEFT', bA: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT',   displayName: 'Promotions',         hA: 'LEFT', bA: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT_PRCT', displayName: 'Promotions %',   hA: 'LEFT', bA: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT',     displayName: 'Special Discount',   hA: 'LEFT', bA: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT_PRCT',displayName: 'Special Disc %',     hA: 'LEFT', bA: 'RIGHT' },
  { label: 'USER_DISCOUNT',        displayName: 'Sales Discount',     hA: 'LEFT', bA: 'RIGHT' },
  { label: 'USER_DISCOUNT_PRCT',   displayName: 'Sales Disc %',       hA: 'LEFT', bA: 'RIGHT' },
  { label: 'DISCOUNT_PRCT',        displayName: 'Discount %',         hA: 'LEFT', bA: 'RIGHT' },
  { label: 'DISCOUNT_$',           displayName: 'Discount $',         hA: 'LEFT', bA: 'RIGHT' },
  { label: 'NET_PRICE',            displayName: 'Total',              hA: 'LEFT', bA: 'RIGHT' },
  { label: 'NET_PRICE_PER_UNIT',   displayName: 'Net Price / Unit',   hA: 'LEFT', bA: 'RIGHT' },
  { label: 'MSRP',                 displayName: 'MSRP',               hA: 'LEFT', bA: 'RIGHT' },
  { label: 'MSRP_DISCOUNT',        displayName: 'MSRP Discount',      hA: 'LEFT', bA: 'RIGHT' },
].map(c => ({
  active: false, cellWidth: 0, displayName: c.displayName, displayFirstName: null,
  displaySecondName: null, label: c.label, ordinal: 0, sortable: true,
  groupColumnType: 'EMPTY', groupColumnFreeText: '', groupColumnFormula: '',
  displayFirstData: null, displaySecondData: null, presentationRule: 'false',
  cellDataWidth: 0, cellHeight: 0, maxCellHeight: 0,
  headerAlign: c.hA, bodyAlign: c.bA,
  totalsRowLabel: 'N/A', showInTotalsRow: false, enableSummarizeInTotalsRow: false,
}));

function tablePart(title, activeLabels, nameOverrides = {}, showDiscount = false) {
  const id = dhId(); const partId = dhId();
  const cols = ALL_COLS.map(c => ({
    ...c,
    active: activeLabels.includes(c.label),
    displayName: nameOverrides[c.label] || c.displayName,
  }));
  return {
    guid: id, selectedGuid: '', template: 'docComposerTableSection.html',
    expanded: true, shown: true, title, type: 'TABLE', tableType: 'PRODUCTS_TABLE',
    includePageNumber: false,
    tableParts: [{
      guid: partId, title: 'Pricing Table', condition: 'true',
      usePresentationRule: false, subject: '',
      showTotalListPrice: false, totalListPriceName: 'Total List Price',
      showDiscount, discountName: 'Discount', discountType: 'DISCOUNT_PRCT',
      showTotalNegativePrice: false, totalNegativePriceName: 'Total Negative Price',
      showTotalNetPrice: true, totalNetPriceName: 'Total Net Price',
      showTablePerType: false, content: cols,
    }],
  };
}

// ── HTML content ──────────────────────────────────────────────────────────────

const CELL_H = 'background:#4a4a4a;color:#fff;font-weight:bold;padding:7px 10px;font-size:11px;font-family:Arial,sans-serif;border:1px solid #ccc;';
const CELL_V = 'padding:7px 10px;font-size:11px;font-family:Arial,sans-serif;border:1px solid #ccc;background:#fff;';

const ORDER_HEADER_HTML = `
<table style="width:800px;border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px;">
  <tr>
    <td style="width:400px;vertical-align:top;padding:4px 0;">
      <strong style="font-size:13px;color:#5b2d8e;">iConnections, LLC</strong><br/>
      930 Merion Square Road<br/>Gladwyne, PA 19035
    </td>
    <td style="width:400px;vertical-align:top;text-align:right;padding:4px 0;">
      <strong>Order Form</strong><br/>
      %OPPORTUNITY_NAME%<br/>
      Issued %DATE%<br/>
      Expires %General.ExpirationDate%
    </td>
  </tr>
</table>`;

const ORDER_DETAILS_HTML = `
<table style="width:800px;border-collapse:collapse;">
  <tr>
    <td style="${CELL_H}width:200px;">Client Name</td>
    <td style="${CELL_V}width:200px;">%OPPORTUNITY_ACCOUNT%</td>
    <td style="${CELL_H}width:200px;">Term</td>
    <td style="${CELL_V}width:200px;">%GQ.Duration%</td>
  </tr>
  <tr>
    <td style="${CELL_H}">Client Firm AUM</td>
    <td style="${CELL_V}"></td>
    <td style="${CELL_H}">Contract Period</td>
    <td style="${CELL_V}">%GQ.Start_Date% &ndash; %GQ.End_Date%</td>
  </tr>
  <tr>
    <td style="${CELL_H}">Contract Type</td>
    <td style="${CELL_V}">%GQ.Opp_Type%</td>
    <td style="${CELL_H}">Sponsorship Included</td>
    <td style="${CELL_V}"></td>
  </tr>
  <tr>
    <td style="${CELL_H}">Prepared By</td>
    <td style="${CELL_V}">%USER_FULLNAME%</td>
    <td style="${CELL_H}">Billing Frequency</td>
    <td style="${CELL_V}"></td>
  </tr>
  <tr>
    <td style="${CELL_H}">Sales Manager</td>
    <td style="${CELL_V}">%OWNER_FULLNAME%</td>
    <td style="${CELL_H}">Net Terms</td>
    <td style="${CELL_V}"></td>
  </tr>
</table>`;

const TH = 'background:#5b2d8e;color:#fff;font-weight:bold;padding:8px 12px;font-size:11px;font-family:Arial,sans-serif;text-align:left;border:1px solid #5b2d8e;';
const TD_ALT = 'padding:7px 12px;font-size:11px;font-family:Arial,sans-serif;border:1px solid #ddd;background:#f3eefe;';
const TD     = 'padding:7px 12px;font-size:11px;font-family:Arial,sans-serif;border:1px solid #ddd;background:#fff;';

const WHATS_INCLUDED_HTML = `
<p style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#5b2d8e;margin:0 0 4px 0;">iConnections Established</p>
<p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;margin:0 0 8px 0;">What&rsquo;s Included</p>
<table style="width:800px;border-collapse:collapse;">
  <thead>
    <tr>
      <th style="${TH}width:240px;">Category</th>
      <th style="${TH}">Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="${TD_ALT}">Meetings</td>
      <td style="${TD_ALT}">2 live Cap Intro Experience</td>
    </tr>
    <tr>
      <td style="${TD}">Platform Features</td>
      <td style="${TD}">Full &ndash; Unlimited Digital Fund Profiles and 3 Platform Users</td>
    </tr>
    <tr>
      <td style="${TD_ALT}">Event Features</td>
      <td style="${TD_ALT}">2 Marketed Funds at Event, Attendee Count by Event (see below)</td>
    </tr>
  </tbody>
</table>`;

const GRAND_TOTAL_HTML = `
<table style="width:400px;border-collapse:collapse;margin-left:auto;font-family:Arial,sans-serif;font-size:11px;">
  <tr>
    <td style="padding:7px 12px;border:1px solid #ddd;background:#f9f9f9;">Total List</td>
    <td style="padding:7px 12px;border:1px solid #ddd;text-align:right;background:#f9f9f9;"></td>
  </tr>
  <tr>
    <td style="padding:7px 12px;border:1px solid #ddd;">Discount</td>
    <td style="padding:7px 12px;border:1px solid #ddd;text-align:right;"></td>
  </tr>
  <tr>
    <td style="padding:7px 12px;border:1px solid #ddd;font-weight:bold;background:#f3eefe;">Grand Total</td>
    <td style="padding:7px 12px;border:1px solid #ddd;font-weight:bold;text-align:right;background:#f3eefe;"></td>
  </tr>
</table>`;

const NOTES_HTML = `
<p style="font-family:Arial,sans-serif;font-size:10px;color:#888;margin:0 0 4px 0;">Notes / Special Customizations</p>
<p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;margin:0 0 8px 0;">Package:</p>

<p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;margin:8px 0 4px 0;">Global Alts NY 2026 June 9-10, 2026 &ndash; Bronze Sponsor</p>
<ul style="font-family:Arial,sans-serif;font-size:11px;margin:0 0 12px 16px;padding:0;line-height:1.8;">
  <li>Premium 6 X 8 Sponsorship Kiosk</li>
  <li>Dedicated networking and meeting area</li>
  <li>Power and Electricity included</li>
  <li>Access to schedule 1:1 meetings on the iConnections platform</li>
  <li>2 Full Access Passes for Global Alts NY 2026</li>
  <li>Bronze Sponsor Branding on site</li>
  <li>Additional branding and visibility &ndash; websites, signage, social media</li>
</ul>

<p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;margin:8px 0 4px 0;">Global Alts Miami 2027, February 22-25, 2027 &ndash; Contributing Sponsor</p>
<ul style="font-family:Arial,sans-serif;font-size:11px;margin:0 0 12px 16px;padding:0;line-height:1.8;">
  <li>Premium 6 X 8 Sponsorship Meeting Suite</li>
  <li>Dedicated networking and meeting area</li>
  <li>Power and Electricity included</li>
  <li>Access to schedule 1:1 meetings on the iConnections platform</li>
  <li>3 Full Access Passes for Global Alts Miami 2027</li>
  <li>Additional branding and visibility &ndash; websites, signage, social media</li>
</ul>`;

const TERMS_HTML = `
<p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;margin:0 0 8px 0;">General Terms</p>
<p style="font-family:Arial,sans-serif;font-size:11px;line-height:1.6;margin:0 0 10px 0;">
This Order Form incorporates the iConnections <strong>Master Terms</strong> at www.iconnections.io/MSA, together with any
addenda referenced herein. In the event of any conflict between this Order Form and the Master Terms, this
Order Form shall control solely with respect to the subject matter of this Order Form. Any Special Terms shall
supersede conflicting provisions in the Master Terms.
</p>
<p style="font-family:Arial,sans-serif;font-size:11px;line-height:1.6;margin:0 0 10px 0;">
Customer acknowledges that its Authorized Users will be subject to the iConnections <strong>Terms of Service</strong>
(available at www.iconnections.io/legal) upon accessing the Platform.
</p>
<p style="font-family:Arial,sans-serif;font-size:11px;line-height:1.6;margin:0;">
The terms of this quote expire at <strong>11:00 PM ET on %General.ExpirationDate%</strong>.
</p>
<p style="font-family:Arial,sans-serif;font-size:11px;line-height:1.6;margin:10px 0 0 0;">
By signing below, the undersigned agree to the pricing package and the terms set forth herein.
</p>`;

const FOOTER_HTML = `
<p style="font-size:9px;color:#888;text-align:center;font-family:Arial,sans-serif;margin:0;">
Information provided in this quote is confidential and cannot be distributed without written authorization from iConnections LLC.
&nbsp;&nbsp;&nbsp;2026 iConnections LLC, all rights reserved
</p>`;

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const ctx = await pwRequest.newContext({
    baseURL: BASE_URL,
    storageState,
    extraHTTPHeaders: { 'Accept': 'application/json', 'Origin': BASE_URL, 'Referer': BASE_URL + '/' },
  });

  // 1 — Create document
  console.log('Creating document "Claude 2"...');
  const docPayload = {
    guid: null, name: DOC_NAME, displayName: null, playbookGUID: PLAYBOOK,
    documentTypeGUID: null, externalFileGuid: null,
    comment: '', rule: '', assignType: 'ALWAYS', type: 'DOCUMENT',
    tagRelations: [], deletedDocumentTags: [],
    customFileNameTemplate: '%PROPOSAL_ID%', enableCustomFileName: null,
    changeLogRecords: [{ date: Date.now(), username: 'mcp-agent', userlogin: 'mcp@dealhub.io',
      impersonatorUserName: null, impersonatorDealhubUser: false, dealhubUser: true,
      action: 'New', object: 'Output Document', objectName: DOC_NAME,
      subObject: '', subObjectName: '', attribute: '', attributeName: '', fromValue: '', toValue: '' }],
    versionGUID: VERSION,
  };
  const createRes = await ctx.post('/outputdoc/createOrUpdate', { multipart: { outputDocument: JSON.stringify(docPayload) } });
  const docGUID   = (await createRes.text()).replace(/"/g, '').trim();
  console.log('Created GUID:', docGUID);

  // 2 — Fetch skeleton
  const getRes = await ctx.get(`/outputData/edit?guid=${docGUID}&versionGUID=${VERSION}`);
  const state  = await getRes.json();
  const pages  = typeof state.outputData === 'string' ? JSON.parse(state.outputData) : state.outputData;

  // 3 — Footer
  const hf     = pages.sections.find(s => s.title === 'Header_and_footer');
  const footer = hf?.parts.find(p => p.guid === 'footer');
  if (footer?.content?.[0]) footer.content[0].desc = FOOTER_HTML;

  // 4 — Body: replace placeholder with full 8 sections
  const body = pages.sections.find(s => s.title === 'Body');
  body.parts = [
    textPart('Order Form Header',   ORDER_HEADER_HTML),
    textPart('Order Form Details',  ORDER_DETAILS_HTML),
    textPart("What's Included",     WHATS_INCLUDED_HTML),
    tablePart('Global Alts Miami 2027',    ['ITEM_NAME', 'QUANTITY', 'NET_PRICE'], { NET_PRICE: 'Total' }),
    tablePart('Global Alts New York 2026', ['ITEM_NAME', 'QUANTITY', 'NET_PRICE'], { NET_PRICE: 'Total' }),
    textPart('Grand Total',         GRAND_TOTAL_HTML),
    textPart('Notes',               NOTES_HTML),
    textPart('General Terms',       TERMS_HTML),
    {
      guid: dhId(), selectedGuid: dhId(),
      template: 'docComposerSignatureSection.html',
      expanded: true, shown: true, title: 'Signature', type: 'SIGNATURE',
      signatories: ['BUYER', 'SELLER'], includePageNumber: false, content: [],
    },
  ];
  console.log('Built 9 body sections.');

  // 5 — Save
  const savePayload = {
    versionGUID:              VERSION,
    guid:                     state.outputDocGUID,
    pageSize:                 'LETTER',
    pageOrientation:          'PORTRAIT',
    pages,
    defaultTablePart:         null,
    isRTL:                    false,
    showOnce:                 false,
    wrapTablesWithLines:      true,
    marginTop:                60,
    marginBottom:             60,
    marginLeft:               60,
    marginRight:              60,
    coverPagePresentationRule: 'true',
    changeLogRecords: [{
      date: Date.now(), username: 'mcp-agent', userlogin: 'mcp@dealhub.io',
      impersonatorUserName: null, impersonatorDealhubUser: false, dealhubUser: true,
      action: 'Modification', object: 'Output Document', objectName: DOC_NAME,
      subObject: '', subObjectName: '', attribute: '', attributeName: '', fromValue: '', toValue: '',
    }],
  };

  console.log('Saving...');
  const buf     = await gzip(savePayload);
  const saveRes = await ctx.post('/outputData/save', {
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    data: buf,
  });
  console.log(`Save → ${saveRes.status()}`);
  if (saveRes.status() === 200) {
    console.log(`\n✓ "Claude 2" created successfully!`);
    console.log(`  GUID: ${docGUID}`);
    console.log(`  URL:  ${BASE_URL}/#/docComposer?versionGUID=${VERSION}&docName=${encodeURIComponent(DOC_NAME)}&docGUID=${docGUID}`);
  } else {
    console.log('Error:', await saveRes.text());
  }

  await ctx.dispose();
})().catch(e => { console.error(e); process.exit(1); });
