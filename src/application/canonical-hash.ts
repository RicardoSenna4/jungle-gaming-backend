import { createHash } from 'node:crypto';
export function canonicalHash(value: Record<string, unknown>): string {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v && typeof v === 'object'
        ? Object.keys(v as Record<string, unknown>)
            .sort()
            .reduce((o, k) => ({ ...o, [k]: ordered((v as Record<string, unknown>)[k]) }), {})
        : v;
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}
