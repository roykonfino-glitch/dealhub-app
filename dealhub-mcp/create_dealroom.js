'use strict';
const zlib = require('zlib');
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { buildDrData } = require('./dealroom_builder');

const WEBSITE      = process.argv[2];
const VERSION_NAME = process.argv[3];
const DR_NAME      = process.argv[4] || '';

if (!WEBSITE || !VERSION_NAME) {
  console.error('Usage: node create_dealroom.js <website-url> <version-name> [dealroom-name]');
  process.exit(1);
}

const HOST = 'poc.dealhub.io';
const BASE = `https://${HOST}`;

// ── Brand extraction ──────────────────────────────────────────────────────────

async function extractBrand(page, url) {
  console.log(`\nScraping brand from ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  const brand = await page.evaluate(() => {
    // ── Company name ────────────────────────────────────────────────────────
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    const companyName = ogSite
      ? ogSite.content
      : document.title.split(/[-|–|·]/)[0].trim();

    // ── Tagline from H1 ─────────────────────────────────────────────────────
    const h1 = document.querySelector('h1');
    const tagline = h1 ? h1.innerText.trim().slice(0, 150) : '';

    // ── Logo: prefer header/nav logo, skip tiny icons ────────────────────────
    const logoSelectors = [
      'header img[src*="logo"]', 'header img[alt*="logo" i]',
      'nav img[src*="logo"]',    'nav img[alt*="logo" i]',
      '.header img[src*="logo"]','.navbar-brand img',
      'a[href="/"] img',         'a[href="./"] img',
      'header img',              'nav img',
    ];
    let logoUrl = null;
    for (const sel of logoSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const src = el.src || el.getAttribute('src') || '';
        // Skip tiny icons (grid.svg, favicon, etc.) and customer logos
        if (src && !src.match(/grid|icon|favicon|customer|partner|sprite/i) &&
            (el.naturalWidth > 50 || el.naturalWidth === 0)) {
          logoUrl = src;
          break;
        }
      }
    }

    // ── Hero image: first large non-logo image ───────────────────────────────
    const heroSelectors = [
      '[class*="hero"] img:not([src*="logo"])',
      '[class*="banner"] img:not([src*="logo"])',
      'section:first-of-type img:not([src*="logo"])',
      'main > * img:not([src*="logo"]):not([src*="icon"])',
    ];
    let heroUrl = null;
    for (const sel of heroSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const src = el.src || el.getAttribute('src') || '';
        if (src && !src.match(/customer|partner|logo|icon|sprite|grid/i)) {
          heroUrl = src;
          break;
        }
      }
    }

    // OG image as fallback for hero
    if (!heroUrl) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg) heroUrl = ogImg.content;
    }

    // ── Primary color: from CTA buttons, links, or CSS variables ─────────────
    let primaryColor = null;

    // Try CSS variables first
    const rootStyle = getComputedStyle(document.documentElement);
    for (const v of ['--primary','--color-primary','--brand-color','--accent','--cta-color','--main-color']) {
      const val = rootStyle.getPropertyValue(v).trim();
      if (val && val !== '') { primaryColor = val; break; }
    }

    // Try buttons/CTAs
    if (!primaryColor) {
      const ctaSelectors = ['a.btn-primary','button[class*="primary"]','.btn-primary','[class*="cta"]',
        'a[class*="button"]','button:not([class*="ghost"]):not([class*="outline"])'];
      for (const sel of ctaSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && !bg.includes('0, 0, 0, 0') && bg !== 'transparent' &&
            !bg.startsWith('rgba(0') && !bg.startsWith('rgb(255,255,255')) {
          primaryColor = bg;
          break;
        }
      }
    }

    // Try anchor/link colors
    if (!primaryColor) {
      const a = document.querySelector('a:not([class])');
      if (a) {
        const c = getComputedStyle(a).color;
        if (c && !c.includes('0, 0, 0')) primaryColor = c;
      }
    }

    if (!primaryColor) primaryColor = '#000000';

    // ── Background color ─────────────────────────────────────────────────────
    const heroSection = document.querySelector('[class*="hero"],[class*="banner"],header,section');
    const bgColor = heroSection
      ? getComputedStyle(heroSection).backgroundColor
      : getComputedStyle(document.body).backgroundColor;

    return { logoUrl, heroUrl, tagline, primaryColor, companyName, bgColor };
  });

  console.log('  Company:  ', brand.companyName);
  console.log('  Tagline:  ', brand.tagline);
  console.log('  Logo:     ', brand.logoUrl);
  console.log('  Hero:     ', brand.heroUrl);
  console.log('  Primary:  ', brand.primaryColor);
  console.log('  BG color: ', brand.bgColor);

  return brand;
}

// ── CSS rgb() → hex ───────────────────────────────────────────────────────────

function rgbToHex(rgb) {
  if (!rgb) return '#000000';
  if (rgb.startsWith('#')) return rgb;
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

// ── DealHub API helpers (in-browser request context) ─────────────────────────

async function dhGet(page, urlPath) {
  const res = await page.request.get(`${BASE}${urlPath}`, {
    headers: { Accept: 'application/json' }, timeout: 15000,
  });
  if (!res.ok()) { console.warn(`  WARN GET ${urlPath} → ${res.status()}`); return null; }
  return res.json();
}

async function dhPost(page, urlPath, body) {
  const jsonBuf  = Buffer.from(JSON.stringify(body), 'utf8');
  const gzipBuf  = zlib.gzipSync(jsonBuf);
  const res = await page.request.post(`${BASE}${urlPath}`, {
    headers: {
      'Content-Type':     'application/json',
      'Content-Encoding': 'gzip',
      'Accept':           'application/json, text/plain, */*',
    },
    data: gzipBuf,
    timeout: 15000,
  });
  if (!res.ok()) {
    const txt = await res.text();
    console.warn(`  WARN POST ${urlPath} → ${res.status()}: ${txt.slice(0, 200)}`);
    return null;
  }
  const txt = await res.text();
  if (!txt || !txt.trim()) return { ok: true };
  try { return JSON.parse(txt); } catch { return { ok: true, raw: txt.slice(0, 100) }; }
}

// ── (builder now in dealroom_builder.js) ─────────────────────────────────────

function buildDealRoomData(brand, primaryHex) {
  const logoObj = brand.logoUrl ? {
    type: 'OutputDocument', url: brand.logoUrl, guid: '', name: 'logo',
    accountGUID: 0, archived: false, uploadDate: '', imageFileName: '', width: 0, height: 0,
    uploadedSizes: null, thumbnailURL: brand.logoUrl,
  } : null;

  const heroObj = brand.heroUrl ? {
    type: 'OutputDocument', url: brand.heroUrl, guid: '', name: 'hero',
    accountGUID: 0, archived: false, uploadDate: '', imageFileName: '', width: 0, height: 0,
    uploadedSizes: null, thumbnailURL: brand.heroUrl,
  } : null;

  const sections = [
    // ── Header ──────────────────────────────────────────────────────────────
    {
      type: 'header',
      ordinal: 0,
      selectedLayoutIndex: 0,
      showMode: 'preview',
      layouts: ['headerWidget1', 'headerWidget2', 'headerWidget3'],
      styles: {
        backgroundColor: '', borderColor: '',
        header: { borderRadius: '0', background: primaryHex },
        banner: { backgroundColor: primaryHex, opacity: '100' },
        widgetBackground: { image: '', size: 'cover', position: 'left' },
        text:  { fontFamily: 'Arial', color: '#000000', fontSize: '14' },
        title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
        btn:   { background: primaryHex, backgroundHover: primaryHex, borderColor: '#ccc',
                 borderColorHover: '#ccc', textColor: '#fff', textColorHover: '#fff',
                 fontSize: '14', borderWidth: '0', borderRadius: '8',
                 paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5' },
      },
      data: {
        uid: 'section_1',
        companyLogo: logoObj,
        backgroundImage: heroObj,
        mobileBackgroundImage: null,
        tagLine: `<p><strong><span style="color:#ffffff;">PROPOSAL FOR&nbsp;%OPPORTUNITY_ACCOUNT%</span></strong></p>`,
        contactName: '', contactEmail: '', contactPhone: '',
        buttonLabel: 'Click here', buttonLink: '', enableLinkButton: false,
        rtl: false, relevanceRule: 'true', isRuleValid: true, templateIndex: 1,
      },
    },
    // ── Welcome text ─────────────────────────────────────────────────────────
    {
      type: 'text',
      ordinal: 0,
      selectedLayoutIndex: 0,
      showMode: 'preview',
      title: 'Welcome',
      collapsedByDefault: true,
      showOnWeb: true,
      showOnMobile: true,
      rtl: false,
      limitHeight: false,
      maxHeight: 410,
      minHeight: '',
      mergeWithNext: false,
      backgroundImage: null,
      mobileBackgroundImage: null,
      layouts: ['textWidget1'],
      styles: {
        backgroundColor: '', borderColor: '', borderRadius: 6, borderWidth: '0',
        header: { borderRadius: '0', background: primaryHex },
        widgetBackground: { image: '', size: 'cover', position: 'left' },
        text:  { fontFamily: 'Arial', color: '#000000', fontSize: '14' },
        title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
        btn:   { background: primaryHex, backgroundHover: primaryHex, borderColor: '#ccc',
                 borderColorHover: '#ccc', textColor: '#fff', textColorHover: '#fff',
                 fontSize: '', borderWidth: '0', borderRadius: '8',
                 paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' },
      },
      data: {
        uid: 'section_3',
        title: 'Welcome',
        collapsedByDefault: true,
        limitHeight: false,
        maxHeight: 410,
        minHeight: 200,
        backgroundImage: null,
        mobileBackgroundImage: null,
        rtl: false,
        readMoreMode: false,
        text: '',
        textSections: [{
          id: 'text_2',
          name: 'Text 1',
          text: `<p>Dear %OPPORTUNITY_ACCOUNT%,</p><p><br/>Thank you for the opportunity to present this proposal. If you have any questions please let me know.</p><p>I look forward to hearing from you shortly.</p><p><br/>Sincerely,<br/>%USER_FULLNAME%<br/>%USER_BUSINESS_TITLE%</p>`,
          relevanceRule: 'true',
          isRuleValid: true,
          limitHeight: false,
          maxHeight: 410,
          readMoreMode: false,
        }],
      },
    },
    // ── Pricing table ────────────────────────────────────────────────────────
    {
      type: 'pricingTable',
      ordinal: 0,
      selectedLayoutIndex: 0,
      showMode: 'preview',
      layouts: ['pricingTableWidget1'],
      styles: {
        backgroundColor: '', borderColor: '',
        header: { borderRadius: '0', background: primaryHex },
        widgetBackground: { image: '', size: 'cover', position: 'left' },
        text:  { fontFamily: 'Arial', color: '#000000', fontSize: '14' },
        title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
        btn:   { background: primaryHex, backgroundHover: primaryHex, borderColor: '#ccc',
                 borderColorHover: '#ccc', textColor: '#fff', textColorHover: '#fff',
                 fontSize: '14', borderWidth: '0', borderRadius: '8',
                 paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5' },
      },
      data: {
        uid: 'section_5',
        title: 'Pricing',
        collapsedByDefault: false,
        isSharedElement: false,
        noVerticalScroll: false,
        rtl: false,
        tables: [{
          title: 'Pricing Table',
          headerBackgroundColor: '#fff',
          headerTextColor: '#000',
          borderColor: '#ccc',
          totalListLabel: 'Total List Price:',
          totalNetLabel: 'Total Net Price:',
          totalDiscountPrct: 0,
          totalDiscountPrice: 0,
          showBundleRows: { id: 'BOTH', text: 'Both' },
          showBundlePricing: { id: 'BOTH', text: 'Both' },
          groupLineItemsDef: { enable: false, customHeader: '', customText: '', proposalAttributeName: null },
          tableCols: [
            { label: 'ITEM_NAME', displayName: 'Name', mapTo: 'name', active: true, type: 'random.word', align: 'left', headerAlign: 'left', width: 0, idx: 0, sort: '', presentationRule: 'false', isPresentationRuleValid: true, showInTotalsRow: false, enableSummarizeInTotalsRow: false, groupColumnSettings: { formulaValid: true, freeText: '', formula: '', type: { id: null, label: 'N/A' } } },
            { label: 'ITEM_DESCRIPTION', displayName: 'Description', mapTo: 'description', active: false, type: 'random.word', align: 'left', headerAlign: 'left', width: 0, idx: 1, sort: '', presentationRule: 'false', isPresentationRuleValid: true, showInTotalsRow: false, enableSummarizeInTotalsRow: false, groupColumnSettings: { formulaValid: true, freeText: '', formula: '', type: { id: null, label: 'N/A' } } },
            { label: 'ITEM_QUANTITY', displayName: 'Qty', mapTo: 'quantity', active: true, type: 'random.number', align: 'right', headerAlign: 'left', width: 0, idx: 2, sort: '', presentationRule: 'false', isPresentationRuleValid: true, showInTotalsRow: false, enableSummarizeInTotalsRow: false, groupColumnSettings: { formulaValid: true, freeText: '', formula: '', type: { id: null, label: 'N/A' } } },
            { label: 'NET_PRICE', displayName: 'Price', mapTo: 'netPrice', active: true, type: 'random.number', align: 'right', headerAlign: 'left', width: 0, idx: 3, sort: '', presentationRule: 'false', isPresentationRuleValid: true, showInTotalsRow: true, enableSummarizeInTotalsRow: true, groupColumnSettings: { formulaValid: true, freeText: '', formula: '', type: { id: null, label: 'N/A' } } },
          ],
        }],
      },
    },
    // ── Signature ────────────────────────────────────────────────────────────
    {
      type: 'signature',
      ordinal: 0,
      selectedLayoutIndex: 0,
      showMode: 'preview',
      layouts: ['signatureWidget1', 'signatureWidget2', 'signatureWidget3', 'signatureWidget4'],
      styles: {
        backgroundColor: '', borderColor: '', innerBackgroundColor: '',
        header: { borderRadius: '0', background: primaryHex },
        widgetBackground: { image: '', size: 'cover', position: 'left' },
        text:  { fontFamily: 'Arial', color: '#000000', fontSize: '14' },
        title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
        btn:   { background: primaryHex, backgroundHover: primaryHex, borderColor: '#ccc',
                 borderColorHover: '#ccc', textColor: '#fff', textColorHover: '#fff',
                 fontSize: '14', borderWidth: '0', borderRadius: '8',
                 paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5' },
      },
      data: {
        uid: 'section_7',
        title: 'Sign Here',
        signLabel: 'Sign', doneBtnText: 'Done', clearBtnText: 'Clear',
        previewButtonText: 'Preview',
        enableCoSignature: false, coSignatureData: null,
        enableAcceptButton: false, enableAcceptInsteadOfSign: false,
        enableRedirect: false, redirectUrl: '',
        enableRedirectUrlFromPlaybook: false, redirectUrlFromPlaybook: '',
        enableMergeDocs: false, mergeDocsData: null,
        externalSigningIntegration: null,
        collapsedByDefault: false,
        relevanceRule: 'true', isRuleValid: true,
        rtl: false, labels: [], labelsKeys: [], maxLengthLabels: 0,
        signedByLabel: '', signedByTitleLabel: '', comment: '',
        consentBackgroundColor: '', consentTextColor: '',
        redirectCustomText: '',
      },
    },
  ];

  return {
    styles: {
      backgroundColor: '#fff',
      backgroundImage: heroObj ? `url(${brand.heroUrl}) no-repeat` : '',
      borderColor: '#000',
      borderRadius: '8',
      borderWidth: '2',
      innerBackgroundColor: '#fff',
      paddingTop: '25', paddingBottom: '30', paddingLeft: '70', paddingRight: '70',
      opacity: '100',
      docBackgroundColor: '', docBgOpacity: '100',
      header: { borderRadius: '0', background: primaryHex },
      title:  { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
      text:   { fontFamily: 'Arial', color: '#000000', fontSize: '14' },
      btn:    { background: primaryHex, backgroundHover: primaryHex,
                borderColor: '#ccc', borderColorHover: '#ccc',
                textColor: '#fff', textColorHover: '#fff',
                fontSize: '14', borderWidth: '0', borderRadius: '8',
                paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5' },
      widgetBackground: { image: '', size: 'cover', position: 'left' },
    },
    sections,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });

  // Load cookies: captured headers first, then session files
  try {
    const h = JSON.parse(fs.readFileSync('/tmp/dr_post_headers.json', 'utf8'));
    const cookies = (h.cookie || '').split('; ').map(p => {
      const eq = p.indexOf('=');
      return { name: p.slice(0, eq), value: p.slice(eq + 1), domain: HOST, path: '/', httpOnly: false, secure: true, sameSite: 'None' };
    }).filter(c => c.name);
    if (cookies.length) await context.addCookies(cookies);
  } catch {
    for (const sf of ['session_poc.json', 'session_eu1.json', 'session_current.json']) {
      const fp = path.join(__dirname, sf);
      if (!fs.existsSync(fp)) continue;
      try { await context.addCookies(JSON.parse(fs.readFileSync(fp, 'utf8')).cookies || []); } catch {}
    }
  }

  const page = await context.newPage();

  // Wait until authenticated — show browser if login needed
  console.log('Checking authentication...');
  let authed = false;
  for (let i = 0; i < 24; i++) {
    const r = await page.request.get(`${BASE}/versions/admin?isArchived=false&versionsScreen=true`, {
      headers: { Accept: 'application/json' },
    });
    if (r.ok()) { authed = true; break; }
    if (i === 0) {
      await page.goto(`${BASE}/ws`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('Please log in to poc.dealhub.io in the browser...');
    }
    await page.waitForTimeout(5000);
  }
  if (!authed) { console.error('Authentication failed'); await browser.close(); process.exit(1); }
  console.log('Authenticated.');

  // ── Find version ────────────────────────────────────────────────────────────
  console.log(`\nLooking for version "${VERSION_NAME}"...`);
  const versionsData = await dhGet(page, '/versions/admin?isArchived=false&versionsScreen=true');
  const versions = Array.isArray(versionsData) ? versionsData
    : Array.isArray(versionsData?.versions) ? versionsData.versions : [];
  const lo = VERSION_NAME.toLowerCase();
  const version =
    versions.find(v => (v.name || v.versionName || '').toLowerCase() === lo) ||
    versions.find(v => (v.name || v.versionName || '').toLowerCase().includes(lo));
  if (!version) {
    console.error(`Version "${VERSION_NAME}" not found. Available: ${versions.map(v => v.name||v.versionName).join(', ')}`);
    await browser.close(); process.exit(1);
  }
  const vGuid = version.guid || version.versionGUID;
  const vName = version.name || version.versionName;
  console.log(`Found: ${vName} (${vGuid})`);

  // ── Find playbook ───────────────────────────────────────────────────────────
  const playbooks = await dhGet(page, `/playbooks?versionGUID=${vGuid}`);
  const pbList = Array.isArray(playbooks) ? playbooks : (playbooks?.playbooks || []);
  if (!pbList.length) { console.error('No playbooks found in this version'); await browser.close(); process.exit(1); }
  const pb = pbList[0];
  const pbGuid = pb.guid || pb.playbookGUID;
  const pbName = pb.name || pb.playbookName;
  console.log(`Using playbook: ${pbName} (${pbGuid})`);

  // ── Scrape website ──────────────────────────────────────────────────────────
  const brand = await extractBrand(page, WEBSITE);
  let primaryHex = rgbToHex(brand.primaryColor);

  // Override near-white or near-black fallbacks with a visible color
  if (!primaryHex || primaryHex === '#fafafa' || primaryHex === '#ffffff' ||
      primaryHex === '#000000' || primaryHex === '#0a0a0a') {
    // Try to infer from og:image or site URL patterns
    console.log('  Color extraction weak — using logo gradient color heuristic');
    primaryHex = '#E84B1C'; // fallback to a strong brand red-orange
  }
  console.log(`  Primary hex: ${primaryHex}`);

  // ── Validate / improve assets ───────────────────────────────────────────────
  // If logo looks like an icon (grid, sprite, tiny svg), use og:image or skip
  if (brand.logoUrl && /grid|icon|sprite|favicon/i.test(brand.logoUrl)) {
    console.log('  Dropping bad logo URL:', brand.logoUrl);
    brand.logoUrl = null;
  }
  // If hero looks like a customer/partner logo, drop it
  if (brand.heroUrl && /customer|partner|client-logo|logo-\d/i.test(brand.heroUrl)) {
    console.log('  Dropping bad hero URL:', brand.heroUrl);
    brand.heroUrl = null;
  }

  // ── Build DealRoom name ─────────────────────────────────────────────────────
  const drName = DR_NAME || `${brand.companyName} DealRoom`;
  console.log(`\nCreating DealRoom: "${drName}"...`);

  // Navigate back to DealHub
  await page.goto(`${BASE}/ws`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);

  // ── Step 1: Create template record ─────────────────────────────────────────
  // Get existing templates to determine next ordinal
  const existingTpls = await dhGet(page, `/htmlTemplates?versionGUID=${vGuid}`);
  const tplList = Array.isArray(existingTpls) ? existingTpls : (existingTpls?.htmlTemplates || []);
  const nextOrdinal = tplList.length;

  const createRes = await dhPost(page, '/htmlTemplate', {
    guid:               null,
    name:               drName,
    versionGUID:        vGuid,
    playbookGUID:       pbGuid,
    playbookName:       pbName,
    comment:            '',
    rule:               '',
    assignType:         'ALWAYS',
    ordinal:            nextOrdinal,
    guestMode:          'NONE',
    guestCanChange:     false,
    templateId:         '2',
    tagRelations:       [],
    deletedDocumentTags: [],
    changeLogRecords:   [],
  });
  if (!createRes) { console.error('Failed to create template'); await browser.close(); process.exit(1); }

  const tplGuid = createRes.htmlTemplate?.guid || createRes.guid;
  console.log(`Template created: ${tplGuid}`);

  // ── Step 2: Save content ────────────────────────────────────────────────────
  console.log('Populating sections...');
  const drData = buildDrData({
    logoUrl:     brand.logoUrl,
    heroUrl:     brand.heroUrl,
    primary:     primaryHex,
    bgDark:      null,
    companyName: brand.companyName,
  });

  const contentRes = await dhPost(page, '/htmlTemplate/content', {
    guid: tplGuid,
    data: JSON.stringify(drData),
    changeLogRecords: null,
  });

  if (!contentRes) {
    console.error('Failed to save content');
    await browser.close(); process.exit(1);
  }

  console.log(`\nDealRoom created successfully!`);
  console.log(`  Name:    ${drName}`);
  console.log(`  GUID:    ${tplGuid}`);
  console.log(`  Version: ${vName}`);
  console.log(`\nOpen in DealHub: ${BASE}/ws#/versions/${vGuid}/output-documents`);

  await browser.close();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
