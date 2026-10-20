// Gemini GenerateContent provider with server-only credentials, bounded retries, pacing and telemetry.
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_PROMPT_CHARS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const telemetry = [];

export function geminiConfig(env = process.env) {
  let baseUrl = GEMINI_BASE_URL, mock = false;
  if (env.CLEARCARE_GEMINI_BASE_URL) {
    const u = new URL(env.CLEARCARE_GEMINI_BASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) throw new Error('CLEARCARE_GEMINI_BASE_URL may only point to a loopback test server.');
    baseUrl = env.CLEARCARE_GEMINI_BASE_URL.replace(/\/$/, ''); mock = true;
  }
  const requestedModel = String(env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(requestedModel)) throw new Error('GEMINI_MODEL is invalid.');
  return { baseUrl, model: requestedModel, apiKey: env.GEMINI_API_KEY || '', configured: Boolean(env.GEMINI_API_KEY), mock, provider: 'Google Gemini API' };
}

function record(entry) { telemetry.push({ ts: new Date().toISOString(), ...entry }); if (telemetry.length > 200) telemetry.shift(); }
export function telemetrySummary() {
  const ok = telemetry.filter(t => t.outcome === 'ok');
  const lat = ok.map(t => t.latencyMs).sort((a, b) => a - b);
  const p = q => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  return { calls: telemetry.length, ok: ok.length, errors: telemetry.length - ok.length, p50Ms: p(0.5), p95Ms: p(0.95), recent: telemetry.slice(-10).map(({ ts, op, outcome, status, latencyMs, queueMs, attempts, mock, requestId, servedModel }) => ({ ts, op, outcome, status, latencyMs, queueMs, attempts, mock, requestId, servedModel })) };
}
export function resetTelemetryForTests() { telemetry.length = 0; nextSlot = 0; queued = 0; }

// Optional quota pacing is shared across explanations, questions, translations and Care Agent calls.
let nextSlot = 0, queued = 0, chain = Promise.resolve();
const intervalOf = env => Math.max(0, Number(env.GEMINI_MIN_INTERVAL_MS) || 0);
export function geminiQueueStatus(env = process.env) { const intervalMs = intervalOf(env); return { intervalMs, queued, nextFreeInMs: Math.max(0, nextSlot - Date.now()) }; }
function acquireSlot(env, signal) {
  const intervalMs = intervalOf(env);
  if (!intervalMs) return Promise.resolve();
  queued++;
  const turn = chain.then(() => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(err('Cancelled.', 499, 'cancelled'));
    const wait = Math.max(0, nextSlot - Date.now());
    const t = setTimeout(() => { nextSlot = Date.now() + intervalMs; resolve(); }, wait);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(err('Cancelled.', 499, 'cancelled')); }, { once: true });
  }));
  chain = turn.catch(() => {});
  return turn.finally(() => { queued--; });
}
function backOff(env) { const i = intervalOf(env); if (i) nextSlot = Math.max(nextSlot, Date.now() + i); }

const err = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const sleep = (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(err('Cancelled.', 499, 'cancelled')); }, { once: true }); });

function responseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
  return '';
}

/** One GenerateContent request against Google's Gemini API. */
export async function geminiGenerate({ system, user, maxTokens = 400, op = 'chat', timeoutMs = 15000, signal, fetchImpl = fetch, env = process.env, retries = 1, jsonMode = true }) {
  const cfg = geminiConfig(env);
  if (!cfg.configured) throw err('The Gemini API key is not configured on this computer.', 503, 'not_configured');
  if (typeof system !== 'string' || typeof user !== 'string' || system.length + user.length > MAX_PROMPT_CHARS) throw err('Request is too large.', 413, 'too_large');
  let attempt = 0;
  const started = performance.now();
  let sentAt = started, queueMs = 0;
  while (true) {
    attempt++;
    const waitStart = performance.now();
    await acquireSlot(env, signal);
    queueMs += Math.round(performance.now() - waitStart); sentAt = performance.now();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const generationConfig = { temperature: 0, maxOutputTokens: maxTokens };
      if (jsonMode) generationConfig.responseMimeType = 'application/json';
      const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`;
      const res = await fetchImpl(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig })
      });
      if (res.status === 429) { const ra = Number(res.headers?.get?.('retry-after')) || null; backOff(env); throw err('Gemini is busy (rate limited). Please try again shortly.', 429, 'rate_limited', { retryAfter: ra, retryable: intervalOf(env) > 0 }); }
      if (res.status >= 500) throw err('Gemini is temporarily unavailable.', 503, 'provider_error', { retryable: true });
      if (!res.ok) throw err('Gemini rejected the request. Check the API key, model name, and API access.', 502, 'provider_rejected', { retryable: false });
      const raw = await res.text();
      if (raw.length > MAX_RESPONSE_BYTES) throw err('Gemini returned an oversized response.', 502, 'invalid_response');
      let data; try { data = JSON.parse(raw); } catch { throw err('Gemini returned an invalid response.', 502, 'invalid_response'); }
      const content = responseText(data);
      if (!content) {
        const reason = data?.candidates?.[0]?.finishReason;
        throw err(reason === 'SAFETY' ? 'Gemini could not provide a response under its safety rules.' : 'Gemini returned an empty response.', 502, reason === 'SAFETY' ? 'blocked' : 'invalid_response');
      }
      const latencyMs = Math.round(performance.now() - sentAt);
      const requestId = String(data.responseId || '').slice(0, 80) || null;
      const servedModel = String(data.modelVersion || cfg.model).slice(0, 80);
      record({ op, outcome: 'ok', status: 200, latencyMs, queueMs, attempts: attempt, mock: cfg.mock, requestId, servedModel });
      return { text: content, latencyMs, attempts: attempt, model: cfg.model, mock: cfg.mock, requestId, servedModel, usage: data.usageMetadata ? { prompt: data.usageMetadata.promptTokenCount, completion: data.usageMetadata.candidatesTokenCount } : null };
    } catch (e) {
      const cancelled = signal?.aborted;
      const timedOut = !cancelled && (e.name === 'AbortError' || ctl.signal.aborted);
      const failure = cancelled ? err('Cancelled.', 499, 'cancelled') : timedOut ? err('Gemini took too long to answer.', 504, 'timeout', { retryable: true }) : e.status ? e : err('Could not reach Gemini.', 503, 'network_error', { retryable: true });
      if (failure.retryable && attempt <= retries && !cancelled) { await sleep(300 * attempt + Math.floor(Math.random() * 200), signal); continue; }
      record({ op, outcome: failure.code, status: failure.status, latencyMs: Math.round(performance.now() - sentAt), queueMs, attempts: attempt, mock: cfg.mock });
      throw failure;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); backOff(env); }
  }
}

// Validate one JSON object from Gemini; caller schemas define the permitted fields and types.
export function parseJsonObject(text, schema) {
  const s = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw err('Gemini response was not in the expected format.', 502, 'schema_invalid');
  let obj; try { obj = JSON.parse(s.slice(start, end + 1)); } catch { throw err('Gemini response was not in the expected format.', 502, 'schema_invalid'); }
  for (const [k, type] of Object.entries(schema)) {
    const v = obj[k];
    const ok = type === 'string[]' ? Array.isArray(v) && v.every(x => typeof x === 'string') : type === 'string?' ? v === undefined || v === null || typeof v === 'string' : typeof v === type;
    if (!ok) throw err('Gemini response was not in the expected format.', 502, 'schema_invalid');
  }
  return obj;
}
