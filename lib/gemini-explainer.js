import { createHash } from 'node:crypto';
import { geminiConfig, geminiGenerate } from './ext/gemini-provider.js';

export const GEMINI_BASE_URL = geminiConfig({}).baseUrl;
export const GEMINI_MODEL = geminiConfig({}).model;
const MAX_INSTRUCTION_LENGTH = 1200;
const CACHE_LIMIT = 200;
const cache = new Map();
const inFlight = new Map();

export function explanationCacheKey(instruction, language = 'English') {
  return createHash('sha256').update(`${language}\0${instruction}`).digest('hex');
}

export function normalizeLanguage(value) {
  const allowed = new Set(['English', 'Español', 'हिन्दी']);
  return allowed.has(value) ? value : 'English';
}

export function validateExplanationInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid request.'), { status: 400 });
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction || instruction.length > MAX_INSTRUCTION_LENGTH) throw Object.assign(new Error(`Select one instruction of 1–${MAX_INSTRUCTION_LENGTH} characters.`), { status: 400 });
  if (Object.keys(body).some(key => !['instruction', 'language'].includes(key))) throw Object.assign(new Error('Only one instruction and its language may be sent.'), { status: 400 });
  return { instruction, language: normalizeLanguage(body.language) };
}

function looksAmbiguous(text) {
  return /\b(?:unit (?:not stated|missing)|illegible|unreadable|conflict(?:ing)?|directions? conflict|not clear|unclear|not specified|confirm|to be confirmed|\bor\b.*\d|\d+(?:\.\d+)?\s*(?:and|or)\s*\d+(?:\.\d+)?|\[.*?\])/i.test(text);
}

export async function explainInstruction(body, { apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch, timeoutMs = 12000, logger = console, env = process.env } = {}) {
  const input = validateExplanationInput(body);
  const key = explanationCacheKey(input.instruction, input.language);
  if (cache.has(key)) { logger.info('[ClearCare explain] cache hit; no Gemini request sent.'); return { explanation: cache.get(key), cached: true }; }
  if (inFlight.has(key)) return inFlight.get(key);
  const operation = (async () => {
    const requestEnv = { ...env, GEMINI_API_KEY: apiKey || '' };
    if (!apiKey) { logger.warn('[ClearCare explain] GEMINI_API_KEY is not configured; no Gemini request sent.'); throw Object.assign(new Error('The explanation service is not configured.'), { status: 503, code: 'not_configured' }); }
    const started = Date.now();
    const cfg = geminiConfig(requestEnv);
    logger.info(`[ClearCare explain] sending selected instruction to Gemini (${cfg.model}); API key configured, value hidden.`);
    try {
      const result = await geminiGenerate({
        system: `Explain this single care instruction in at most two short sentences. Use warm, natural, everyday phrasing in ${input.language}, like a patient educator speaking kindly and clearly; avoid robotic, word-for-word translation. Preserve the exact meaning. Do not add medical advice or change any medication dose, schedule, or treatment. If anything is ambiguous, say clearly that the patient should ask their care team to clarify it; never guess.`,
        user: input.instruction, maxTokens: 110, timeoutMs, retries: 0, jsonMode: false, op: 'explain-legacy', fetchImpl, env: requestEnv
      });
      let explanation = result.text.replace(/\s+/g, ' ').trim();
      if (!explanation || explanation.length > 500) throw Object.assign(new Error('The explanation service returned an invalid response.'), { status: 502, code: 'invalid_response' });
      if (looksAmbiguous(input.instruction)) { const clarificationPresent = input.language === 'Español' ? /aclar|confirma|no está claro|no queda claro|pregunt/i.test(explanation) : input.language === 'हिन्दी' ? /स्पष्ट|पुष्टि|पूछें|देखभाल टीम/i.test(explanation) : /clarif|unclear|ambiguous|not clear|confirm/i.test(explanation); if (!clarificationPresent) { const reminder = input.language === 'Español' ? ' Pide a tu equipo de cuidado que aclare esta instrucción antes de seguirla.' : input.language === 'हिन्दी' ? ' इस निर्देश का पालन करने से पहले अपनी देखभाल टीम से इसे स्पष्ट करने के लिए कहें।' : ' Please ask your care team to clarify this instruction before following it.'; explanation = `${explanation}${reminder}`; } }
      cache.set(key, explanation);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      logger.info(`[ClearCare explain] Gemini request succeeded in ${Date.now() - started} ms; response cached. Key value hidden.`);
      return { explanation, cached: false };
    } catch (error) {
      logger.warn(`[ClearCare explain] Gemini request failed (${error.code || error.status || 'network_error'}) after ${Date.now() - started} ms. Key value hidden.`);
      throw error;
    }
  })();
  inFlight.set(key, operation);
  try { return await operation; } finally { inFlight.delete(key); }
}

export function resetExplanationStateForTests() { cache.clear(); inFlight.clear(); }
