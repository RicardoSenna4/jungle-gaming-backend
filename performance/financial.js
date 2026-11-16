import http from 'k6/http';
import { check, fail } from 'k6';
import execution from 'k6/execution';
import { Rate } from 'k6/metrics';

if (__ENV.LOAD_DISPOSABLE !== 'yes' || __ENV.BASE_URL !== 'http://api:3000')
  throw new Error('Run only through the dedicated disposable Compose');
const scenario = __ENV.SCENARIO;
if (!['parallel', 'hot', 'limited', 'replays', 'mixed'].includes(scenario))
  throw new Error('Unknown scenario');
const base = __ENV.BASE_URL;
const unexpected = new Rate('unexpected_failure');
http.setResponseCallback(http.expectedStatuses(200, 201, 422));
export const options = {
  scenarios: {
    financial: { executor: 'shared-iterations', vus: 4, iterations: 20, maxDuration: '2m' },
  },
  thresholds: { checks: ['rate==1'], unexpected_failure: ['rate==0'] },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};
function post(path, body, key) {
  return http.post(`${base}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key || 'unused' },
    tags: { name: path.startsWith('/wallets/') ? '/wallets/:id/reconciliation' : path },
  });
}
function payload(w, kind, amount, id, reference) {
  return {
    providerId: 'load',
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'load',
    gameId: 'load',
    externalTransactionId: id,
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}
function submit(w, kind, amount, id, reference) {
  const r = post('/wagering/transactions', payload(w, kind, amount, id, reference), id);
  unexpected.add(![200, 422].includes(r.status));
  check(r, { 'financial response expected': (r) => r.status === 200 });
  return r;
}
export function setup() {
  const count = scenario === 'limited' ? 20 : ['parallel', 'mixed'].includes(scenario) ? 4 : 1;
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const r = post('/wallets', {
      playerId: `load-${scenario}-${i}`,
      initialBalance: { amount: scenario === 'limited' ? '100.00' : '1000.00', currency: 'BRL' },
    });
    if (r.status !== 201) fail(`Wallet setup failed ${r.status}`);
    wallets.push(r.json());
  }
  if (scenario === 'replays') submit(wallets[0], 'BET', '1.00', 'replay-stable');
  return wallets;
}
export default function (wallets) {
  const iteration = execution.scenario.iterationInTest;
  const w = wallets[scenario === 'limited' ? iteration : (__VU - 1) % wallets.length];
  const id = `${scenario}-${iteration}`;
  if (scenario === 'limited') {
    const responses = http.batch(
      [0, 1].map((n) => ({
        method: 'POST',
        url: `${base}/wagering/transactions`,
        body: JSON.stringify(payload(w, 'BET', '80.00', `${id}-${n}`)),
        params: {
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-${n}` },
          tags: { name: '/wagering/transactions' },
        },
      })),
    );
    const statuses = responses.map((r) => r.status).sort();
    const ok = statuses[0] === 200 && statuses[1] === 422;
    unexpected.add(!ok);
    check(ok, { 'exactly one limited BET wins': (v) => v });
  } else if (scenario === 'replays') {
    const r = submit(w, 'BET', '1.00', 'replay-stable');
    check(r, { 'persistent replay': (r) => r.json('idempotentReplay') === true });
  } else if (scenario === 'mixed') {
    submit(w, 'BET', '2.00', `${id}-bet`);
    submit(w, 'WIN', '1.00', `${id}-win`);
    submit(w, 'LOSS', '1.00', `${id}-loss`);
    submit(w, 'REFUND', '2.00', `${id}-refund`, `${id}-bet`);
    submit(w, 'ROLLBACK', '1.00', `${id}-rollback`, `${id}-win`);
  } else submit(w, 'BET', '1.00', id);
}
export function teardown(wallets) {
  for (const w of wallets) {
    const r = post(`/wallets/${w.id}/reconciliation`, {});
    check(r, {
      'ledger reconciles after load': (r) => r.status === 200 && r.json('consistent') === true,
    });
  }
}
export function handleSummary(data) {
  return { [`/results/${scenario}.json`]: JSON.stringify(data, null, 2) };
}
