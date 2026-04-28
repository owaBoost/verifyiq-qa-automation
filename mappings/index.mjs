/**
 * Mapping registry — central resolver for document-type learning profiles.
 *
 * Usage:
 *   import { resolveMapping } from '../../mappings/index.mjs';
 *   const { mapping, confidence, profile } = resolveMapping(documentCategory);
 *
 * confidence: 'learned' — a typed, field-specific mapping exists for this doc type.
 *             'generic' — no learned mapping; broad smoke-test assertions are used.
 *
 * To add a new document type:
 *   1. Find the right family file (payslip, bank-statement, utility-bill,
 *      employment-document, identity-document, kyb-document). If none fits,
 *      create a new mappings/<family>.mjs using payslip.mjs as the template.
 *   2. Add the parseFileTypes / batchDocumentTypes / aliases / paths to that file.
 *   3. Register it in LEARNED_MAPPINGS below, keyed by documentCategory string.
 *   4. The planner, generator, and reporter pick it up automatically.
 *
 * Document family → documentCategory key:
 *   payslip.mjs              → 'payslip'
 *   bank-statement.mjs       → 'bank-statement'
 *   utility-bill.mjs         → 'utility-bill'
 *   employment-document.mjs  → 'employment-document'
 *   identity-document.mjs    → 'identity-document'
 *   kyb-document.mjs         → 'kyb-document'
 */

import { mapping as payslip }             from './payslip.mjs';
import { mapping as bankStatement }        from './bank-statement.mjs';
import { mapping as utilityBill }          from './utility-bill.mjs';
import { mapping as employmentDocument }   from './employment-document.mjs';
import { mapping as identityDocument }     from './identity-document.mjs';
import { mapping as kybDocument }          from './kyb-document.mjs';
import { mapping as generic }              from './generic.mjs';

// All learned document mappings, keyed by documentCategory string.
const LEARNED_MAPPINGS = {
  'payslip':              payslip,
  'bank-statement':       bankStatement,
  'utility-bill':         utilityBill,
  'employment-document':  employmentDocument,
  'identity-document':    identityDocument,
  'kyb-document':         kybDocument,
};

/**
 * Resolve the mapping profile for a given documentCategory.
 *
 * @param {string|null} documentCategory
 * @returns {{
 *   mapping: object,
 *   confidence: 'learned'|'generic',
 *   profile: string
 * }}
 */
export function resolveMapping(documentCategory) {
  const learned = documentCategory ? LEARNED_MAPPINGS[documentCategory] ?? null : null;
  if (learned) {
    return { mapping: learned, confidence: 'learned', profile: learned.documentCategory };
  }
  return { mapping: generic, confidence: 'generic', profile: 'generic' };
}

export { generic, LEARNED_MAPPINGS };
