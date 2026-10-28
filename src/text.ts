import type { ArgumentLine, JsonSchema } from './types.js';

/** Results longer than this many characters are cut before they reach the model. */
export const DEFAULT_MAX_RESULT_CHARS = 4000;

export const NAVIGATED_TEXT = 'The tool started a page navigation, so no result came back.';

export interface NormalizedResult {
  text: string;
  isError: boolean;
  navigated: boolean;
}

/**
 * Turns whatever a tool returned into text for the model:
 * - `null` means the call navigated the page (WebMCP's `executeTool` contract);
 * - `{ content: [{ type: 'text', text }] }` (the MCP shape) is joined to its text parts;
 * - strings pass through; other values are JSON-encoded;
 * - the result is cut at `maxChars`.
 */
export function resultToText(result: unknown, maxChars = DEFAULT_MAX_RESULT_CHARS): NormalizedResult {
  if (result === null) return { text: NAVIGATED_TEXT, isError: false, navigated: true };
  let text: string;
  let isError = false;
  if (result === undefined) {
    text = 'Done (the tool returned nothing).';
  } else if (typeof result === 'string') {
    text = result;
  } else if (isContentResult(result)) {
    isError = result.isError === true;
    text = result.content
      .map((part) => {
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        const kind = typeof part === 'object' && part !== null ? String((part as { type?: unknown }).type ?? 'item') : 'item';
        return `[${kind} omitted]`;
      })
      .filter((t) => t.length > 0)
      .join('\n');
    if (!text) text = 'Done (the tool returned no text).';
  } else {
    try {
      text = JSON.stringify(result) ?? String(result);
    } catch {
      text = String(result);
    }
  }
  return { text: truncate(text, maxChars), isError, navigated: false };
}

function isContentResult(value: unknown): value is { content: unknown[]; isError?: unknown } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[cut: ${text.length - maxChars} more characters]`;
}

/** The tag that fences output from tools marked `untrustedContentHint`. */
export const UNTRUSTED_TAG = 'untrusted-data';

/**
 * Wraps untrusted tool output in a data block. Any opening or closing tag of the same name inside
 * the content is escaped, so the content cannot end the block early or open a new one.
 */
export function fenceUntrusted(toolName: string, content: string): string {
  const escaped = content.replace(/<(\s*\/?\s*)(untrusted-data)/gi, '&lt;$1$2');
  const name = toolName.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `<${UNTRUSTED_TAG} tool="${name}">\n${escaped}\n</${UNTRUSTED_TAG}>`;
}

/** `productId` and `product_id` both become "Product id". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
    return value.map(formatValue).join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The arguments of a call in plain words: one labeled line per argument. */
export function describeArguments(args: Record<string, unknown>, schema?: JsonSchema): ArgumentLine[] {
  const properties = (schema?.properties ?? {}) as Record<string, { title?: unknown }>;
  return Object.entries(args).map(([key, value]) => {
    const title = properties[key]?.title;
    return {
      key,
      label: typeof title === 'string' && title.trim() ? title.trim() : humanizeKey(key),
      value: formatValue(value),
    };
  });
}
