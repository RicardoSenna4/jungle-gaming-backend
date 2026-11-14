import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';

describe('MetricsService', () => {
  it('renders counters, gauges and cumulative histogram buckets with escaped labels', () => {
    const metrics = new MetricsService();
    metrics.increment('wager_transactions_total', { source: 'http', status: 'processed' }, 2);
    metrics.setGauge('outbox_pending_messages', 3);
    metrics.observe('wager_processing_duration_seconds', 0.08, { source: 'sqs' });

    const output = metrics.renderPrometheus();
    expect(output).toContain('wager_transactions_total{source="http",status="processed"} 2');
    expect(output).toContain('outbox_pending_messages 3');
    expect(output).toContain('wager_processing_duration_seconds_bucket{source="sqs",le="0.1"} 1');
    expect(output).toContain('wager_processing_duration_seconds_count{source="sqs"} 1');
  });

  it('escapes Prometheus label values', () => {
    const metrics = new MetricsService();
    metrics.increment('sqs_messages_unacked_total', { reason: 'bad"value' });
    expect(metrics.renderPrometheus()).toContain('reason="bad\\"value"');
  });
});
