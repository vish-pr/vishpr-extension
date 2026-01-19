/**
 * Summarize utility tests - Run: npx tsx modules/summarize.test.ts
 */
import { summarize } from './summarize.js';

let failed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  }
};

// Test: short strings pass through unchanged
{
  const input = 'short string';
  const result = summarize(input, { maxStringLength: 100 });
  assert(result === input, 'short string should pass through unchanged');
}

// Test: long strings are truncated with markers
{
  const input = 'a'.repeat(1000);
  const result = summarize(input, { maxStringLength: 300 }) as string;
  assert(result.length < input.length, 'long string should be truncated');
  assert(result.includes('more chars'), 'truncated string should include char count marker');
}

// Test: small arrays pass through (with recursive summarization)
{
  const input = [1, 2, 3];
  const result = summarize(input, { maxArrayLength: 10 }) as unknown[];
  assert(result.length === 3, 'small array should keep all items');
}

// Test: large arrays are truncated with markers
// maxArrayLength: 20 → itemsPerPhase = floor(20/2.2) = 9 → output: 9 + marker + 9 = 19 items
{
  const input = Array.from({ length: 100 }, (_, i) => i);
  const result = summarize(input, { maxArrayLength: 20 }) as unknown[];
  assert(result.length === 19, 'large array should have 9 + marker + 9 items');
  assert(typeof result[9] === 'string' && result[9].includes('more items'), 'should include items count marker');
  assert(result[0] === 0, 'first items should be preserved');
  assert(result[18] === 99, 'last items should be preserved');
}

// Test: small objects pass through
{
  const input = { a: 1, b: 2 };
  const result = summarize(input, { maxObjectKeys: 10 }) as Record<string, unknown>;
  assert(Object.keys(result).length === 2, 'small object should keep all keys');
}

// Test: large objects are truncated
{
  const input: Record<string, number> = {};
  for (let i = 0; i < 50; i++) input[`key${i}`] = i;
  const result = summarize(input, { maxObjectKeys: 10 }) as Record<string, unknown>;
  assert(Object.keys(result).length < 50, 'large object should be truncated');
  assert('__skipped__' in result, 'should include skipped marker');
}

// Test: nested structures are summarized recursively
// maxArrayLength: 10 → itemsPerPhase = floor(10/2.2) = 4 → output: 4 + marker + 4 = 9 items
{
  const input = {
    text: 'x'.repeat(2000),
    items: Array.from({ length: 50 }, (_, i) => i),
    nested: { deep: 'y'.repeat(2000) }
  };
  const result = summarize(input, {
    maxStringLength: 1000,
    maxArrayLength: 10,
  }) as Record<string, unknown>;

  assert((result.text as string).includes('more chars'), 'nested string should be truncated');
  assert((result.items as unknown[]).length === 9, 'nested array should be truncated (4 + marker + 4)');
  assert(((result.nested as Record<string, string>).deep).includes('more chars'), 'deeply nested string should be truncated');
}

// Test: max depth is respected
{
  const input = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
  const result = summarize(input, { maxDepth: 3 }) as Record<string, unknown>;
  assert(typeof result === 'object', 'should return object at shallow depths');
}

// Test: null and undefined pass through
{
  assert(summarize(null) === null, 'null should pass through');
  assert(summarize(undefined) === undefined, 'undefined should pass through');
}

// Test: primitives pass through
{
  assert(summarize(42) === 42, 'numbers should pass through');
  assert(summarize(true) === true, 'booleans should pass through');
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('All summarize tests passed');
}
