import {
  canonicalWagerPayload,
  wagerPayloadHash,
} from '../../src/application/wager-processing.service';

describe('wager payload canonicalization', () => {
  const base = {
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };

  it('normalizes key order and optional reference omission', () => {
    const reordered = {
      money: base.money,
      gameId: base.gameId,
      kind: base.kind,
      walletId: base.walletId,
      roundId: base.roundId,
      playerId: base.playerId,
      externalTransactionId: base.externalTransactionId,
      providerId: base.providerId,
      referenceExternalTransactionId: undefined,
    };
    expect(canonicalWagerPayload(base)).toEqual(canonicalWagerPayload(reordered));
    expect(wagerPayloadHash(base)).toBe(wagerPayloadHash(reordered));
  });

  it('changes when a business field changes and excludes transport metadata', () => {
    expect(wagerPayloadHash(base)).not.toBe(wagerPayloadHash({ ...base, kind: 'WIN' }));
    expect(wagerPayloadHash({ ...base, idempotencyKey: 'first', messageId: 'm1' })).toBe(
      wagerPayloadHash({ ...base, idempotencyKey: 'second', messageId: 'm2' }),
    );
  });
});
