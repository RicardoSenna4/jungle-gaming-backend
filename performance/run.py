"""Run only a new, private disposable Compose project; always remove its volumes."""
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'performance/results'
RESULTS.mkdir(exist_ok=True)
PROJECT = 'jungle-load-' + uuid.uuid4().hex[:10]
COMPOSE = ['docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'performance/compose.yml')]

def call(args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

environment = {'dateUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'platform': platform.platform(), 'logicalCPUsVisible': os.cpu_count(),
               'docker': json.loads(call(['docker', 'info', '--format', '{{json .}}'], True)),
               'apiInstances': 1, 'vus': 4, 'iterationsPerScenario': 20}
# Keep only hardware/version fields, no daemon/proxy configuration.
environment['docker'] = {k: environment['docker'][k] for k in ['NCPU', 'MemTotal', 'ServerVersion', 'Architecture']}
(RESULTS / 'environment.json').write_text(json.dumps(environment, indent=2))
try:
    call(COMPOSE + ['up', '-d', 'api'])
    ready = False
    for _ in range(90):
        p = subprocess.run(COMPOSE + ['exec', '-T', 'api', 'bun', '-e', "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if p.returncode == 0:
            ready = True
            break
        time.sleep(1)
    if not ready:
        raise RuntimeError('Disposable API not ready')
    for scenario in ['parallel', 'hot', 'limited', 'replays', 'mixed']:
        call(COMPOSE + ['run', '--rm', '-e', 'SCENARIO=' + scenario, 'k6', 'run', '/scripts/financial.js'])
    stats = call(['docker', 'stats', '--no-stream', '--format', '{{json .}}', PROJECT + '-api-1'], True)
    (RESULTS / 'resource-sample.json').write_text(stats)
    verification = call(COMPOSE + ['exec', '-T', 'api', 'bun', 'performance/verify.ts'], True)
    (RESULTS / 'invariants.json').write_text(verification)
    metrics = call(COMPOSE + ['exec', '-T', 'api', 'bun', '-e', "console.log(await (await fetch('http://localhost:3000/metrics')).text())"], True)
    (RESULTS / 'api-metrics.txt').write_text(metrics)
finally:
    logs = subprocess.run(COMPOSE + ['logs', '--no-color', 'api'], text=True, stdout=subprocess.PIPE)
    (RESULTS / 'api.log').write_text(logs.stdout)
    call(COMPOSE + ['down', '-v', '--remove-orphans'])
