/**
 * Bank statement document family mapping — learned profile.
 *
 * Covers all financial transaction / account statement document types:
 *   BankStatement          — traditional bank SOA (BDO, BPI, Metrobank, EWB, SB, PNB, etc.)
 *   GcashTransactionHistory — GCash / e-wallet transaction history screenshots
 *
 * Real response shape (confirmed):
 *   documentData            — object (NOT array)
 *   documentData.summary    — array of per-account summary objects (min length 1)
 *   documentData.transactions — array of individual transaction rows
 *
 * Fields in summary items are camelCase. GS computed fields (gs_*) are at root level.
 *
 * To add a new financial transaction type: add it to parseFileTypes /
 * batchDocumentTypes, add its response paths, and register assertions here.
 * Do NOT create a separate file — this is the bank-statement family knowledge base.
 */

export const mapping = {
  documentCategory: 'bank-statement',
  parseFileTypes: ['BankStatement', 'GcashTransactionHistory'],
  batchDocumentTypes: ['BANK_STATEMENT', 'GCASH_TRANSACTION_HISTORY'],
  aliases: [
    'bank statement', 'bank statements', 'statement of account', 'soa',
    'bdo', 'bpi', 'metrobank', 'metro bank', 'ewb', 'east west bank',
    'sb', 'security bank', 'pnb', 'philippine national bank',
    'gcash', 'g-cash', 'gcash transaction history', 'e-wallet',
  ],

  // ── Canonical field name → /v1/documents/parse response path ─────────────
  // documentData is an object with summary[] and transactions[] sub-arrays.
  // Summary fields are under documentData.summary.* (per-account summary row).
  // Transaction fields are under documentData.transactions.* (individual rows).
  // GS computed fields (gs_bankname_bankstatement, calculated_credits, etc.)
  // live at the response root level.
  responsePaths: {
    // Root structure
    documentData:          'documentData',
    summary:               'documentData.summary',
    transactions:          'documentData.transactions',
    // Summary fields (per documentData.summary[0])
    bankName:              'documentData.summary.*.bankName',
    accountHolderName:     'documentData.summary.*.accountHolderName',
    accountNumber:         'documentData.summary.*.accountNumber',
    statementPeriodStart:  'documentData.summary.*.statementPeriodStart',
    statementPeriodEnd:    'documentData.summary.*.statementPeriodEnd',
    openingBalance:        'documentData.summary.*.openingBalance',
    closingBalance:        'documentData.summary.*.closingBalance',
    // Transaction fields (representative per-row fields)
    postingDate:           'documentData.transactions.*.postingDate',
    transactionDescription:'documentData.transactions.*.transactionDescription',
    debitAmount:           'documentData.transactions.*.debitAmount',
    creditAmount:          'documentData.transactions.*.creditAmount',
    txBalance:             'documentData.transactions.*.balance',
    // Common
    fraudScore:            'fraudScore',
    authenticityScore:     'authenticityScore',
  },

  // ── Assertion rules ───────────────────────────────────────────────────────
  // Root structure assertions confirm the shape before field-level checks.
  // type:object — documentData must be a plain object (not an array).
  // type:array  — sub-arrays must be present and non-empty.
  //
  // Summary fields: existence checks (issuer formatting varies).
  // Balance fields: numeric pattern (strong) — zero is valid, so '^-?' prefix included.
  // Transaction fields: all optional — some statements omit individual column values.
  assertionRules: {
    // Document type identity
    'fileType':                                        { assertionType: 'pattern', pattern: '^BankStatement$', strength: 'strong' },
    // Root structure
    'documentData':                                    { assertionType: 'type',    expectedType: 'object', strength: 'strong' },
    'documentData.summary':                            { assertionType: 'type',    expectedType: 'array',  strength: 'strong' },
    'documentData.transactions':                       { assertionType: 'type',    expectedType: 'array',  strength: 'strong', optional: true },
    // Summary identity / period fields
    'documentData.summary.*.bankName':                 { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.summary.*.accountHolderName':        { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.summary.*.accountNumber':            { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.summary.*.statementPeriodStart':     { assertionType: 'exists',  pattern: '.+',                strength: 'weak',   optional: true },
    'documentData.summary.*.statementPeriodEnd':       { assertionType: 'exists',  pattern: '.+',                strength: 'weak',   optional: true },
    // Balance fields
    'documentData.summary.*.openingBalance':           { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.summary.*.closingBalance':           { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    // Transaction fields (all optional — column presence varies by issuer)
    'documentData.transactions.*.postingDate':         { assertionType: 'exists',  pattern: '.+',                strength: 'weak',   optional: true },
    'documentData.transactions.*.debitAmount':         { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.transactions.*.creditAmount':        { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    'documentData.transactions.*.balance':             { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong', optional: true },
    // Common
    'fraudScore':                                      { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'authenticityScore':                               { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
  },

  // ── Field focus rules ─────────────────────────────────────────────────────
  fieldFocusRules: [
    {
      keywords: ['balance', 'opening balance', 'closing balance', 'ending balance', 'beginning balance'],
      focus: 'bank_balance',
      fields: ['documentData.summary.*.openingBalance', 'documentData.summary.*.closingBalance'],
    },
    {
      keywords: ['transaction', 'transactions', 'transaction history', 'activity'],
      focus: 'bank_transactions',
      fields: ['documentData.transactions'],
    },
    {
      keywords: ['account number', 'account name', 'account holder', 'bank name', 'issuer'],
      focus: 'bank_identity',
      fields: [
        'documentData.summary.*.accountNumber',
        'documentData.summary.*.accountHolderName',
        'documentData.summary.*.bankName',
      ],
    },
    {
      keywords: ['statement period', 'statement date', 'billing period', 'period covered'],
      focus: 'bank_period',
      fields: ['documentData.summary.*.statementPeriodStart', 'documentData.summary.*.statementPeriodEnd'],
    },
    {
      keywords: ['gcash', 'total in', 'total out', 'cash in', 'cash out', 'e-wallet'],
      focus: 'gcash_summary',
      fields: ['documentData.transactions'],
    },
  ],

  // ── Completeness scoring ─────────────────────────────────────────────────────
  // docArrayPath: ordered list of response paths to try when resolving the items array.
  //   The runner uses the first path that resolves to a non-empty array.
  //   documentData.summary is the canonical bank-statement path; summaryOCR and
  //   summaryResult are fallbacks for legacy / alternate response shapes.
  //
  // Field keys are looked up in each item first, then at the response root level.
  // This allows OR-groups like ['bankName', 'gs_bankname_bankstatement'] to match
  // whether the field is in the summary item or in a root-level GS computed field.
  completenessScoring: {
    thresholds:   { pass: 90, warn: 70 },
    docArrayPath: ['documentData.summary', 'summaryOCR', 'summaryResult'],
    required: [
      { field:  'accountHolderName',                              points: 30 },
      { fields: ['bankName', 'gs_bankname_bankstatement'],        points: 25 },
      { field:  'accountNumber',                                  points: 10 },
      { fields: ['calculated_credits', 'summary_credits'],        points:  8 },
      { fields: ['calculated_debits',  'summary_debits'],         points:  8 },
    ],
    optional: [
      { field: 'statementPeriodStart', points: 5 },
      { field: 'statementPeriodEnd',   points: 5 },
      { field: 'openingBalance',       points: 3 },
      { field: 'closingBalance',       points: 3 },
      { field: 'billingAddress',       points: 2 },
      { field: 'currency',             points: 1 },
    ],
  },

  // ── Computed (cross-field) validations ──────────────────────────────────────
  // Safe checks only — do not enforce exact balance math (opening + credits - debits
  // = closing) since the statement may cover a partial period or contain missing rows.
  computedValidations: [
    {
      check: 'bank_closing_balance_non_negative',
      description: 'closingBalance ≥ 0',
      tolerance: 0,
      paths: {
        closingBalance: 'documentData.summary.*.closingBalance',
      },
    },
    {
      check: 'bank_total_credits_gte_debits',
      description: 'totalCredits ≥ totalDebits (optional — requires complete statement data)',
      tolerance: 0,
      // Only meaningful when the response includes aggregated credit/debit totals.
      // Skipped by default; remove skipByDefault to enable for confirmed complete statements.
      skipByDefault: true,
      paths: {
        totalCredits:   'calculated_credits',
        summaryCredits: 'summary_credits',
        totalDebits:    'calculated_debits',
        summaryDebits:  'summary_debits',
      },
    },
    {
      check: 'bank_transaction_count_positive',
      description: 'documentData.transactions has at least one entry',
      tolerance: 0,
      paths: {
        transactions: 'documentData.transactions',
      },
    },
  ],

  // ── Fixture requirement rules ─────────────────────────────────────────────
  fixtureRequirementRules: {
    bank_balance:      ['bank statement with opening and closing balance'],
    bank_transactions: ['bank statement with transaction history'],
    bank_identity:     ['bank statement with account details visible'],
    bank_period:       ['bank statement with statement period'],
    gcash_summary:     ['gcash transaction history'],
    _default:          ['complete bank statement'],
  },
};
