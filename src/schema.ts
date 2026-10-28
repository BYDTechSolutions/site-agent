import type { JsonSchema } from './types.js';

/**
 * A deliberately small JSON Schema check for tool arguments: `type` (including arrays of types),
 * `required`, `properties`, `additionalProperties: false`, `enum`, `const` and `items`, recursively.
 * Anything else in the schema is ignored. Returns a list of problems, empty when the value passes.
 */
export function validateArgs(schema: JsonSchema | undefined, value: unknown): string[] {
  const problems: string[] = [];
  check(schema ?? { type: 'object' }, value, '', problems, 0);
  return problems;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function check(schema: JsonSchema, value: unknown, path: string, problems: string[], depth: number): void {
  if (depth > 20) return;
  const where = path || 'arguments';
  const actual = typeOf(value);

  const type = schema.type;
  if (typeof type === 'string' || Array.isArray(type)) {
    const types = (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === 'string');
    if (types.length > 0 && !types.some((t) => matchesType(t, actual))) {
      problems.push(`${where} should be ${types.join(' or ')}, got ${actual}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value))) {
    problems.push(`${where} should be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`);
  }
  if ('const' in schema && !sameValue(schema.const, value)) {
    problems.push(`${where} should be ${JSON.stringify(schema.const)}`);
  }

  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    const properties = isSchema(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && object[key] === undefined) problems.push(`${join(path, key)} is required`);
      }
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (isSchema(childSchema)) check(childSchema, child, join(path, key), problems, depth + 1);
      else if (schema.additionalProperties === false) problems.push(`${join(path, key)} is not an allowed property`);
    }
  }

  if (actual === 'array' && isSchema(schema.items)) {
    (value as unknown[]).forEach((item, i) => check(schema.items as JsonSchema, item, `${where}[${i}]`, problems, depth + 1));
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Tool input schemas may arrive as JSON strings from some browsers; this always returns an object schema. */
export function normalizeSchema(schema: unknown): JsonSchema {
  let value = schema;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  if (!isSchema(value)) return { type: 'object', properties: {} };
  return value;
}
