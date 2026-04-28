/**
 * Generic document mapping — fallback profile.
 *
 * Used when no learned mapping exists for the detected document type.
 * Assertions are intentionally broad and safe: they verify the response has
 * the expected top-level structure without making field-level claims.
 *
 * A generic-confidence run will always pass for a healthy API but will NOT
 * catch field extraction regressions. The reporter surfaces "generic" confidence
 * so reviewers know to treat the result as a smoke test, not a regression gate.
 *
 * When a new document type is encountered and its response shape is confirmed,
 * create mappings/<document-type>.mjs with typed field assertions, then register
 * it in mappings/index.mjs. That upgrades the run from generic → learned.
 */

export const mapping = {
  documentCategory: 'generic',
  parseFileTypes: [],
  batchDocumentTypes: [],
  aliases: [],

  responsePaths: {},

  // ── Broad structural assertions ──────────────────────────────────────────
  // These pass for any healthy document parse response.
  // No field-level patterns — value shapes are unknown for unlearned types.
  // documentData shape varies by document type (array for payslip, object for
  // bank-statement) — use 'exists' here rather than a type assertion so the
  // generic fallback doesn't hard-fail on non-array responses.
  assertionRules: {
    'applicationId':    { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'documentData':     { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'fileType':         { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'extractionStatus': { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'qualityScore':     { assertionType: 'exists', pattern: '.+', strength: 'weak' },
    'fraudScore':       { assertionType: 'exists', pattern: '.+', strength: 'weak' },
  },

  // No document-specific keyword rules — universal rules in the planner apply.
  fieldFocusRules: [],

  fixtureRequirementRules: {
    _default: ['complete document'],
  },
};
