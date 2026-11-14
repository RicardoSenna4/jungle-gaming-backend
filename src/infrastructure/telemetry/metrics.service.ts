import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

interface HistogramSeries {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  increment(name: string, labels: Labels = {}, amount = 1): void {
    const key = this.labelKey(labels);
    const series = this.counters.get(name) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + amount);
    this.counters.set(name, series);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const key = this.labelKey(labels);
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(key, value);
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = this.labelKey(labels);
    const series = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const histogram = series.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: new Map(DEFAULT_BUCKETS.map((bucket) => [bucket, 0])),
    };
    histogram.count += 1;
    histogram.sum += value;
    for (const bucket of DEFAULT_BUCKETS) {
      if (value <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    }
    series.set(key, histogram);
    this.histograms.set(name, series);
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, series] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of series) lines.push(`${name}${labels} ${value}`);
    }
    for (const [name, series] of [...this.gauges].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [labels, value] of series) lines.push(`${name}${labels} ${value}`);
    }
    for (const [name, series] of [...this.histograms].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labels, histogram] of series) {
        for (const bucket of DEFAULT_BUCKETS) {
          lines.push(
            `${name}_bucket${this.appendLabel(labels, 'le', String(bucket))} ${histogram.buckets.get(bucket) ?? 0}`,
          );
        }
        lines.push(`${name}_bucket${this.appendLabel(labels, 'le', '+Inf')} ${histogram.count}`);
        lines.push(`${name}_sum${labels} ${histogram.sum}`);
        lines.push(`${name}_count${labels} ${histogram.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private labelKey(labels: Labels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return `{${entries.map(([key, value]) => `${key}="${this.escapeLabel(value)}"`).join(',')}}`;
  }

  private appendLabel(existing: string, key: string, value: string): string {
    const escaped = this.escapeLabel(value);
    if (!existing) return `{${key}="${escaped}"}`;
    return `${existing.slice(0, -1)},${key}="${escaped}"}`;
  }

  private escapeLabel(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
  }
}
