/**
 * Employment document family mapping — learned profile.
 *
 * Covers employment-related document types issued by employers or government:
 *   CertificateOfEmployment — COE: employer-issued letter confirming employment status
 *   BIRForm2316             — Certificate of Compensation Payment / Tax Withheld
 *
 * The COE is the primary fixture type (5 fixtures in manifest). BIR 2316 is
 * included here because it is employer-issued and overlaps significantly in
 * the fields QA checks (employer name, employee name, compensation amounts).
 *
 * As more employment document types (appointment letters, contracts) are
 * confirmed by the API, add their paths and assertion rules here rather than
 * creating new files.
 */

export const mapping = {
  documentCategory: 'employment-document',
  parseFileTypes: ['CertificateOfEmployment', 'BIRForm2316'],
  batchDocumentTypes: ['CERTIFICATE_OF_EMPLOYMENT', 'BIR_FORM_2316'],
  aliases: [
    'certificate of employment', 'coe', 'employment certificate',
    'bir 2316', 'bir form 2316', '2316', 'bir2316',
    'certificate of compensation', 'compensation certificate',
  ],

  // ── Canonical field name → /v1/documents/parse response path ─────────────
  responsePaths: {
    // CertificateOfEmployment fields
    employerName:       'documentData.*.employerName',
    employeeName:       'documentData.*.employeeName',
    position:           'documentData.*.position',
    employmentStatus:   'documentData.*.employmentStatus',
    dateIssued:         'documentData.*.dateIssued',
    // Some COEs include compensation details
    salaryAmount:       'documentData.*.salaryAmount',
    // BIRForm2316 additional fields
    grossCompensation:  'documentData.*.grossCompensation',
    taxWithheld:        'documentData.*.taxWithheld',
    taxableCompensation: 'documentData.*.taxableCompensation',
    // Common
    fraudScore:         'fraudScore',
    authenticityScore:  'authenticityScore',
  },

  // ── Assertion rules ───────────────────────────────────────────────────────
  assertionRules: {
    'documentData.*.employerName':        { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.employeeName':        { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.position':            { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.employmentStatus':    { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.dateIssued':          { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.salaryAmount':        { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.grossCompensation':   { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.taxWithheld':         { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.taxableCompensation': { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'fraudScore':                         { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'authenticityScore':                  { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
  },

  // ── Field focus rules ─────────────────────────────────────────────────────
  fieldFocusRules: [
    {
      keywords: ['employer name', 'company name', 'employer', 'company'],
      focus: 'coe_employer',
      fields: ['documentData.*.employerName'],
    },
    {
      keywords: ['employee name', 'worker name', 'staff name', 'employee'],
      focus: 'coe_employee',
      fields: ['documentData.*.employeeName', 'documentData.*.position'],
    },
    {
      keywords: ['employment status', 'regular', 'probationary', 'contractual', 'tenure', 'employment type'],
      focus: 'coe_status',
      fields: ['documentData.*.employmentStatus', 'documentData.*.dateIssued'],
    },
    {
      keywords: ['salary', 'compensation', 'wage', 'pay', 'income'],
      focus: 'coe_compensation',
      fields: ['documentData.*.salaryAmount', 'documentData.*.grossCompensation'],
    },
    {
      keywords: ['tax withheld', 'withholding tax', 'bir 2316', '2316', 'taxable compensation'],
      focus: 'bir2316_tax',
      fields: [
        'documentData.*.grossCompensation',
        'documentData.*.taxableCompensation',
        'documentData.*.taxWithheld',
      ],
    },
  ],

  // ── Fixture requirement rules ─────────────────────────────────────────────
  fixtureRequirementRules: {
    coe_employer:      ['coe with employer name visible'],
    coe_employee:      ['coe with employee name and position'],
    coe_status:        ['coe with employment status'],
    coe_compensation:  ['coe with salary amount'],
    bir2316_tax:       ['bir 2316 with gross compensation and tax withheld'],
    _default:          ['complete certificate of employment'],
  },
};
