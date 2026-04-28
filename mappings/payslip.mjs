/**
 * Payslip document mapping — learned profile.
 *
 * Defines all known knowledge about how the VerifyIQ API represents payslip
 * documents: canonical response paths, assertion rules, field-focus keywords,
 * and fixture-requirement scenarios.
 *
 * This is the source of truth for payslip QA. When the API shape changes,
 * update responsePaths and assertionRules here — the planner and generator
 * pick up the changes automatically.
 *
 * To add a new document type, copy this file to mappings/<type>.mjs,
 * fill in the fields, and register it in mappings/index.mjs.
 */

export const mapping = {
  documentCategory: 'payslip',
  parseFileTypes: ['Payslip'],
  batchDocumentTypes: ['PAYSLIP'],
  aliases: [
    'payslip', 'pay slip', 'salary slip', 'paycheck', 'pay stub',
    'payroll slip', 'salary statement', 'earnings statement',
  ],

  // ── Canonical field name → actual /v1/documents/parse response path ───────
  // documentData child fields are camelCase (normalized API form).
  // summaryResult / _gshare_metadata fields are snake_case (raw OCR form).
  // Prefer documentData.* for parse assertions; use summaryResult / metadata
  // only when the ticket specifically references OCR or summary output.
  responsePaths: {
    grossPay:                        'documentData.*.grossPay',
    netPay:                          'documentData.*.netPay',
    basicPay:                        'documentData.*.basicPay',
    withholdingTaxDeduction:         'documentData.*.withholdingTaxDeduction',
    sssContributionDeduction:        'documentData.*.sssContributionDeduction',
    philhealthContributionDeduction: 'documentData.*.philhealthContributionDeduction',
    hdmfPagibigDeduction:            'documentData.*.hdmfPagibigDeduction',
    totalDeductions:                 'summaryResult.*.total_deductions',
    totalDeductionsMeta:             '_gshare_metadata.total_deductions_amount',
    mathematicalFraudReport:         'mathematicalFraudReport',
    fraudScore:                      'fraudScore',
    authenticityScore:               'authenticityScore',
    employerName:                    'documentData.*.employer_name',
    employeeName:                    'documentData.*.employee_name',
  },

  // ── Assertion rules for known response paths ─────────────────────────────
  // Maps response path → assertion config consumed by makeAssertion() in generator.
  //
  // assertionType:
  //   'pattern' → regex against stringified value (strong)
  //   'type'    → structural Array.isArray / typeof check (strong)
  //   'exists'  → .+ presence check (weak)
  //
  // Numeric pattern '^-?[0-9][0-9,.]*$' accepts string numbers (e.g. "12,345.67")
  // because the API may serialize numeric fields as strings.
  //
  // optional: true — field may legitimately be absent from some payslips.
  //   When optional, a missing field produces a WARN (not FAIL) in the runner.
  //   A present field with the WRONG value still FAILs regardless of optional.
  //
  //   Required (always present on a valid payslip parse):
  //     grossPay, netPay, fraudScore, authenticityScore
  //
  //   Optional (present on most but not all payslips):
  //     basicPay — absent on commission-only / GCash-style payslips
  //     deduction fields — absent when employee has no deductions (e.g. tax-exempt)
  //     summaryResult / metadata fields — only returned when summary output requested
  //     mathematicalFraudReport — not always computed
  //     employer_name / employee_name — may not be readable on low-quality scans
  assertionRules: {
    'documentData.*.grossPay':                        { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.netPay':                          { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.basicPay':                        { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.*.withholdingTaxDeduction':         { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.*.sssContributionDeduction':        { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.*.philhealthContributionDeduction': { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.*.hdmfPagibigDeduction':            { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'summaryResult.*.total_deductions':               { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    '_gshare_metadata.total_deductions_amount':       { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'mathematicalFraudReport':                        { assertionType: 'exists',  pattern: '.+', strength: 'weak', optional: true },
    'fraudScore':                                     { assertionType: 'exists',  pattern: '.+', strength: 'weak' },
    'authenticityScore':                              { assertionType: 'exists',  pattern: '.+', strength: 'weak' },
    'documentData.*.employer_name':                   { assertionType: 'exists',  pattern: '.+', strength: 'weak', optional: true },
    'documentData.*.employee_name':                   { assertionType: 'exists',  pattern: '.+', strength: 'weak', optional: true },
  },

  // ── Field focus rules ────────────────────────────────────────────────────
  // ClickUp keyword → response paths the planner will include in affectedFields.
  // Merged with universal rules (fraud, transactions, balance, etc.) in inferAffectedFields().
  fieldFocusRules: [
    {
      keywords: ['gross pay', 'net pay', 'take home', 'basic salary', 'base salary', 'basic pay'],
      focus: 'payslip_fields',
      fields: ['documentData.*.grossPay', 'documentData.*.netPay', 'documentData.*.basicPay'],
    },
    {
      keywords: ['tax', 'deduction', 'withholding', 'sss', 'philhealth', 'pag-ibig', 'pagibig', 'hdmf', 'cpf', 'epf', 'nssf', 'socso', 'paye'],
      focus: 'payslip_deductions',
      fields: [
        'documentData.*.withholdingTaxDeduction',
        'documentData.*.sssContributionDeduction',
        'documentData.*.philhealthContributionDeduction',
        'documentData.*.hdmfPagibigDeduction',
      ],
    },
    {
      keywords: ['total deduction', 'net deduction', 'deduction summary', 'deductions total'],
      focus: 'payslip_deductions_summary',
      fields: ['summaryResult.*.total_deductions', '_gshare_metadata.total_deductions_amount'],
    },
    {
      keywords: ['employer name', 'employee name', 'staff name', 'worker name', 'employee id'],
      focus: 'payslip_identity',
      fields: ['documentData.*.employer_name', 'documentData.*.employee_name'],
    },
  ],

  // ── Completeness scoring ─────────────────────────────────────────────────────
  // Weighted field-presence scoring for documentData[] items.
  // Generator translates this into an assertionType:'completenessScore' assertion.
  // Runner scores each documentData item, takes the worst score, then applies thresholds:
  //   score >= pass   → PASS  (no warning)
  //   score >= warn   → WARN  (test passes but warning logged)
  //   score <  warn   → FAIL  (test fails)
  // Missing optional fields reduce score; missing required fields reduce score further.
  // A present-but-wrong VALUE still FAILs via the pattern/computed assertion path.
  completenessScoring: {
    thresholds: { pass: 90, warn: 70 },
    required: {
      employeeName:        25,
      companyName:         20,
      netPay:              15,
      grossPay:            10,
      basicPay:            10,
      payPeriodStartDate:   5,
      payPeriodEndDate:     5,
    },
    optional: {
      payDate:                          3,
      position:                         2,
      withholdingTaxDeduction:          2,
      sssContributionDeduction:         1,
      philhealthContributionDeduction:  1,
      hdmfPagibigDeduction:             1,
    },
  },

  // ── Computed (cross-field) validations ──────────────────────────────────────
  // These check mathematical relationships between extracted values, not just presence.
  // Each entry is translated into an assertionType:'computed' object by the generator.
  // The runner skips a check (WARN) if its required paths are absent; FAILs if math is wrong.
  //
  // paths: named key → response path.  Key names are known to the runner switch statement.
  // tolerance: maximum allowed absolute difference for numeric equality checks.
  computedValidations: [
    {
      check: 'net_approx_gross_minus_total',
      description: 'netPay ≈ grossPay − totalDeductions (tolerance ±1.0)',
      tolerance: 1.0,
      paths: {
        grossPay:            'documentData.*.grossPay',
        netPay:              'documentData.*.netPay',
        totalDeductions:     'summaryResult.*.total_deductions',
        totalDeductionsMeta: '_gshare_metadata.total_deductions_amount',
      },
    },
    {
      check: 'total_approx_sum_deductions',
      description: 'totalDeductions ≈ sum of individual deductions (tolerance ±1.0)',
      tolerance: 1.0,
      // Skipped by default: extraction rules say total_deductions is only extracted if
      // explicitly present on the document — the system must NOT compute totals from
      // individual fields, and individual deductions may be a partial subset.
      // Only enable for fixtures confirmed to be standard structured payslips with a
      // complete deduction breakdown. See: explicit_total_only for the softer policy check.
      skipByDefault: true,
      paths: {
        totalDeductions:     'summaryResult.*.total_deductions',
        totalDeductionsMeta: '_gshare_metadata.total_deductions_amount',
        withholdingTax:      'documentData.*.withholdingTaxDeduction',
        sss:                 'documentData.*.sssContributionDeduction',
        philhealth:          'documentData.*.philhealthContributionDeduction',
        hdmfPagibig:         'documentData.*.hdmfPagibigDeduction',
      },
    },
    {
      check: 'gross_gte_net',
      description: 'grossPay ≥ netPay',
      tolerance: 0,
      paths: {
        grossPay: 'documentData.*.grossPay',
        netPay:   'documentData.*.netPay',
      },
    },
    {
      check: 'deductions_non_negative',
      description: 'all present deductions ≥ 0',
      tolerance: 0,
      paths: {
        withholdingTax: 'documentData.*.withholdingTaxDeduction',
        sss:            'documentData.*.sssContributionDeduction',
        philhealth:     'documentData.*.philhealthContributionDeduction',
        hdmfPagibig:    'documentData.*.hdmfPagibigDeduction',
      },
    },
    {
      check: 'fraud_score_range',
      description: 'fraudScore is within valid range [0, 100]',
      tolerance: 0,
      paths: {
        fraudScore: 'fraudScore',
      },
    },
    {
      check: 'no_negative_pay',
      description: 'grossPay and netPay are both positive (> 0)',
      tolerance: 0,
      paths: {
        grossPay: 'documentData.*.grossPay',
        netPay:   'documentData.*.netPay',
      },
    },
    {
      check: 'no_cross_section_contamination',
      description: 'earnings items must not appear in deductions (Giftaway excepted)',
      tolerance: 0,
      // Flags cases where a deduction field resolves to the same numeric value as an
      // earnings field — a strong signal the extractor mixed sections.
      // Exception: Giftaway is a legitimate dual-section item; the runner skips a
      // contamination flag for amounts that appear to be allowance/gift-type entries.
      paths: {
        grossPay:       'documentData.*.grossPay',
        basicPay:       'documentData.*.basicPay',
        netPay:         'documentData.*.netPay',
        withholdingTax: 'documentData.*.withholdingTaxDeduction',
        sss:            'documentData.*.sssContributionDeduction',
        philhealth:     'documentData.*.philhealthContributionDeduction',
        hdmfPagibig:    'documentData.*.hdmfPagibigDeduction',
      },
    },
    {
      check: 'explicit_total_only',
      description: 'total_deductions present → must be explicit (not inferred); absent → must be null',
      tolerance: 0,
      // Policy assertion: validates that totalDeductions reflects only what the document
      // explicitly states. If absent, the null value is correct — must not be inferred
      // from individual fields. If present, must be a non-negative numeric value.
      paths: {
        totalDeductions:     'summaryResult.*.total_deductions',
        totalDeductionsMeta: '_gshare_metadata.total_deductions_amount',
        withholdingTax:      'documentData.*.withholdingTaxDeduction',
        sss:                 'documentData.*.sssContributionDeduction',
        philhealth:          'documentData.*.philhealthContributionDeduction',
        hdmfPagibig:         'documentData.*.hdmfPagibigDeduction',
      },
    },
  ],

  // ── Fixture requirement rules ────────────────────────────────────────────
  // validationFocus → array of scenario strings passed to the fixture selector.
  // The generator tries to match each string against fixture notes / filenames.
  // '_default' is used when validationFocus has no specific entry.
  fixtureRequirementRules: {
    payslip_fields:           ['high-value payslip', 'standard payslip'],
    payslip_deductions:       ['payslip with deductions', 'payslip without deductions'],
    payslip_deductions_summary: ['payslip with deductions'],
    payslip_identity:         ['payslip with employer and employee name visible'],
    _default:                 ['complete payslip'],
  },
};
