import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../src/application/wallets/wallet-repository';

describe('ledger cursor', () => {
  it('round-trips an opaque stable cursor', () => {
    const value = {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '00000000-0000-0000-0000-000000000001',
    };
    const encoded = encodeLedgerCursor(value);
    expect(encoded).not.toContain(value.id);
    expect(decodeLedgerCursor(encoded)).toEqual(value);
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeLedgerCursor('not-a-cursor')).toThrow('INVALID_LEDGER_CURSOR');
    expect(() =>
      decodeLedgerCursor(
        encodeLedgerCursor({
          createdAt: 'yesterday',
          id: 'not-a-uuid',
        }),
      ),
    ).toThrow('INVALID_LEDGER_CURSOR');
  });

  it('preserves microsecond precision for stable ledger pagination', () => {
    const value = {
      createdAt: '2026-01-01T00:00:00.123456Z',
      id: '00000000-0000-0000-0000-000000000123',
    };
    expect(decodeLedgerCursor(encodeLedgerCursor(value))).toEqual(value);
  });
});
