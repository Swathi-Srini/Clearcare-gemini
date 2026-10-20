// Execution smoke test used by TEST_CLEARCARE.bat: starts the real server on a free port and
// checks the main HTTP paths. Prints PASS/FAIL lines and exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../lib/load-env.js';

loadEnvFile();

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 4400 + Math.floor(Math.random() * 400);
const env = { ...process.env, PORT: String(port) };
const srv = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => (out += d)); srv.stderr.on('data', d => (out += d));
await new Promise(r => { const t = setInterval(() => { if (/listening/.test(out)) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 6000); });
const base = `http://127.0.0.1:${port}`;
let fail = 0;
const check = async (name, fn) => { try { const d = await fn(); console.log(`PASS  ${name}${d ? '  (' + d + ')' : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}  -> ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };
await check('server starts and serves the app', async () => { const r = await fetch(base + '/'); must(r.ok, r.status); const h = await r.text(); must(/ClearCare/.test(h) && /ext\/main\.js/.test(h), 'html'); });
await check('original health endpoint', async () => { const j = await (await fetch(base + '/api/health')).json(); must(j.uploadsLeaveThisDevice === false, JSON.stringify(j)); });
await check('extension status endpoint (Gemini config, OCR, pdf.js)', async () => { const j = await (await fetch(base + '/api/v2/status')).json(); must(j.languages.join() === 'en,es,hi', 'languages'); return `Gemini key configured: ${j.gemini.configured}; model ${j.gemini.model}; server pdf.js: ${j.documents.serverPdfjs}; OCR: ${j.documents.ocr.available ? j.documents.ocr.languages.join('+') : 'not installed'}`; });
await check('vendored pdf.js served as JavaScript module', async () => { const r = await fetch(base + '/vendor/pdfjs/pdf.min.mjs'); must(r.ok && /javascript/.test(r.headers.get('content-type')), r.headers.get('content-type')); });
await check('sample PDF parses into a plan with page provenance', async () => { const r = await fetch(base + '/api/v2/parse', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: readFileSync(new URL('../discharge_pdf/01_everyday_recovery.pdf', import.meta.url)) }); const j = await r.json(); must(r.ok, j.error); const m = j.plan.items.find(i => i.category === 'medication'); must(m && m.strength.value === 500, 'acetaminophen 500 mg'); return `${j.plan.items.length} items, method ${j.document.method}`; });
await check('medication-change PDF: stop/hold never schedulable', async () => { const st = await (await fetch(base + '/api/v2/status')).json(); if (!st.documents.serverPdfjs) return 'skipped: server pdf.js needs Node >= 22.13 (browser still uses pdf.js)'; const j = await (await fetch(base + '/api/v2/parse', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: readFileSync(new URL('../discharge_pdf_adversarial/07_medication_changes.pdf', import.meta.url)) })).json(); const bad = j.plan.items.filter(i => ['STOP', 'HOLD'].includes(i.status) && i.schedulable); must(bad.length === 0, 'stop/hold scheduled'); });
await check('password-protected PDF rejected', async () => { const r = await fetch(base + '/api/v2/parse', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: readFileSync(new URL('../discharge_pdf_adversarial/11_password_protected.pdf', import.meta.url)) }); must(r.status === 422, r.status); });
await check('Gemini explain endpoint responds safely (live call only if GEMINI_API_KEY is set)', async () => { const r = await fetch(base + '/api/v2/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'Take amoxicillin 500 mg by mouth three times daily for 7 days.', language: 'hi', mode: 'simple' }) }); const j = await r.json(); if (!process.env.GEMINI_API_KEY) { must(r.status === 503 && j.code === 'not_configured', `${r.status} ${j.code}`); return 'no key: correctly reports not configured'; } must(r.ok, `${r.status} ${j.error || ''}`); return `LIVE Gemini: ${j.status}${j.provider ? `, ${j.provider.latencyMs} ms` : ''}${j.explanation ? ' — ' + j.explanation : ''}`; });
await check('security headers present', async () => { const r = await fetch(base + '/'); must(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''), 'csp'); });
srv.kill();
console.log(fail ? `\nSMOKE: ${fail} check(s) FAILED` : '\nSMOKE: all checks passed');
process.exit(fail ? 1 : 0);
