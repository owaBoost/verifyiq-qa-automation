/**
 * Utility bill document family mapping — learned profile.
 *
 * Covers all utility / services billing statement document types:
 *   ElectricUtilityBillingStatement — electricity bills (Meralco, etc.)
 *   WaterUtilityBillingStatement    — water bills (Maynilad, Manila Water, etc.)
 *   TelcoBill                       — generic telco bill
 *   ConvergeTelcoBill               — Converge ICT
 *   DitoTelcoBill                   — Dito Telecommunity
 *   GlobeTelcoBill                  — Globe Telecom
 *   PLDTTelcoBill                   — PLDT
 *   SkyCableTelcoBill               — Sky Cable
 *   SmartTelcoBill                  — Smart Communications
 *
 * Core billing fields (accountNumber, amountDue, dueDate, billingPeriod) are
 * shared across all issuers. Add issuer-specific paths as they are confirmed
 * by running against real fixtures and observing the API response shape.
 *
 * Do NOT create a separate file per utility type — expand this file instead.
 */

export const mapping = {
  documentCategory: 'utility-bill',
  parseFileTypes: [
    'ElectricUtilityBillingStatement',
    'WaterUtilityBillingStatement',
    'TelcoBill',
    'ConvergeTelcoBill',
    'DitoTelcoBill',
    'GlobeTelcoBill',
    'PLDTTelcoBill',
    'SkyCableTelcoBill',
    'SmartTelcoBill',
  ],
  batchDocumentTypes: [
    'ELECTRIC_UTILITY_BILLING_STATEMENT',
    'WATER_UTILITY_BILLING_STATEMENT',
    'TELCO_BILL',
    'CONVERGE_TELCO_BILL',
    'DITO_TELCO_BILL',
    'GLOBE_TELCO_BILL',
    'PLDT_TELCO_BILL',
    'SKY_CABLE_TELCO_BILL',
    'SMART_TELCO_BILL',
  ],
  aliases: [
    'electricity bill', 'electric bill', 'meralco', 'meralco bill',
    'water bill', 'maynilad', 'manila water',
    'telco bill', 'telecobill', 'converge', 'dito', 'globe', 'pldt', 'sky cable', 'smart',
    'utility bill', 'utilities',
  ],

  // ── Canonical field name → /v1/documents/parse response path ─────────────
  responsePaths: {
    accountNumber:   'documentData.*.accountNumber',
    customerName:    'documentData.*.customerName',
    serviceAddress:  'documentData.*.serviceAddress',
    billingPeriod:   'documentData.*.billingPeriod',
    amountDue:       'documentData.*.amountDue',
    dueDate:         'documentData.*.dueDate',
    previousBalance: 'documentData.*.previousBalance',
    currentCharges:  'documentData.*.currentCharges',
    // Electricity-specific
    kwhConsumption:  'documentData.*.kwhConsumption',
    // Telco-specific
    planName:        'documentData.*.planName',
    // Common
    fraudScore:      'fraudScore',
    authenticityScore: 'authenticityScore',
  },

  // ── Assertion rules ───────────────────────────────────────────────────────
  // amountDue and numeric amounts: pattern-match when confirmed.
  // Text / date fields: existence check (issuer formatting varies).
  assertionRules: {
    'documentData.*.accountNumber':   { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.customerName':    { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.serviceAddress':  { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.billingPeriod':   { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.amountDue':       { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.dueDate':         { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'documentData.*.previousBalance': { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.currentCharges':  { assertionType: 'pattern', pattern: '^-?[0-9][0-9,.]*$', strength: 'strong' },
    'documentData.*.kwhConsumption':  { assertionType: 'pattern', pattern: '^[0-9][0-9,.]*$',   strength: 'strong' },
    'fraudScore':                     { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
    'authenticityScore':              { assertionType: 'exists',  pattern: '.+',                strength: 'weak'   },
  },

  // ── Field focus rules ─────────────────────────────────────────────────────
  fieldFocusRules: [
    {
      keywords: ['amount due', 'total amount', 'total due', 'balance due', 'payment due', 'bill amount'],
      focus: 'bill_amount',
      fields: ['documentData.*.amountDue', 'documentData.*.previousBalance', 'documentData.*.currentCharges'],
    },
    {
      keywords: ['due date', 'payment deadline', 'pay by', 'disconnection date'],
      focus: 'bill_due_date',
      fields: ['documentData.*.dueDate', 'documentData.*.amountDue'],
    },
    {
      keywords: ['billing period', 'period covered', 'billing month', 'reading period'],
      focus: 'bill_period',
      fields: ['documentData.*.billingPeriod'],
    },
    {
      keywords: ['account number', 'service number', 'customer name', 'service address', 'account holder'],
      focus: 'bill_identity',
      fields: ['documentData.*.accountNumber', 'documentData.*.customerName', 'documentData.*.serviceAddress'],
    },
    {
      keywords: ['kwh', 'consumption', 'kilowatt', 'electricity usage', 'power consumption'],
      focus: 'bill_consumption',
      fields: ['documentData.*.kwhConsumption'],
    },
  ],

  // ── Completeness scoring ─────────────────────────────────────────────────────
  // Modelled on electricity bill fields (Meralco / generic electric utility).
  // OR-field groups: points awarded if any member field is present.
  // Fields checked in documentData[] items AND at response root level.
  completenessScoring: {
    thresholds: { pass: 90, warn: 70 },
    required: [
      { field:  'accountName',                                          points: 25 },
      { field:  'billingAddress',                                       points: 20 },
      { field:  'utilityProviderName',                                  points: 10 },
      { field:  'accountNumber',                                        points: 10 },
      { fields: ['totalAmountDue', 'gs_amountdue_elecbill'],            points:  8 },
      { field:  'billPeriodStart',                                      points:  5 },
      { field:  'billPeriodEnd',                                        points:  5 },
      { field:  'dueDate',                                              points:  5 },
      { field:  'billDate',                                             points:  4 },
      { field:  'currentCharges',                                       points:  4 },
    ],
    optional: [
      { fields: ['gs_previousbalance_elecbill', 'previousBalance'],    points:  2 },
      { field:  'billNumber',                                           points:  2 },
    ],
  },

  // ── Fixture requirement rules ─────────────────────────────────────────────
  fixtureRequirementRules: {
    bill_amount:      ['utility bill with amount due visible'],
    bill_due_date:    ['utility bill with due date'],
    bill_period:      ['utility bill with billing period'],
    bill_identity:    ['utility bill with account number and customer name'],
    bill_consumption: ['electricity bill with kwh consumption'],
    _default:         ['complete utility bill'],
  },
};
