/**
 * Summarize large objects for LLM consumption
 * Truncates strings, arrays, and nested objects to reduce token usage
 */

export interface SummarizeOptions {
  maxStringLength?: number;      // Max chars before truncating strings (default: 1000)
  maxArrayLength?: number;       // Max items before truncating arrays (default: 20)
  maxObjectKeys?: number;        // Max keys to keep in objects (default: 20)
  maxDepth?: number;             // Max recursion depth (default: 10)
}

const DEFAULT_OPTIONS: Required<SummarizeOptions> = {
  maxStringLength: 1000,
  maxArrayLength: 20,
  maxObjectKeys: 20,
  maxDepth: 10,
};

/**
 * Summarize a string: start ... X more chars ... middle ... X more chars ... end
 */
function summarizeString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;

  const segmentLength = Math.floor(maxLength / 3.2);
  const start = str.slice(0, segmentLength);
  const middle = str.slice(
    Math.floor(str.length / 2) - Math.floor(segmentLength / 2),
    Math.floor(str.length / 2) + Math.floor(segmentLength / 2)
  );
  const end = str.slice(-segmentLength);

  const beforeMiddle = Math.floor(str.length / 2) - segmentLength - segmentLength;
  const afterMiddle = str.length - Math.floor(str.length / 2) - segmentLength - segmentLength;

  return `${start}... [${beforeMiddle} more chars] ...${middle}... [${afterMiddle} more chars] ...${end}`;
}

/**
 * Summarize an array: first N items ... X more items ... last N items
 */
function summarizeArray(
  arr: unknown[],
  maxLength: number,
  options: Required<SummarizeOptions>,
  depth: number
): unknown[] {
  const summarizeItem = (item: unknown) => summarizeValue(item, options, depth + 1);

  if (arr.length <= maxLength) {
    return arr.map(summarizeItem);
  }

  const itemsPerPhase = Math.floor(maxLength / 2.2);
  const first = arr.slice(0, itemsPerPhase).map(summarizeItem);
  const last = arr.slice(-itemsPerPhase).map(summarizeItem);
  const skipped = arr.length - itemsPerPhase * 2;

  return [
    ...first,
    `... [${skipped} more items] ...`,
    ...last,
  ];
}

/**
 * Summarize an object: keep first N keys, summarize values recursively
 */
function summarizeObject(
  obj: Record<string, unknown>,
  maxKeys: number,
  options: Required<SummarizeOptions>,
  depth: number
): Record<string, unknown> {
  const keys = Object.keys(obj);

  if (keys.length <= maxKeys) {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = summarizeValue(obj[key], options, depth + 1);
    }
    return result;
  }

  const firstKeys = keys.slice(0, Math.floor(maxKeys / 2));
  const lastKeys = keys.slice(-Math.floor(maxKeys / 2));
  const skipped = keys.length - firstKeys.length - lastKeys.length;

  const result: Record<string, unknown> = {};
  for (const key of firstKeys) {
    result[key] = summarizeValue(obj[key], options, depth + 1);
  }
  result[`__skipped__`] = `... [${skipped} more keys] ...`;
  for (const key of lastKeys) {
    result[key] = summarizeValue(obj[key], options, depth + 1);
  }
  return result;
}

/**
 * Recursively summarize any value
 */
function summarizeValue(
  value: unknown,
  options: Required<SummarizeOptions>,
  depth: number
): unknown {
  // Max depth reached - stringify and truncate
  if (depth >= options.maxDepth) {
    const str = JSON.stringify(value);
    if (str && str.length > 100) {
      return `[truncated at depth ${depth}: ${str.slice(0, 100)}...]`;
    }
    return value;
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle strings
  if (typeof value === 'string') {
    return summarizeString(value, options.maxStringLength);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return summarizeArray(value, options.maxArrayLength, options, depth);
  }

  // Handle objects
  if (typeof value === 'object') {
    return summarizeObject(
      value as Record<string, unknown>,
      options.maxObjectKeys,
      options,
      depth
    );
  }

  // Primitives pass through
  return value;
}

/**
 * Summarize an object tree for LLM consumption
 * Truncates large strings, arrays, and deeply nested structures
 */
export function summarize(value: unknown, options: SummarizeOptions = {}): unknown {
  const opts: Required<SummarizeOptions> = { ...DEFAULT_OPTIONS, ...options };
  return summarizeValue(value, opts, 0);
}
