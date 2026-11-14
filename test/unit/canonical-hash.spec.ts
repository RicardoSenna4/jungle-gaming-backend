import { canonicalHash } from '../../src/application/canonical-hash';
test('canonical hash ignores object key order but changes business values', () => {
  expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
  expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
});
