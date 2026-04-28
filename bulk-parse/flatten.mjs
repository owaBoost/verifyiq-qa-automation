/**
 * flatten.mjs — Recursively flatten a nested JSON response into dot-path keys.
 *
 * Designed for adaptive reporting: works with any document type without
 * knowing the schema ahead of time.
 */

const MAX_STRING_LEN = 1000;

/**
 * Flatten a nested object into a single-depth object with dot-path keys.
 *
 * @param {*} data            The object to flatten
 * @param {object} opts
 * @param {string} opts.prefix    Key prefix for recursion (default '')
 * @param {number} opts.maxDepth  Max recursion depth (default 10)
 * @returns {Record<string, string|number|boolean|null>}
 */
export function flattenResponse(data, { prefix = '', maxDepth = 10 } = {}) {
  const result = {};

  function walk(obj, path, depth) {
    if (depth > maxDepth) return;
    if (obj === null || obj === undefined) {
      result[path] = null;
      return;
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const key = path ? `${path}[${i}]` : `[${i}]`;
        walk(obj[i], key, depth + 1);
      }
      return;
    }

    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue;
        const key = path ? `${path}.${k}` : k;
        walk(v, key, depth + 1);
      }
      return;
    }

    // Primitive
    if (typeof obj === 'string' && obj.length > MAX_STRING_LEN) {
      result[path] = obj.substring(0, MAX_STRING_LEN) + ' ... [truncated, see raw JSON]';
    } else {
      result[path] = obj;
    }
  }

  walk(data, prefix, 0);
  return result;
}

/**
 * Given an array of flattened records, return the sorted union of all keys.
 *
 * Sort order:
 *   1. documentData.* fields (extracted document content)
 *   2. qualityCheck.* / qualityScore / documentQuality
 *   3. completenessCheck.* / completenessScore / completenessBreakdown
 *   4. fraudChecks.* / fraudReport / fraudScore / mathematicalFraudReport / metadataFraudReport
 *   5. crossCheck.* / crosscheckResults
 *   6. Everything else, alphabetically
 *
 * @param {Array<Record<string, *>>} records  Array of flattened objects
 * @returns {string[]}  Sorted column names
 */
export function extractAllColumns(records) {
  const allKeys = new Set();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      allKeys.add(k);
    }
  }

  const groups = [
    { prefix: 'summaryOCR', keys: [] },
    { prefix: 'summaryResult', keys: [] },
    { prefix: 'aggregatedFields', keys: [] },
    { prefix: 'calculatedFields', keys: [] },
    { prefix: 'qualityCheck', keys: [] },
    { prefix: 'qualityScore', keys: [] },
    { prefix: 'documentQuality', keys: [] },
    { prefix: 'completenessScore', keys: [] },
    { prefix: 'completenessBreakdown', keys: [] },
    { prefix: 'fraudScore', keys: [] },
    { prefix: 'authenticityScore', keys: [] },
    { prefix: 'fraudReport', keys: [] },
    { prefix: 'fraudCheckFindings', keys: [] },
    { prefix: 'mathematicalFraudReport', keys: [] },
    { prefix: 'metadataFraudReport', keys: [] },
    { prefix: 'crosscheckResults', keys: [] },
    { prefix: 'transactionsOCR', keys: [] },
    { prefix: 'gshare_fields', keys: [] },
    { prefix: 'timings', keys: [] },
  ];

  const rest = [];

  for (const key of allKeys) {
    let placed = false;
    for (const g of groups) {
      if (key === g.prefix || key.startsWith(g.prefix + '.') || key.startsWith(g.prefix + '[')) {
        g.keys.push(key);
        placed = true;
        break;
      }
    }
    if (!placed) rest.push(key);
  }

  const sorted = [];
  for (const g of groups) {
    sorted.push(...g.keys.sort());
  }
  sorted.push(...rest.sort());

  return sorted;
}
