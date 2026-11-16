import { oidcHttpFixture } from '../helpers/oidc-http-fixture';
import { DatabaseMetricsSampler } from '../../src/infrastructure/telemetry/database-metrics.sampler';
import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('Read-only database metrics sampler', () => {
  it('exports bounded state gauges without changing financial resources', async () => {
    const f = await oidcHttpFixture();
    try {
      await f.clear();
      const wallet = await f.wallet();
      await f.app
        .get(WagerProcessingService)
        .quarantineMessage('sampler', 'invalid', 'INVALID_MESSAGE', '{invalid', 1);
      const metrics = new MetricsService();
      await new DatabaseMetricsSampler(f.orm.em.fork(), metrics).collect();
      const text = metrics.renderPrometheus();
      expect(text).toContain('quarantine_messages{status="OPEN"} 1');
      expect(text).toContain('outbox_pending_messages 2');
      expect(text).toContain('database_metrics_collection_success 1');
      expect(text).not.toContain(wallet.walletId);
      expect(text).not.toContain(wallet.playerId);
      expect((await f.http(`/wallets/${wallet.walletId}`)).body).toMatchObject({
        balance: { amount: '100.00' },
        version: 1,
      });
    } finally {
      await f.clear();
      await f.close();
    }
  });
});
