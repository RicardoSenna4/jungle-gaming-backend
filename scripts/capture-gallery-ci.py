"""Render verified public CI metadata; this is a labelled report, not GitHub UI."""
import json
import html
import hashlib
import struct
from pathlib import Path
import re
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs/gallery'
source = json.loads((OUT / 'evidence.json').read_text())['sourceCommit']
with urllib.request.urlopen('https://github.com/RicardoSenna4/jungle-gaming-backend/actions', timeout=20) as r:
    markup = r.read().decode()
runs = []
for raw in re.findall(r'<script type="application/json"[^>]*>(.*?)</script>', markup, re.S):
    try:
        data = json.loads(raw)
    except ValueError:
        continue
    runs.extend(data.get('payload', {}).get('allWorkflowRunsRoute', {}).get('workflowRuns', []))
matching = [r for r in runs if r['name'] == 'ci'
            and r.get('description', {}).get('linkUrl', '').endswith(source)
            and r['state'].get('conclusion') == 'WORKFLOW_RUN_CONCLUSION_SUCCESS']
if not matching:
    raise RuntimeError('No verified successful CI run for the captured source SHA; do not fabricate evidence')
run = next((r for r in matching if r['branch']['title'] == 'main'), matching[0])
metadata = {'sourceCommit': source, 'workflow': run['name'], 'runUrl': run['runUrl'],
            'branchAtRunTime': run['branch']['title'], 'state': run['state'],
            'createdAt': run['createdAt']['timestamp'], 'runNumber': run['runNumber'], 'duration': run['timing']['text'], 'event': run['description']['action']}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1520, 'height': 860}, device_scale_factor=1)
    page.set_content(f"""<html lang="pt-BR"><meta charset="utf-8"><style>
    body{{margin:0;background:#0b1422;color:#e9f0fb;font:18px system-ui}}main{{padding:52px 64px}}
    .tag{{color:#52ddbd;font:700 14px monospace;letter-spacing:2px}}h1{{font-size:40px;margin:16px 0}}
    p{{color:#a9bbd1;line-height:1.7}}.success{{color:#52ddbd;background:#143429;border:1px solid #29745b;padding:28px;border-radius:10px;font-size:30px;margin:30px 0}}
    .grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px}}section{{background:#14263b;padding:26px;border-radius:8px}}
    label{{color:#8fa8c2;font-size:14px}}pre{{font:17px/1.8 monospace;white-space:pre-wrap;overflow-wrap:anywhere}}footer{{color:#8fa8c2;margin-top:30px;font-size:14px}}
    </style><main><div class="tag">JUNGLE GAMING · EVIDÊNCIA DE CI</div><h1>Execução real aprovada no GitHub Actions</h1>
    <p>Relatório visual de metadados públicos verificados. A execução abaixo corresponde ao código usado na demonstração.</p>
    <div class="success">✓ Success · workflow ci · execução #{run['runNumber']}</div><div class="grid">
    <section><label>REFERÊNCIA VERIFICADA</label><pre>Branch: {html.escape(run['branch']['title'])}<br>SHA: {source}<br>Evento: {run['description']['action']}<br>Duração: {html.escape(run['timing']['text'])}</pre></section>
    <section><label>CONSULTAR EXECUÇÃO ORIGINAL</label><pre>{html.escape(run['runUrl'])}</pre><p>Resultado histórico do commit indicado. Consulte o CI da branch para avaliar commits posteriores.</p></section></div>
    <footer>Relatório gerado de metadados públicos do GitHub; não é captura da interface do GitHub. Fonte versionada: ci.json.</footer></main></html>""")
    page.screenshot(path=str(OUT / 'ci-success.png'), full_page=True)
    browser.close()
(OUT / 'ci.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Rendered verified successful CI:', run['runUrl'])

files = ['docs/gallery/' + name for name in ['grafana-live.png', 'prometheus-target.png', 'financial-flow.png', 'persistent-deduplication.png', 'ci-success.png', 'evidence.json', 'traffic.json', 'prometheus-up.json', 'ci.json', 'compose.yml']]
files += ['scripts/gallery-evidence.ts', 'scripts/capture-gallery.py', 'scripts/capture-gallery-ci.py']
manifest = {'sourceCommit': source, 'files': {}}
for name in files:
    payload = (ROOT / name).read_bytes()
    entry = {'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)}
    if name.endswith('.png'):
        assert payload[:8] == b'\x89PNG\r\n\x1a\n'
        entry['width'], entry['height'] = struct.unpack('>II', payload[16:24])
    manifest['files'][name] = entry
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
