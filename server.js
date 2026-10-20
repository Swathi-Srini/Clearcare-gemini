import { createServer } from 'node:http';
import { loadEnvFile } from './lib/load-env.js';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from './lib/pdf-text.js';
import { extractCarePlan } from './lib/extract.js';
import { explainInstruction } from './lib/gemini-explainer.js';
import { handleExtension, applySecurityHeaders, verifyLegacyExplanation } from './lib/ext/routes.js'; // OCP extension (see CHANGE_IMPACT_REPORT.md)

// Load local settings before the server starts. Environment variables set by the shell win.
loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = join(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); }
async function bodyBuffer(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Upload exceeds the 12 MB demo limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  applySecurityHeaders(res);
  if (await handleExtension(req, res, pathname)) return;
  if (pathname === '/api/health') return json(res, 200, { mode: 'local-pdf-text-demo', aiConfigured: Boolean(process.env.GEMINI_API_KEY), uploadsLeaveThisDevice: false });
  if (pathname === '/api/explain' && req.method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().includes('application/json')) return json(res, 415, { error: 'Send one instruction as JSON.' });
      const bytes = await bodyBuffer(req, 4096);
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { return json(res, 400, { error: 'Invalid JSON request.' }); }
      const result = verifyLegacyExplanation(body, await explainInstruction(body));
      return json(res, 200, result);
    } catch (err) {
      return json(res, err.status || 503, { error: err.message || 'The explanation service is temporarily unavailable.', code: err.code || 'unavailable' });
    }
  }
  if (pathname === '/api/parse' && req.method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().startsWith('application/pdf')) return json(res, 415, { error: 'Please upload a PDF. Image OCR is not configured; scanned PDFs without embedded text will be marked unreadable.' });
      const bytes = await bodyBuffer(req, 12 * 1024 * 1024);
      const text = extractPdfText(bytes);
      const result = extractCarePlan(text, 'Uploaded discharge document.pdf');
      return json(res, 200, result);
    } catch (err) {
      const status = /12 MB|exceeds/i.test(err.message) ? 413 : 422;
      return json(res, status, { error: err.message || 'The document could not be safely read.' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  const pathnameForFile = pathname === '/' ? '/index.html' : pathname;
  const target = normalize(join(publicRoot, pathnameForFile));
  if (!target.startsWith(publicRoot)) { res.writeHead(403); return res.end(); }
  try { const data = await readFile(target); res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : data); }
  catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}
export { handleRequest };
const preferredPort = Number(process.env.PORT || 4174);
console.log(`[ClearCare] Gemini API explanations: ${process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY is configured (value hidden).' : 'GEMINI_API_KEY is NOT configured; live Gemini requests will not be sent.'}`);
function configure(server) {
  server.requestTimeout = 20_000;
  server.headersTimeout = 25_000;
  server.keepAliveTimeout = 5_000;
  server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${preferredPort} is already in use. Close the other server on that port, or start ClearCare on another port with PORT=4173 npm start.`);
  else console.error(`ClearCare could not start: ${err.message}`);
  process.exitCode = 1;
  });
}
// localhost may resolve to either address family depending on the browser/OS.
// Bind both loopback addresses without exposing this demo on the local network.
if (process.env.CLEARCARE_NO_LISTEN === '1') { /* imported by tests */ } else {
const ipv4 = createServer(handleRequest);
const ipv6 = createServer(handleRequest);
configure(ipv4);
configure(ipv6);
let ready = 0;
function announce() {
  ready++;
  if (ready === 2) console.log(`ClearCare listening on http://localhost:${preferredPort} (IPv4 and IPv6 loopback)`);
}
ipv4.listen(preferredPort, '127.0.0.1', announce);
ipv6.listen(preferredPort, '::1', announce);
}
