/**
 * Lightweight JSON Schema validator.
 *
 * Supports the subset of JSON Schema used by our endpoint schemas:
 *   - type (string, number, boolean, object, array, integer)
 *   - required (array of property names)
 *   - properties (recurse)
 *   - pattern (regex on strings)
 *   - items (for arrays)
 *
 * No external dependencies — keeps the repo lightweight.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, '..', 'schemas');

// ── Schema registry ─────────────────────────────────────────────────────────

let _registry = null;

function loadRegistry() {
  if (_registry) return _registry;
  const regPath = join(SCHEMAS_DIR, '_registry.json');
  if (!existsSync(regPath)) return [];
  const raw = JSON.parse(readFileSync(regPath, 'utf8'));
  _registry = (raw.schemas || []).map(entry => ({
    regex: new RegExp(entry.pattern),
    file: entry.file,
  }));
  return _registry;
}

/**
 * Find the schema file for a given endpoint path.
 * Returns the parsed schema object, or null if no match.
 */
export function findSchema(endpoint) {
  const registry = loadRegistry();
  for (const entry of registry) {
    if (entry.regex.test(endpoint)) {
      const schemaPath = join(SCHEMAS_DIR, entry.file);
      if (!existsSync(schemaPath)) return null;
      return JSON.parse(readFileSync(schemaPath, 'utf8'));
    }
  }
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a value against a JSON Schema node.
 * Returns an array of error strings (empty = valid).
 */
export function validate(value, schema, path = '$') {
  const errors = [];

  if (!schema || typeof schema !== 'object') return errors;

  // Type check
  if (schema.type) {
    const actualType = getType(value);
    if (schema.type === 'integer') {
      if (!Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${actualType}`);
      }
    } else if (actualType !== schema.type) {
      errors.push(`${path}: expected ${schema.type}, got ${actualType}`);
      return errors; // no point checking deeper if type is wrong
    }
  }

  // Pattern (strings only)
  if (schema.pattern && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
    }
  }

  // Required properties (objects only)
  if (schema.required && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!(key in value) || value[key] === undefined) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
  }

  // Recurse into properties
  if (schema.properties && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        errors.push(...validate(value[key], propSchema, `${path}.${key}`));
      }
    }
  }

  // Array items
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validate(value[i], schema.items, `${path}[${i}]`));
    }
  }

  return errors;
}

function getType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
