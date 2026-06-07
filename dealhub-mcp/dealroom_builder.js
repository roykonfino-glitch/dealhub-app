'use strict';

// Darken a hex color by `pct` percent (0-100)
function darkenHex(hex, pct = 15) {
  const h = hex.replace('#', '');
  const num = parseInt(h, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  r = Math.max(0, Math.round(r * (1 - pct / 100)));
  g = Math.max(0, Math.round(g * (1 - pct / 100)));
  b = Math.max(0, Math.round(b * (1 - pct / 100)));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function imgObj(url, name) {
  if (!url) return null;
  return {
    type: 'OutputDocument', url, guid: '', name,
    accountGUID: 0, archived: false, uploadDate: '', imageFileName: '',
    width: 0, height: 0, uploadedSizes: null, thumbnailURL: url,
  };
}

function secStyles(primary) {
  const hover = darkenHex(primary);
  return {
    backgroundColor: '', borderColor: '',
    header: { borderRadius: '0', background: primary },
    widgetBackground: { image: '', size: 'cover', position: 'left' },
    text:  { fontFamily: 'Arial', color: '#ffffff', fontSize: '14' },
    title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
    btn: {
      background: primary, backgroundHover: hover,
      borderColor: primary, borderColorHover: hover,
      textColor: '#fff', textColorHover: '#fff',
      fontSize: '14', borderWidth: '0', borderRadius: '8',
      paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5',
    },
  };
}

/**
 * Build the DealRoom `data` object (styles + sections) for a given brand.
 *
 * brand: { logoUrl, heroUrl, primary, bgDark, companyName }
 */
function buildDrData(brand) {
  const { logoUrl, heroUrl, primary, bgDark, companyName } = brand;
  const hover = darkenHex(primary);

  const styles = secStyles(primary);

  const globalStyles = {
    backgroundColor:      bgDark || '#ffffff',
    backgroundImage:      heroUrl ? `url(${heroUrl}) no-repeat center center` : '',
    docBackgroundColor:   bgDark || '#808080',
    innerBackgroundColor: bgDark || '#ffffff',
    borderColor:   primary,
    borderRadius:  '8',
    borderWidth:   '0',
    paddingTop: '25', paddingBottom: '30', paddingLeft: '70', paddingRight: '70',
    opacity: '100', docBgOpacity: '80',
    header: { borderRadius: '0', background: primary },
    title: { fontFamily: 'Arial', color: '#ffffff', fontSize: '22' },
    text:  { fontFamily: 'Arial', color: '#ffffff', fontSize: '14' },
    btn: {
      background: primary, backgroundHover: hover,
      borderColor: primary, borderColorHover: hover,
      textColor: '#fff', textColorHover: '#fff',
      fontSize: '14', borderWidth: '0', borderRadius: '8',
      paddingLeft: '10', paddingRight: '10', paddingTop: '5', paddingBottom: '5',
    },
    widgetBackground: { image: '', size: 'cover', position: 'left' },
  };

  const sections = [
    // ── 1. Header ────────────────────────────────────────────────────────────
    {
      type: 'header',
      ordinal: 0, selectedLayoutIndex: 2, showMode: 'preview',
      collapsedByDefault: false, showOnWeb: true, showOnMobile: true,
      layouts: ['headerWidget1', 'headerWidget2', 'headerWidget3'],
      title: '',
      styles: { ...styles, banner: { backgroundColor: primary, opacity: '100' }, opacity: '0' },
      data: {
        uid: 'section_1',
        companyLogo:           imgObj(logoUrl, (companyName || 'Company') + ' Logo'),
        backgroundImage:       imgObj(heroUrl, (companyName || 'Company') + ' Hero'),
        mobileBackgroundImage: imgObj(heroUrl, (companyName || 'Company') + ' Hero Mobile'),
        tagLine: `<p><strong><span style="color:#ffffff;">PROPOSAL FOR&nbsp;%OPPORTUNITY_ACCOUNT%</span></strong></p><p><span style="color:#ffffff;font-size:14px;">Please review your personalized proposal below</span></p>`,
        contactName: '', contactEmail: '', contactPhone: '',
        buttonLabel: 'Learn More', buttonLink: '', enableLinkButton: false,
        rtl: false, relevanceRule: 'true', isRuleValid: true, templateIndex: 2,
      },
    },
    // ── 2. Overview text ─────────────────────────────────────────────────────
    {
      type: 'text',
      ordinal: 0, selectedLayoutIndex: 0, showMode: 'preview',
      collapsedByDefault: false, showOnWeb: true, showOnMobile: true,
      layouts: ['textWidget1'],
      title: 'Overview',
      styles,
      data: {
        uid: 'section_2',
        widgets: [{
          type: 'text', id: 'text_1', name: 'Overview',
          text: `<p><span style="font-size:14px;font-family:Arial;color:#ffffff;">Thank you for the opportunity to present this proposal. We look forward to partnering with you.</span></p>`,
          relevanceRule: 'true', isRuleValid: true, limitHeight: false,
        }],
        rtl: false, text: '', limitHeight: false,
        collapsedByDefault: false, title: 'Overview',
      },
    },
    // ── 3. Pricing table ─────────────────────────────────────────────────────
    {
      type: 'pricingTable',
      ordinal: 0, selectedLayoutIndex: 0, showMode: 'preview',
      collapsedByDefault: false, showOnWeb: true, showOnMobile: true,
      layouts: ['pricingTableWidget1'],
      title: 'Pricing',
      styles,
      data: {
        uid: 'section_3',
        tables: [], usages: [],
        templateName: '', usingSharedDesign: false,
        overwriteDesignSettings: false,
        noVerticalScroll: false, rtl: false,
        collapsedByDefault: false, title: 'Pricing',
        isSharedElement: false,
      },
    },
    // ── 4. Attachments ───────────────────────────────────────────────────────
    {
      type: 'attachments',
      ordinal: 0, selectedLayoutIndex: 0, showMode: 'preview',
      collapsedByDefault: true, showOnWeb: true, showOnMobile: true,
      layouts: ['attachmentsWidget1'],
      title: 'Resources',
      styles,
      data: {
        uid: 'section_4',
        attachments: [], fileUrl: '', rtl: false,
        collapsedByDefault: true, title: 'Resources', height: 410,
      },
    },
    // ── 5. e-Signature ───────────────────────────────────────────────────────
    {
      type: 'signature',
      ordinal: 0, selectedLayoutIndex: 0, showMode: 'preview',
      collapsedByDefault: false, showOnWeb: true, showOnMobile: true,
      layouts: ['signatureWidget0'],
      title: 'e-Signature',
      styles: { ...styles, innerBackgroundColor: '#ddd' },
      data: {
        uid: 'section_5',
        previewButtonText: 'Preview',
        clearBtnText: 'Clear',
        doneBtnText: 'Done',
        signLabel: 'Sign here:',
        signedByLabel: 'Signed by',
        signedByTitleLabel: 'Title',
        comment: 'By signing this agreement you agree to abide by its terms as written above.',
        enableRedirect: false, redirectUrl: '',
        enableMergeDocs: false,
        enableCoSignature: false,
        enableAcceptButton: false,
        enableAcceptInsteadOfSign: false,
        externalSigningIntegration: false,
        enableRedirectUrlFromPlaybook: false,
        redirectUrlFromPlaybook: '',
        redirectCustomText: 'To complete your payment <a href="%REDIRECT_URL%">click here</a>',
        consentBackgroundColor: primary,
        consentTextColor: '#ffffff',
        collapsedByDefault: false, title: 'e-Signature',
        rtl: false, relevanceRule: 'true', isRuleValid: true,
        mergeDocsData: {
          relevanceRule: 'false',
          note: 'The attached file(s) will be appended to your DealRoom PDF',
          isRuleValid: true, mergeBtnText: 'Appendices',
        },
        coSignatureData: {
          signingOrder: 'ANY', relevanceRule: 'false', isRuleValid: true,
          buyerSignLabel: 'Sign here:', sellerSignLabel: 'Sign here:',
          buyerComment: 'By signing this agreement you agree to abide by its terms as written above.',
          sellerComment: 'By signing this agreement you agree to abide by its terms as written above.',
        },
        labels: {
          signedByTitle: 'Job Title',
          acceptAndSign: 'ACCEPT & SIGN',
          signatureAcknowledgement: 'I acknowledge that this is a legal representation of my signature',
          signedBy: 'Signed By',
          appendices: 'Appendices',
          clearSignature: 'Clear Signature',
          signatureTypePreview: 'Your signature',
          readingAcknowledgement: 'I have read and agreed to this final version of the agreement',
          reviewAndSign: 'Review Document & Sign',
          signatureSectionTitle: 'Signature',
          signatureTypeDraw: 'Draw your signature',
        },
        labelsKeys: {
          signedByTitle: 'Job Title',
          acceptAndSign: 'ACCEPT & SIGN',
          signatureAcknowledgement: 'Signature Acknowledgement',
          signedBy: 'Signed By',
          appendices: 'Appendices',
          clearSignature: 'Clear Signature',
          readingAcknowledgement: 'Reading Acknowledgement',
          signatureTypePreview: 'Your signature',
          reviewAndSign: 'Review Document & Sign',
          signatureSectionTitle: 'Signature Section Title',
          signatureTypeDraw: 'Draw your signature',
        },
        maxLengthLabels: {
          signatureAcknowledgement: 100,
          readingAcknowledgement: 100,
          signatureSectionTitle: 60,
        },
      },
    },
  ];

  return { styles: globalStyles, sections };
}

module.exports = { buildDrData, imgObj, darkenHex };
