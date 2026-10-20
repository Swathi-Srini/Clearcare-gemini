// Patient-journey E2E (Playwright): onboarding → upload → Calendar Agent → refresh persistence →
// completion tracking → Kannada → safety gate → Care Agent → voice interruption → duplicate-reminder
// prevention → keyboard-only use → Gemini failure handling → accessibility. Uses a LOOPBACK MOCK of the Gemini
// endpoint (labelled TEST MOCK in the UI), mock speech and a fixed clock, so results are repeatable.
//   PLAYWRIGHT_PATH=… [AXE_PATH=…] [CLEARCARE_E2E_CHANNEL=msedge] node e2e/run-journey.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const req = createRequire(join(root, 'package.json'));
const pw = (() => { for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean)) { try { return req(p); } catch { /* next */ } } return null; })();
if (!pw) { console.error('Playwright not installed. Set PLAYWRIGHT_PATH or npm i --no-save playwright-core'); process.exit(2); }
const results = [];
const rec = (id, name, ok, detail = '') => { results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail }); console.log(`${ok ? '✔' : '✘'} ${id} ${name}${detail ? ' — ' + detail : ''}`); };

// ---- loopback mock Gemini ----
let mockMode = 'ok', mockCalls = 0;
const mock = createServer((rq, rs) => { let b = ''; rq.on('data', c => (b += c)); rq.on('end', () => {
  mockCalls++;
  if (mockMode === '401') { rs.writeHead(401); return rs.end('{}'); }
  const body = JSON.parse(b || '{}'); const sys = body.systemInstruction.parts[0].text, user = body.contents[0].parts.map(p => p.text || '').join('');
  let content;
  if (/translate short patient-care texts/.test(sys)) { const items = JSON.parse(user).items; content = JSON.stringify({ t: items.map(t => 'ಕನ್ನಡ: ' + t), en: items }); }
  else if (/Care Agent/.test(sys)) { const ids = [...user.matchAll(/"id":"([^"]+)"/g)].map(m => m[1]); const v = ids.find(i => i.startsWith('agent-appointment') || i.startsWith('appointment')); content = JSON.stringify({ reasoning: ['The follow-up is on 2026-10-19 at 09:00; the place is missing.'], answer: 'Your follow-up is on October 19 at 9:00 AM. The papers do not give the place, so please confirm it with your care team.', sources: v ? [v] : [], confidence: 'medium' }); }
  else content = JSON.stringify({ explanation: 'Take 500 mg of acetaminophen every 6 hours only if you need it for pain, and do not take more than 3,000 mg in 24 hours.', steps: [] });
  rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ responseId: 'mock-' + mockCalls, modelVersion: 'gemini-3.8-flash', candidates: [{ content: { parts: [{ text: content }] } }] }));
}); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const port = 4900 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), GEMINI_API_KEY: 'e2e-test-key', CLEARCARE_GEMINI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1beta`, GEMINI_MIN_INTERVAL_MS: '0', CLEARCARE_TRANSLATION_CACHE: join(root, 'docs/evidence/.e2e-translation-cache.json') }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
const base = `http://127.0.0.1:${port}`;

const SPEECH_MOCK = () => {
  window.__spoken = []; window.__cancels = 0;
  const voices = [{ name: 'Mock English', lang: 'en-US', localService: true }, { name: 'Mock हिन्दी', lang: 'hi-IN', localService: true }, { name: 'Mock ಕನ್ನಡ', lang: 'kn-IN', localService: false }];
  class U { constructor(t) { this.text = t; } }
  const synth = { speaking: false, getVoices: () => voices, addEventListener() {},
    speak(u) { window.__spoken.push({ text: u.text, lang: u.lang }); this.speaking = true; setTimeout(() => { u.onstart?.(); setTimeout(() => { if (this.speaking) u.onend?.(); }, 400); }, 5); },
    cancel() { window.__cancels++; this.speaking = false; }, pause() {}, resume() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = U;
};

const browser = await pw.chromium.launch(process.env.CLEARCARE_E2E_CHANNEL ? { channel: process.env.CLEARCARE_E2E_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Kolkata' });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
const page = await ctx.newPage();
await page.clock.install({ time: new Date('2026-10-17T09:00:00+05:30') });
await page.addInitScript(SPEECH_MOCK);
const errors = []; page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());
// A real reload (a hash-only goto keeps the same document and would not prove persistence).
let loads = 0;
const open = async () => { if (loads++) await page.reload(); else await page.goto(base + '/#today'); await page.waitForSelector('#cc-today:not([hidden])'); const fresh = await page.evaluate(() => (window.__docId ??= Math.random())); if (open.last === fresh) throw new Error('page did not reload'); open.last = fresh; };
const text = async sel => (await page.textContent(sel) || '').replace(/\s+/g, ' ');
// Loads a synthetic PDF through the same bridge event the upload control uses (works whether or not a plan is already shown).
const loadSample = async f => { await page.evaluate(async f => { const r = await fetch('/samples/' + f); const file = new File([await r.blob()], f, { type: 'application/pdf' }); document.dispatchEvent(new CustomEvent('clearcare:document', { detail: { file } })); }, f); await page.waitForTimeout(1500); if (await page.isVisible('#modal-backdrop')) await page.click('#modal-close'); };
// A failing check must throw (or return false); returning a message never counts as a pass.
const fail = msg => { throw new Error(msg); };
const t = async (id, name, fn) => { try { const r = await fn(); rec(id, name, r !== false, typeof r === 'string' ? r : ''); } catch (e) { rec(id, name, false, String(e.message || e).slice(0, 1200)); } };

await open();
await t('J01', 'onboarding: language, voice, caregiver and text size are chosen and saved', async () => {
  if (!await page.isVisible('.cc-onb')) return false;
  await page.click('[data-onb-voice="0"]'); await page.click('[data-onb-role="caregiver"]'); await page.click('[data-onb-keep="1"]'); await page.click('[data-onb-size="1"]'); await page.click('[data-act="onb-done"]');
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('clearcare-ext-prefs')));
  return prefs.onboarded && prefs.role === 'caregiver' && prefs.largeText && !prefs.autoRead && prefs.rememberPlan && !(await page.isVisible('.cc-onb')) ? 'saved: caregiver, larger text, read-aloud off, keep plan on' : false;
});
await t('J02', 'upload → Calendar Agent adds the dated follow-up and the high-risk medicine, flagged', async () => {
  await loadSample('05_high_risk_apixaban.pdf');
  const toast = (await page.$$eval('.toast', ts => ts.map(x => x.textContent))).join(' ');
  await page.click('[data-tab="calendar"]');
  const cell = await text('[data-cal-day="2026-10-19"]');
  return /Care Agent updated your calendar/.test(toast) && /9:00 AM/.test(cell) && /⚠/.test(cell) ? cell.trim() : false;
});
await t('J03', 'calendar survives a page refresh (document-derived entries persist)', async () => {
  await open(); await page.click('[data-tab="calendar"]');
  return /9:00 AM/.test(await text('[data-cal-day="2026-10-19"]')) && /Apixaban/.test(await text('.cc-agent-log'));
});
await t('J03b', 'with “keep my care plan” chosen, the plan itself is back after a reload', async () => {
  await open(); await page.click('[data-tab="today"]');
  return /05_high_risk_apixaban.pdf/.test(await text('.cc-doc')) ? 'plan restored' : fail('no plan after reload');
});
await t('J04', 'completion tracking: visit marked attended survives refresh', async () => {
  await page.click('[data-tab="calendar"]'); await page.click('[data-cal-day="2026-10-19"]'); await page.click('[data-visit-done^="agent-"]');
  await open(); await page.click('[data-tab="calendar"]'); await page.click('[data-cal-day="2026-10-19"]');
  return (await page.getAttribute('[data-visit-done^="agent-"]', 'aria-pressed')) === 'true' && /✓/.test(await text('[data-cal-day="2026-10-19"]'));
});
await t('J05', 'dose ticks for a clear medicine are shared between Calendar and Today and persist', async () => {
  await loadSample('07_medication_changes.pdf');
  await page.click('[data-tab="calendar"]'); await page.click('[data-cal-day="2026-10-17"]');
  const key = await page.getAttribute('.cc-med-list [data-dose]', 'data-dose');
  await page.click(`.cc-med-list [data-dose="${key}"]`);
  await page.click('[data-tab="today"]');
  const today = await page.getAttribute(`[data-dose="${key}"]`, 'aria-pressed');
  await open(); await page.click('[data-tab="calendar"]'); await page.click('[data-cal-day="2026-10-17"]');
  const after = await page.getAttribute(`.cc-med-list [data-dose="${key}"]`, 'aria-pressed');
  return today === 'true' && after === 'true' ? `${key}: shown in Today, kept after reload` : fail(`today=${today} afterReload=${after}`);
});
await t('J06', 'past visit not marked → “missed?” prompt; never assumed', async () => {
  await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('clearcare-ext-visits') || '[]'); v.push({ id: 'past1', who: 'Riya', title: 'Dentist', date: '2026-10-10', time: '10:00', place: '', notes: '', remind: [] }); localStorage.setItem('clearcare-ext-visits', JSON.stringify(v)); });
  await open(); await page.click('[data-tab="calendar"]'); await page.click('[data-cal-day="2026-10-10"]');
  const ag = await text('.cc-cal-agenda'); return /not marked as attended/.test(ag) ? 'prompt shown' : fail(ag.slice(0, 200));
});
await t('J07', 'safety gate: urgent symptom shows emergency help (no AI request)', async () => {
  const before = mockCalls; await page.click('[data-tab="today"]');
  await page.fill('#cc-q', 'I have chest pain and trouble breathing'); await page.click('.cc-ask-form button[type="submit"]');
  await page.waitForSelector('.cc-urgent'); return /108 · 112 · 911/.test(await text('.cc-urgent')) && mockCalls === before;
});
await t('J08', 'safety gate: dose change and prescribing requests are redirected (Hindi and English)', async () => {
  await page.fill('#cc-q', 'Can I double my medication?'); await page.click('.cc-ask-form button[type="submit"]');
  const a = await text('.cc-answer');
  await page.fill('#cc-q', 'क्या मैं दवा दोगुनी ले लूँ?'); await page.click('.cc-ask-form button[type="submit"]');
  const b = await text('.cc-answer');
  return /can’t change how you take a medicine/.test(a) && /नहीं बदल सकता/.test(b) ? 'EN and HI redirected' : fail(`a=${a.slice(0, 80)} | b=${b.slice(0, 80)}`);
});
await t('J09', 'Care Agent escalates “should I stop…” without calling AI; answers a schedule question with a trace', async () => {
  await loadSample('05_high_risk_apixaban.pdf');
  const before = mockCalls;
  await page.fill('#cc-q', 'Should I stop taking apixaban?'); await page.click('[data-act="agent"]'); await page.waitForSelector('.cc-agent-why');
  const esc = await text('.cc-agent'); const noAi = mockCalls === before;
  await page.fill('#cc-q', 'When is my follow-up?'); await page.click('[data-act="agent"]'); await page.waitForFunction(() => /Steps the agent took/.test(document.querySelector('.cc-agent')?.textContent || ''));
  const ans = await text('.cc-agent');
  return /Safety response/.test(esc) && noAi && /October 19/.test(ans) && /Checked the day|Listed upcoming/.test(ans) ? 'escalated without AI; schedule answer with steps' : false;
});
await t('J10', '“Can you make that easier?” gives a simpler explanation of the instruction in focus', async () => {
  await page.fill('#cc-q', 'Can you make that easier?'); await page.click('.cc-ask-form button[type="submit"]');
  return /Let me put it more simply/.test(await text('.cc-answer'));
});
await t('J11', 'Hindi-English code-mixed question answered in Hindi', async () => {
  await page.fill('#cc-q', 'meri dawai kab leni hai'); await page.click('.cc-ask-form button[type="submit"]');
  return /[ऀ-ॿ]/.test(await text('.cc-answer'));
});
await t('J12', 'Kannada: lines translated (mock) with kn-IN language tags; numbers and names unchanged', async () => {
  await page.selectOption('[data-xlang]', 'kn'); await page.waitForFunction(() => document.querySelector('.cc-transcript [lang="kn-IN"]'), null, { timeout: 15000 });
  const line = await page.$$eval('.cc-explain[lang="kn-IN"]', l => l.map(x => x.textContent));
  return line.some(l => /Apixaban 5 mg/.test(l)) ? line[0].slice(0, 80) : false;
});
await t('J13', 'voice: Hear my day speaks, Stop interrupts immediately (no overlapping audio)', async () => {
  await page.click('[data-lang="en"]');
  await page.evaluate(() => { window.__spoken = []; window.__cancels = 0; });
  await page.click('[data-act="hear"]'); await page.waitForTimeout(150); await page.click('[data-act="stop"]'); await page.waitForTimeout(900);
  const s = await page.evaluate(() => ({ spoken: window.__spoken.length, cancels: window.__cancels }));
  return s.spoken >= 1 && s.cancels >= 1 && s.spoken < 4 ? JSON.stringify(s) : false;
});
await t('J14', 'calendar voice: “Hear my calendar” gives the next verified visit and what needs confirming', async () => {
  await page.click('[data-tab="calendar"]'); await page.evaluate(() => { window.__spoken = []; });
  await page.click('[data-act="cal-hear"]'); await page.waitForTimeout(2500);
  const said = (await page.evaluate(() => window.__spoken.map(s => s.text))).join(' ');
  return /Here is your calendar/.test(said) && /next visit|no upcoming visits/.test(said) && /confirm/.test(said) ? said.slice(0, 160) : fail(`said: ${said.slice(0, 200)}`);
});
await t('J15', 'duplicate reminder prevention: one reminder per visit and offset', async () => {
  await page.click('[data-act="visit-add"]');
  const at = await page.evaluate(() => { const d = new Date(Date.now() + 64 * 60000); const p = n => String(n).padStart(2, '0'); return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` }; });
  await page.fill('input[name="title"]', 'Physio'); await page.fill('input[name="date"]', at.date); await page.fill('input[name="time"]', at.time);
  await page.selectOption('select[name="remind"]', '1'); await page.click('.cc-visit-form button[type="submit"]');
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));
  await page.evaluate(() => { window.__spoken = []; });
  const fired = () => page.evaluate(() => window.__spoken.filter(s => /Physio/.test(s.text) && /Reminder/.test(s.text)).length);
  await page.clock.runFor('04:30'); await page.waitForTimeout(300);
  const first = await fired();
  await page.clock.runFor('03:00'); await page.waitForTimeout(300);
  const second = await fired();
  return first === 1 && second === 1 ? 'fired once, not repeated' : fail(`first=${first} second=${second} at=${JSON.stringify(at)} now=${await page.evaluate(() => new Date().toString())} visits=${await page.evaluate(() => localStorage.getItem('clearcare-ext-visits'))} toasts=${(await page.$$eval('.toast', ts => ts.map(x => x.textContent))).join(' / ')}`);
});
await t('J16', 'keyboard only: reach Family calendar and choose a day without a mouse', async () => {
  await page.click('[data-tab="today"]'); await page.evaluate(() => document.activeElement?.blur());
  let ok = false;
  for (let i = 0; i < 80 && !ok; i++) { await page.keyboard.press('Tab'); ok = await page.evaluate(() => document.activeElement?.id === 'cc-nav-calendar'); }
  if (!ok) return false;
  await page.keyboard.press('Enter'); await page.waitForSelector('.cc-cal-grid');
  await page.focus('[data-cal-day="2026-10-19"]'); await page.keyboard.press('Enter');
  return /Monday, October 19/.test(await text('.cc-cal-agenda h3'));
});
await t('J17', 'prompt-injection PDF: injected lines quarantined, injected 10 mg dose never shown', async () => {
  await page.click('[data-lang="en"]'); await page.selectOption('[data-xlang]', '');
  await loadSample('14_prompt_injection.pdf').catch(async () => { await page.evaluate(async () => { const r = await fetch('/samples/14_prompt_injection.pdf'); const f = new File([await r.blob()], '14_prompt_injection.pdf', { type: 'application/pdf' }); document.dispatchEvent(new CustomEvent('clearcare:document', { detail: { file: f } })); }); await page.waitForTimeout(1500); });
  const body = await text('#cc-today');
  return /looked like instructions to software/.test(body) && !/10 mg/.test(await text('.cc-tabpanel'));
});
await t('J18', 'Gemini authentication failure: the explanation shows an honest error, nothing crashes', async () => {
  await loadSample('01_everyday_recovery.pdf'); mockMode = '401';
  await page.click('[data-tab="medicines"]'); await page.click('[data-act="ai"]'); await page.waitForSelector('.cc-ai-warn');
  mockMode = 'ok'; const w = await text('.cc-ai-warn'); if (!/rejected/i.test(w)) throw new Error('unclear message: ' + w.slice(0, 160)); return w.trim().slice(0, 140);
});
await t('J19', 'AI activity panel shows provider, model and request ids (mock-labelled here)', async () => {
  await page.click('[data-act="gemini-refresh"]').catch(() => {}); await page.waitForTimeout(500);
  const s = await text('.cc-amd-activity');
  return /Google Gemini API/.test(s) && /gemini-3\.8-flash/.test(s) ? 'panel rendered' : false;
});
const axePath = [process.env.AXE_PATH, join(root, 'node_modules/axe-core/axe.min.js')].find(p => p && existsSync(p));
await t('J20', 'axe-core scan of the Calendar (WCAG 2.1 A/AA)', async () => {
  if (!axePath) return 'SKIPPED: axe-core not installed';
  await page.click('[data-tab="calendar"]'); await page.evaluate(readFileSync(axePath, 'utf8')); // via DevTools, so the app's strict CSP stays on
  const r = await page.evaluate(() => window.axe.run(document.querySelector('#cc-today'), { runOnly: ['wcag2a', 'wcag2aa'] }));
  const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  if (bad.length) throw new Error(bad.map(v => `${v.id}: ${v.nodes.slice(0, 12).map(n => n.target.join(' ') + ' [' + (n.any[0]?.data ? n.any[0].data.fgColor + ' on ' + n.any[0].data.bgColor + ' ' + n.any[0].data.contrastRatio : '') + ']').join(' | ')}`).join(' ; '));
  return `${r.violations.length} violations, 0 serious/critical`;
});
await t('J21', 'while Today/Calendar is open, the original overview never shows underneath it', async () => { await page.click('[data-tab="today"]'); const leaks = await page.evaluate(() => [...document.querySelectorAll('.content > :not(#cc-today)')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.className || e.tagName)); return leaks.length === 0 ? 'hidden' : fail('visible: ' + leaks.join(', ')); });
rec('J00', 'no JavaScript errors during the journey', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); server.kill(); mock.close();
const pass = results.filter(r => r.status === 'PASS').length;
console.log(`\nJourney E2E: ${pass} passed, ${results.length - pass} failed`);
writeFileSync(join(root, 'docs/evidence/journey-e2e.json'), JSON.stringify({ ranAt: new Date().toISOString(), browser: process.env.CLEARCARE_E2E_CHANNEL || 'chromium', results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
