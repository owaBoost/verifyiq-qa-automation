/**
 * KYB (Know Your Business) document family mapping — learned profile.
 *
 * Covers government-issued and barangay-level documents used for business
 * registration, address verification, and KYB/KYC compliance:
 *   BarangayCertificate             — Barangay Certificate / Clearance / Permit
 *   SECCertificateOfIncorporation   — SEC Certificate of Incorporation
 *   SECCertificateOfPartnership     — SEC Certificate of Partnership
 *   ArticlesOfIncorporation         — AOI
 *   ArticlesOfPartnership           — AOP
 *   DTIRegistrationCertificate      — DTI Business Name Registration
 *   DTIPermit                       — DTI Permit
 *   MayorsPermit                    — Mayor's / Business Permit
 *   BoardResolution                 — Board Resolution
 *   SecretaryCertificate            — Secretary's Certificate
 *   GeneralInformationSheet         — GIS
 *
 * Barangay certificates are the primary fixture type (5 in manifest).
 * Business registration docs share many fields (businessName, address,
 * registrationNumber, dateIssued) and are grouped here rather than in separate
 * files.
 *
 * Expand this file as more KYB document types are confirmed by the API.
 */

export const mapping = {
  documentCategory: 'kyb-document',
  parseFileTypes: [
    'BarangayCertificate',
    'SECCertificateOfIncorporation',
    'SECCertificateOfPartnership',
    'ArticlesOfIncorporation',
    'ArticlesOfPartnership',
    'DTIRegistrationCertificate',
    'DTIPermit',
    'MayorsPermit',
    'BoardResolution',
    'SecretaryCertificate',
    'GeneralInformationSheet',
  ],
  batchDocumentTypes: [
    'BARANGAY_CERTIFICATE',
    'SEC_CERTIFICATE_OF_INCORPORATION',
    'SEC_CERTIFICATE_OF_PARTNERSHIP',
    'ARTICLES_OF_INCORPORATION',
    'ARTICLES_OF_PARTNERSHIP',
    'DTI_REGISTRATION_CERTIFICATE',
    'DTI_PERMIT',
    'MAYORS_PERMIT',
    'BOARD_RESOLUTION',
    'SECRETARY_CERTIFICATE',
    'GENERAL_INFORMATION_SHEET',
  ],
  aliases: [
    'barangay certificate', 'barangay clearance', 'brgy certificate', 'brgy cert', 'barangay permit',
    'sec certificate', 'sec cor', 'certificate of incorporation',
    'articles of incorporation', 'aoi',
    'articles of partnership', 'aop',
    'dti', 'dti registration', 'dti certificate', 'dti permit',
    "mayor's permit", 'mayors permit', 'business permit',
    'board resolution', 'board res',
    'secretary certificate', 'secretary cert',
    'gis', 'general information sheet',
  ],

  // ── Canonical field name → /v1/documents/parse response path ─────────────
  responsePaths: {
    // Barangay Certificate fields
    residentName:        'documentData.*.residentName',
    barangay:            'documentData.*.barangay',
    municipality:        'documentData.*.municipality',
    province:            'documentData.*.province',
    purpose:             'documentData.*.purpose',
    // Shared across business / KYB docs
    businessName:        'documentData.*.businessName',
    ownerName:           'documentData.*.ownerName',
    address:             'documentData.*.address',
    registrationNumber:  'documentData.*.registrationNumber',
    dateIssued:          'documentData.*.dateIssued',
    dateRegistered:      'documentData.*.dateRegistered',
    expiryDate:          'documentData.*.expiryDate',
    // Corporate-specific
    corporateName:       'documentData.*.corporateName',
    incorporationDate:   'documentData.*.incorporationDate',
    authorizedCapital:   'documentData.*.authorizedCapital',
    // Common
    fraudScore:          'fraudScore',
    authenticityScore:   'authenticityScore',
  },

  // ── Assertion rules ───────────────────────────────────────────────────────
  // Most KYB fields are text — use exists/weak until shapes are confirmed.
  // Capital amounts use numeric pattern when confirmed.
  assertionRules: {
    'documentData.*.residentName':       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.barangay':           { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.municipality':       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.purpose':            { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.businessName':       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.ownerName':          { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.address':            { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.registrationNumber': { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.dateIssued':         { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.corporateName':      { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.authorizedCapital':  { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'fraudScore':                        { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'authenticityScore':                 { assertionType: 'exists', pattern: '.+', strength: 'weak' },
  },

  // ── Field focus rules ─────────────────────────────────────────────────────
  fieldFocusRules: [
    {
      keywords: ['resident name', 'barangay', 'clearance', 'brgy', 'barangay certificate', 'barangay permit'],
      focus: 'barangay_cert',
      fields: ['documentData.*.residentName', 'documentData.*.barangay', 'documentData.*.municipality', 'documentData.*.purpose'],
    },
    {
      keywords: ['business name', 'trade name', 'business registration', 'registered name'],
      focus: 'kyb_business_name',
      fields: ['documentData.*.businessName', 'documentData.*.corporateName', 'documentData.*.registrationNumber'],
    },
    {
      keywords: ['owner name', 'proprietor', 'registrant', 'incorporator'],
      focus: 'kyb_owner',
      fields: ['documentData.*.ownerName', 'documentData.*.address'],
    },
    {
      keywords: ['registration number', 'sec number', 'dti number', 'reg no', 'cert no', 'registration date'],
      focus: 'kyb_registration',
      fields: ['documentData.*.registrationNumber', 'documentData.*.dateRegistered', 'documentData.*.incorporationDate'],
    },
    {
      keywords: ["mayor's permit", 'business permit', 'permit number', 'permit expiry', 'permit validity'],
      focus: 'kyb_permit',
      fields: ['documentData.*.registrationNumber', 'documentData.*.dateIssued', 'documentData.*.expiryDate'],
    },
    {
      keywords: ['authorized capital', 'paid up capital', 'subscribed capital', 'capital stock'],
      focus: 'kyb_capital',
      fields: ['documentData.*.authorizedCapital'],
    },
  ],

  // ── Fixture requirement rules ─────────────────────────────────────────────
  fixtureRequirementRules: {
    barangay_cert:     ['barangay certificate with resident name and barangay'],
    kyb_business_name: ['business document with business name'],
    kyb_owner:         ['business document with owner name'],
    kyb_registration:  ['business document with registration number'],
    kyb_permit:        ["mayor's permit or business permit"],
    kyb_capital:       ['sec document with authorized capital'],
    _default:          ['complete kyb document'],
  },
};
