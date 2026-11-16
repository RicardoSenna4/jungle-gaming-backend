"""Capture native UIs and clearly labelled reports from a disposable local demo."""
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs/gallery'
API = 'http://127.0.0.1:3130'
PROM = 'http://127.0.0.1:9190'
GRAFANA = 'http://127.0.0.1:3131'

def request(url, body=None, key=None):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Idempotency-Key'] = key
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def traffic(stop, summary):
    try:
        wallets = []
        for i in range(5):
            status, w = request(API + '/wallets', {'playerId': f'gallery-traffic-{time.time_ns()}-{i}', 'initialBalance': {'amount': '0.00' if i == 4 else '1000.00', 'currency': 'BRL'}})
            assert status == 201
            wallets.append(w)
        i = 0
        while not stop.is_set():
            reject = i % 8 == 0
            w = wallets[4 if reject else i % 4]
            kind = 'WIN' if not reject and i % 5 == 0 else 'BET'
            key = f'gallery-traffic-{time.time_ns()}'
            status, _ = request(API + '/wagering/transactions', {
                'providerId': 'gallery-traffic', 'playerId': w['playerId'], 'walletId': w['id'],
                'roundId': 'gallery-traffic', 'gameId': 'gallery-demo', 'externalTransactionId': key,
                'kind': kind, 'money': {'amount': '1.00', 'currency': 'BRL'}}, key)
            assert status == (422 if reject else 200), f'Unexpected traffic response {status}'
            summary['rejected' if reject else 'processed'] += 1
            if i == 1:
                # A real conflicting replay is rejected before any extra debit.
                status, _ = request(API + '/wagering/transactions', {
                    'providerId': 'gallery-traffic', 'playerId': w['playerId'], 'walletId': w['id'],
                    'roundId': 'gallery-traffic', 'gameId': 'gallery-demo', 'externalTransactionId': key,
                    'kind': kind, 'money': {'amount': '2.00', 'currency': 'BRL'}}, key)
                assert status == 409
                summary['expectedPayloadConflicts'] = 1
            if i % 10 == 0:
                _, result = request(API + f"/wallets/{w['id']}/reconciliation", {})
                assert result['consistent']
            i += 1
            stop.wait(0.2)
        for w in wallets:
            _, result = request(API + f"/wallets/{w['id']}/reconciliation", {})
            assert result['consistent']
        summary['allTrafficWalletsReconciled'] = True
    except Exception as e:
        summary['error'] = str(e)

def report(page, title, subtitle, cards, sections, target):
    # This is an execution report, never presented as an existing product frontend.
    css = """body{margin:0;background:#0b1422;color:#e9f0fb;font:18px system-ui}main{padding:48px 56px;max-width:1320px;margin:auto}.eyebrow{color:#52ddbd;font:700 14px monospace;letter-spacing:2px}h1{font-size:38px;margin:12px 0}p{color:#a9bbd1;line-height:1.6}.cards{display:flex;gap:18px;margin:30px 0}.card{flex:1;background:#14263b;padding:24px;border-top:3px solid #52ddbd;border-radius:8px}.number{font-size:33px;font-weight:700}.label{margin-top:8px;color:#a9bbd1;font-size:15px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}section{background:#101e30;padding:24px;border:1px solid #263c56;border-radius:8px}h2{font-size:19px;margin-top:0;color:#75d6f5}pre{font:14px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#d6e6f5}footer{margin-top:26px;color:#8aa3c0;font-size:14px}"""
    card_html = ''.join(f'<div class="card"><div class="number">{html.escape(v)}</div><div class="label">{html.escape(k)}</div></div>' for k, v in cards)
    section_html = ''.join(f'<section><h2>{html.escape(k)}</h2><pre>{html.escape(json.dumps(v, indent=2, ensure_ascii=False))}</pre></section>' for k, v in sections)
    page.set_content(f'<html lang="pt-BR"><meta charset="utf-8"><style>{css}</style><main><div class="eyebrow">JUNGLE GAMING · EVIDÊNCIA DE EXECUÇÃO</div><h1>{html.escape(title)}</h1><p>{html.escape(subtitle)}</p><div class="cards">{card_html}</div><div class="grid">{section_html}</div><footer>Dados sintéticos · PostgreSQL 16 + LocalStack reais · Relatório gerado de respostas/consultas, sem frontend de produto · Fonte completa: evidence.json</footer></main></html>')
    page.screenshot(path=str(OUT / target), full_page=True)

info = json.loads(subprocess.check_output(['docker', 'inspect', 'jungle-gallery-demo-api-1'], text=True))[0]
assert info['Config']['Labels']['com.docker.compose.project'] == 'jungle-gallery-demo'
assert 'DB_NAME=jungle_load_test' in info['Config']['Env']
assert info['NetworkSettings']['Ports']['3000/tcp'][0] == {'HostIp': '127.0.0.1', 'HostPort': '3130'}
for _ in range(60):
    try:
        if request(API + '/health/ready')[0] == 200:
            break
    except (OSError, ValueError):
        pass
    time.sleep(1)
else:
    raise RuntimeError('Disposable API not ready')

reuse = '--ui-only' in sys.argv
stop = threading.Event()
summary = {'processed': 0, 'rejected': 0}
thread = None
if reuse:
    evidence = json.loads((OUT / 'evidence.json').read_text())
    summary = json.loads((OUT / 'traffic.json').read_text())
else:
    raw = subprocess.check_output(['docker', 'exec', 'jungle-gallery-demo-api-1', 'bun', 'scripts/gallery-evidence.ts'], text=True)
    evidence = json.loads(raw)
    (OUT / 'evidence.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n')
    thread = threading.Thread(target=traffic, args=(stop, summary))
    thread.start()
try:
    if not reuse:
        print('Collecting 120 seconds of real traffic and Prometheus samples.', flush=True)
        for _ in range(12):
            if 'error' in summary:
                raise RuntimeError(summary['error'])
            time.sleep(10)
    up = request(PROM + '/api/v1/query?' + urllib.parse.urlencode({'query': 'up{job="jungle-api"}'}))[1]
    assert up['data']['result'][0]['value'][1] == '1'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1520, 'height': 1180}, device_scale_factor=1)
        f = evidence['financial']
        report(page, 'Uma BET. Cinco replays. Um único débito.', 'Criação com BRL 100.00 → BET de BRL 25.00 → saldo final BRL 75.00. Respostas HTTP e verificações PostgreSQL da mesma execução.',
               [('Saldo final', 'BRL 75.00'), ('BET persistida', str(f['sql']['bets'])), ('Ledger: abertura + débito', str(f['sql']['ledger_entries'])), ('Reconciliação', 'Consistente')],
               [('POST /wagering/transactions · HTTP 200', f['bet']['body']), ('POST /wallets/:id/reconciliation · HTTP 200', f['reconciliation']['body']), ('GET /wallets/:id · estado final', f['final']), ('SQL e replays concorrentes', {'bets': f['sql']['bets'], 'ledgerEntries': f['sql']['ledger_entries'], 'replays': len(f['replays']), 'allIdempotentReplay': all(r['body']['idempotentReplay'] for r in f['replays'])})], 'financial-flow.png')
        d = evidence['deduplication']
        report(page, 'Dois recebimentos. Um efeito persistido.', 'Evento real da Outbox recebido no SQS, reenviado em duas mensagens distintas e processado simultaneamente por dois consumidores de referência.',
               [('Mensagens SQS distintas', '2'), ('Consumidores concorrentes', '2'), ('Eventos persistidos', str(d['persistedEvents'])), ('Efeito na projeção', str(d['projectionEffects']))],
               [('Identidade e entregas reais', {'eventId': d['eventId'], 'sqsMessageIds': d['receivedMessageIds']}), ('Consultas SQL após commit e ACK', {k: d[k] for k in ['persistedEvents', 'projectionEffects', 'handlersCompletedAfterAck', 'visibleAfterAck', 'financialSnapshotUnchanged']}), ('Garantia de entrega', {'transport': 'at-least-once', 'deduplication': 'eventId persistido em PostgreSQL', 'atomicity': 'processed + efeito na mesma transação', 'ack': 'após commit'}), ('Limite da demonstração', {'component': 'examples/event-consumer', 'effect': 'projeção didática isolada', 'walletAndLedger': 'sem modificação pelo consumidor', 'endToEndExactlyOnce': False})], 'persistent-deduplication.png')
        login = page.context.request.post(GRAFANA + '/login', data={'user': 'admin', 'password': 'gallery-local-demo'})
        assert login.ok, 'Grafana demo login failed'
        health = page.context.request.get(GRAFANA + '/api/datasources/uid/jungle-prometheus/health')
        assert health.ok and health.json()['status'] == 'OK'
        page.set_viewport_size({'width': 1600, 'height': 1280})
        page.goto(GRAFANA + '/d/jungle-operations/jungle-operations?orgId=1&from=now-5m&to=now&timezone=utc&kiosk&theme=dark', wait_until='networkidle')
        page.wait_for_timeout(8000)
        assert page.get_by_text('Throughput', exact=True).count()
        assert page.get_by_text('No data', exact=True).count() <= 1, 'Operational panels must contain real samples; mismatch counter may be absent'
        page.screenshot(path=str(OUT / 'grafana-live.png'), full_page=False)
        page.set_viewport_size({'width': 1520, 'height': 440})
        page.goto(PROM + '/targets', wait_until='domcontentloaded')
        page.wait_for_timeout(2000)
        assert 'api:3000' in page.inner_text('body')
        page.screenshot(path=str(OUT / 'prometheus-target.png'), full_page=False)
        browser.close()
    (OUT / 'prometheus-up.json').write_text(json.dumps(up, indent=2) + '\n')
finally:
    if thread:
        stop.set()
        thread.join(timeout=30)
        (OUT / 'traffic.json').write_text(json.dumps(summary, indent=2) + '\n')
if 'error' in summary or not summary.get('allTrafficWalletsReconciled'):
    raise RuntimeError(f'Traffic validation failed: {summary}')
print('Local gallery captured and financial assertions passed.', flush=True)
