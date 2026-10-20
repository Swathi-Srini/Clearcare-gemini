// OCP extension point for server.js: new /api/v2/* routes, security headers, and a
// verification decorator for the ORIGINAL /api/explain response. Returns true when handled.
import { readFile } from 'node:fs/promises';
import { explainV2 } from './explain-v2.js';
import { askV2 } from './ask.js';
import { translateV2 } from './translate.js';
import { runCareAgent } from './agent.js';
import { EXTRA_LANGS } from '../../public/ext/i18n.js';
import { geminiConfig, telemetrySummary, geminiQueueStatus } from './gemini-provider.js';
import { ingestPdfInNode, ocrPdfInNode, ocrCapabilities, nodeSupportsPdfjs } from './document-node.js';
import { extractInstructions } from '../../public/ext/clinical/engine.js';
import { verifyExplanation } from '../../public/ext/clinical/fidelity.js';
import { normalizeLang } from '../../public/ext/i18n.js';
import { primaryItem } from './explain-v2.js';

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY'
};
export function applySecurityHeaders(res) { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); }

const buckets = new Map();
export function rateLimited(req, { limit = 30, windowMs = 60_000 } = {}) {
  const key = req.socket?.remoteAddress || 'local';
  const now = Date.now();
  const b = buckets.get(key) || { start: now, n: 0 };
  if (now - b.start > windowMs) { b.start = now; b.n = 0; }
  b.n++; buckets.set(key, b);
  return b.n > limit;
}
export function resetRateLimitForTests() { buckets.clear(); }

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); }
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('Request is too large.'), { status: 413, code: 'too_large' }); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, max) {
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) throw Object.assign(new Error('Send JSON.'), { status: 415, code: 'unsupported_media' });
  try { return JSON.parse((await readBody(req, max)).toString('utf8')); } catch (e) { if (e.status) throw e; throw Object.assign(new Error('Invalid JSON request.'), { status: 400, code: 'bad_request' }); }
}
function cancelOnClose(req) { const ctl = new AbortController(); req.on('close', () => { if (!req.complete) ctl.abort(); }); return ctl.signal; }
const safeError = e => ({ error: e.status && e.status < 500 || ['not_configured', 'rate_limited', 'timeout', 'provider_error', 'provider_rejected', 'network_error', 'invalid_response', 'schema_invalid', 'ocr_unavailable', 'encrypted', 'empty', 'not_pdf', 'malformed', 'unreadable', 'too_large'].includes(e.code) ? e.message : 'Something went wrong. Your original document is unchanged.', code: e.code || 'error' });

export async function handleExtension(req, res, pathname) {
  try {
    if (pathname === '/api/v2/status' && req.method === 'GET') {
      const cfg = geminiConfig();
      return json(res, 200, { languages: ['en', 'es', 'hi'], extraLanguages: Object.keys(EXTRA_LANGS), gemini: { provider: cfg.provider, model: cfg.model, endpoint: cfg.baseUrl, configured: cfg.configured, mock: cfg.mock, queue: geminiQueueStatus() }, telemetry: telemetrySummary(), documents: { serverPdfjs: nodeSupportsPdfjs(), node: process.versions.node, ocr: await ocrCapabilities() }, uploadsStoredOnServer: false }), true;
    }
    if (pathname === '/api/v2/explain' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' }), true;
      const body = await readJson(req, 4096);
      return json(res, 200, await explainV2(body, { signal: cancelOnClose(req) })), true;
    }
    if (pathname === '/api/v2/ask' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' }), true;
      const body = await readJson(req, 8192);
      return json(res, 200, await askV2(body, { signal: cancelOnClose(req) })), true;
    }
    if (pathname === '/api/v2/agent' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' }), true;
      const body = await readJson(req, 512 * 1024);
      return json(res, 200, await runCareAgent(body, { signal: cancelOnClose(req) })), true;
    }
    if (pathname === '/api/v2/translate' && req.method === 'POST') {
      if (rateLimited(req, { limit: 60 })) return json(res, 429, { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' }), true;
      const body = await readJson(req, 16384);
      return json(res, 200, await translateV2(body, { signal: cancelOnClose(req) })), true;
    }
    if ((pathname === '/api/v2/parse' || pathname === '/api/v2/ocr') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/pdf')) return json(res, 415, { error: 'Please send a PDF.', code: 'unsupported_media' }), true;
      if (rateLimited(req, { limit: 10 })) return json(res, 429, { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' }), true;
      const bytes = await readBody(req, 12 * 1024 * 1024);
      const doc = pathname === '/api/v2/ocr' ? await ocrPdfInNode(bytes) : await ingestPdfInNode(bytes);
      const plan = extractInstructions(doc);
      return json(res, 200, { document: { method: doc.method, status: doc.status, pageCount: doc.pageCount, warnings: doc.warnings, pages: doc.pages.map(p => ({ page: p.page, lines: p.lines, imageOnly: p.imageOnly, columns: p.columns })) }, plan }), true;
    }
    if (pathname === '/ext/desktop-styles.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Desktop application: serve the ORIGINAL stylesheet with its phone/tablet breakpoints removed.
      const css = desktopOnlyCss(await readFile(new URL('../../public/styles.css', import.meta.url), 'utf8'));
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : css); return true;
    }
    if (pathname.startsWith('/samples/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = decodeURIComponent(pathname.slice('/samples/'.length));
      if (!/^[\w-]{1,80}\.pdf$/.test(name)) return json(res, 404, { error: 'Not found.' }), true;
      for (const dir of ['../../discharge_pdf/', '../../discharge_pdf_adversarial/']) {
        try { const data = await readFile(new URL(dir + name, import.meta.url)); res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${name}"` }); res.end(req.method === 'HEAD' ? undefined : data); return true; } catch { /* try next */ }
      }
      return json(res, 404, { error: 'Not found.' }), true;
    }
    if (pathname.startsWith('/api/v2/')) return json(res, 404, { error: 'Not found.', code: 'not_found' }), true;
  } catch (e) {
    const status = e.status || (['encrypted', 'empty', 'not_pdf', 'malformed', 'unreadable'].includes(e.code) ? 422 : e.code === 'too_large' ? 413 : e.code === 'ocr_unavailable' ? 501 : 500);
    if (status >= 500 && !e.code) console.error('ClearCare extension error:', e.name);
    return json(res, status, safeError(e)), true;
  }
  return false;
}

// Decorator for the ORIGINAL /api/explain result: AI text must pass the same fidelity checks.
const WITHHELD = { English: 'We couldn’t safely simplify this instruction. Please read the original instruction above and ask your care team.', Español: 'No pudimos simplificar esta indicación con seguridad. Lea la indicación original y consulte con su equipo de atención.', 'हिन्दी': 'इस निर्देश को सुरक्षित रूप से आसान नहीं बना सके। कृपया ऊपर मूल निर्देश पढ़ें और अपनी देखभाल टीम से पूछें।' };
export function verifyLegacyExplanation(body, result) {
  if (!result || result.clarificationNeeded || result.cached && result.verified === false) return result;
  const language = ['English', 'Español', 'हिन्दी'].includes(body?.language) ? body.language : 'English';
  const { item } = primaryItem(String(body?.instruction || ''));
  const check = verifyExplanation({ sourceText: String(body?.instruction || ''), item, explanation: result.explanation, lang: normalizeLang(language) });
  if (check.ok) return { ...result, verified: true };
  return { explanation: WITHHELD[language], cached: Boolean(result.cached), clarificationNeeded: true, withheld: true, verified: false, failures: check.failures.map(f => f.code) };
}

// Removes every @media (max-width: …) block so the layout never switches to the phone design.
export function desktopOnlyCss(css) {
  let out = '', i = 0;
  const rx = /@media\s*\(\s*max-width\s*:[^)]*\)\s*\{/g;
  let m;
  while ((m = rx.exec(css))) {
    out += css.slice(i, m.index);
    let depth = 1, j = m.index + m[0].length;
    while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    i = j; rx.lastIndex = j;
  }
  return out + css.slice(i);
}
