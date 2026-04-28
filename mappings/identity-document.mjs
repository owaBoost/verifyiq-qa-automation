/**
 * Identity document family mapping — learned profile.
 *
 * Covers all Philippine government-issued identity document types:
 *   DriversLicense          — LTO Driver's License
 *   Passport                — Philippine Passport
 *   PhilHealthID            — PhilHealth / PHIC card
 *   TINID                   — BIR TIN card
 *   UMID                    — Unified Multi-Purpose ID (SSS-issued)
 *   VotersID                — COMELEC Voter's ID
 *   PhilippineNationalID    — PhilSys National ID
 *   SSSID                   — SSS card (distinct from UMID)
 *   PRCID                   — PRC Professional ID
 *   PostalID                — Postal ID
 *   HDMFID                  — Pag-IBIG / HDMF card
 *   NBIClearance            — NBI Clearance
 *   ACRICard                — ACR I-Card (alien registration)
 *
 * Core identity fields (fullName, dateOfBirth, idNumber) are shared across
 * all types. Type-specific fields (e.g. licenseNumber, restrictions, passport
 * number, MRZ) are listed per-type in responsePaths.
 *
 * Assertions are kept at 'exists'/'weak' until the exact API field names for
 * each issuer are confirmed from real parse runs. Upgrade to 'pattern'/'strong'
 * once confirmed.
 */

export const mapping = {
  documentCategory: 'identity-document',
  parseFileTypes: [
    'DriversLicense',
    'Passport',
    'PhilHealthID',
    'TINID',
    'UMID',
    'VotersID',
    'PhilippineNationalID',
    'SSSID',
    'PRCID',
    'PostalID',
    'HDMFID',
    'NBIClearance',
    'ACRICard',
  ],
  batchDocumentTypes: [
    'DRIVERS_LICENSE',
    'PASSPORT',
    'PHILHEALTH_ID',
    'TIN_ID',
    'UMID',
    'VOTERS_ID',
    'PHILIPPINE_NATIONAL_ID',
    'SSS_ID',
    'PRC_ID',
    'POSTAL_ID',
    'HDMF_ID',
    'NBI_CLEARANCE',
    'ACRI_CARD',
  ],
  aliases: [
    "driver's license", 'drivers license', 'driver license', 'dl', 'lto',
    'passport', 'philippine passport',
    'philhealth', 'philhealth id', 'phic', 'health id',
    'tin', 'tin id', 'tin card',
    'umid', 'unified multi-purpose id',
    "voter's id", 'voters id', 'voter id', 'comelec id',
    'national id', 'philsys', 'philippine national id',
    'sss id', 'sss card',
    'prc id', 'prc', 'professional id',
    'postal id', 'postal card',
    'pag-ibig id', 'pagibig id', 'hdmf id',
    'nbi clearance', 'nbi',
    'acr i-card', 'acri card', 'alien registration',
  ],

  // ── Canonical field name → /v1/documents/parse response path ─────────────
  // Fields shared across all ID types
  responsePaths: {
    // Universal identity fields
    fullName:           'documentData.*.fullName',
    lastName:           'documentData.*.lastName',
    firstName:          'documentData.*.firstName',
    middleName:         'documentData.*.middleName',
    dateOfBirth:        'documentData.*.dateOfBirth',
    address:            'documentData.*.address',
    idNumber:           'documentData.*.idNumber',
    expiryDate:         'documentData.*.expiryDate',
    // Driver's License specific
    licenseNumber:      'documentData.*.licenseNumber',
    restrictions:       'documentData.*.restrictions',
    licenseConditions:  'documentData.*.licenseConditions',
    // Passport specific
    passportNumber:     'documentData.*.passportNumber',
    nationality:        'documentData.*.nationality',
    placeOfBirth:       'documentData.*.placeOfBirth',
    mrz:                'documentData.*.mrz',
    // PhilHealth specific
    philhealthNumber:   'documentData.*.philhealthNumber',
    // TIN specific
    tinNumber:          'documentData.*.tinNumber',
    // UMID specific
    umidNumber:         'documentData.*.umidNumber',
    sssNumber:          'documentData.*.sssNumber',
    // VotersID specific
    precinctNumber:     'documentData.*.precinctNumber',
    // Common
    fraudScore:         'fraudScore',
    authenticityScore:  'authenticityScore',
  },

  // ── Assertion rules ───────────────────────────────────────────────────────
  // Name and ID number are the most reliable fields — check existence at minimum.
  // Date format varies by issuer, so use 'exists' rather than a date pattern.
  assertionRules: {
    'documentData.*.fullName':          { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.lastName':          { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.firstName':         { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.dateOfBirth':       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.idNumber':          { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.expiryDate':        { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.address':           { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.licenseNumber':     { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.passportNumber':    { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.mrz':               { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.philhealthNumber':  { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.tinNumber':         { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData.*.umidNumber':        { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'fraudScore':                       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'authenticityScore':                { assertionType: 'exists', pattern: '.+', strength: 'weak' },
  },

  // ── Field focus rules ─────────────────────────────────────────────────────
  fieldFocusRules: [
    {
      keywords: ['name', 'full name', 'last name', 'first name', 'surname', 'given name'],
      focus: 'id_name',
      fields: ['documentData.*.fullName', 'documentData.*.lastName', 'documentData.*.firstName', 'documentData.*.middleName'],
    },
    {
      keywords: ['date of birth', 'birthdate', 'dob', 'birthday', 'birth date'],
      focus: 'id_dob',
      fields: ['documentData.*.dateOfBirth'],
    },
    {
      keywords: ['id number', 'license number', 'passport number', 'card number', 'id no', 'reference number'],
      focus: 'id_number',
      fields: ['documentData.*.idNumber', 'documentData.*.licenseNumber', 'documentData.*.passportNumber'],
    },
    {
      keywords: ['expiry', 'expiration', 'valid until', 'validity', 'expires'],
      focus: 'id_expiry',
      fields: ['documentData.*.expiryDate'],
    },
    {
      keywords: ['address', 'residence', 'home address', 'permanent address'],
      focus: 'id_address',
      fields: ['documentData.*.address'],
    },
    {
      keywords: ['mrz', 'machine readable', 'passport zone'],
      focus: 'passport_mrz',
      fields: ['documentData.*.mrz', 'documentData.*.passportNumber', 'documentData.*.nationality'],
    },
    {
      keywords: ['restrictions', 'license conditions', 'license category', 'vehicle type'],
      focus: 'license_restrictions',
      fields: ['documentData.*.restrictions', 'documentData.*.licenseConditions', 'documentData.*.licenseNumber'],
    },
  ],

  // ── Fixture requirement rules ─────────────────────────────────────────────
  fixtureRequirementRules: {
    id_name:             ['id with full name visible'],
    id_dob:              ['id with date of birth'],
    id_number:           ['id with id number'],
    id_expiry:           ['id with expiry date'],
    id_address:          ['id with address'],
    passport_mrz:        ['passport with mrz zone'],
    license_restrictions: ["driver's license with restriction codes"],
    _default:            ['complete government id'],
  },
};
