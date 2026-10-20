// ClearCare extension UI: Today (voice-guided daily check-in), grounded questions, preferences.
// Loaded alongside the original app.js. Talks to it only through the small bridge events.
import { ingestPdfInBrowser } from './document/browser-provider.js';
import { pagesFromPlainText } from './document/layout.js';
import { extractInstructions } from './clinical/engine.js';
import { renderItemSafe as renderItem, reasonText, formatDate, formatTime, freqText } from './clinical/render.js';
import { buildDay, buildBriefing, isoDate, addDays, partOfDay } from './calendar/briefing.js';
import { buildReminderIcs, visitEventLines } from './calendar/ics.js';
import { answerLocally, classify } from './qa/intent.js';
import { LANGS, EXTRA_LANGS, normalizeLang, legacyLabel, t } from './i18n.js';
import { WebSpeechSynthesisProvider, SpeechPlaybackController, WebSpeechRecognitionProvider } from './ui/voice.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: keep in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};
const KEYS = { prefs: 'clearcare-ext-prefs', reminders: 'clearcare-ext-reminders', done: 'clearcare-ext-done', plan: 'clearcare-ext-plan', understood: 'clearcare-ext-understood', questions: 'clearcare-ext-questions', day1: 'clearcare-ext-day1', visits: 'clearcare-ext-visits', xcache: 'clearcare-ext-translations' };
const L = (en, es, hi) => ({ en, es, hi });
const pick = (o, lang) => o[normalizeLang(lang)] ?? o.en;

const state = {
  prefs: { lang: normalizeLang((() => { try { return localStorage.getItem('clearcare-language') || 'English'; } catch { return 'English'; } })()), mode: 'simple', rate: 0.95, autoRead: false, rememberPlan: false, inAppReminders: false, preferLocalVoices: true, importantOnly: false, ...store.get(KEYS.prefs, {}) },
  plan: null, docMeta: null, tab: 'today', questionDraft: '', questionStatus: '', reminders: store.get(KEYS.reminders, {}), done: new Set(store.get(KEYS.done, [])), understood: new Set(store.get(KEYS.understood, [])), questions: store.get(KEYS.questions, []), day1: store.get(KEYS.day1, {}),
  itemMode: new Map(), ai: new Map(), answer: null, lastItemIds: [], status: null, speakingId: null, firedReminders: new Set(),
  visits: store.get(KEYS.visits, []), calMonth: null, calSel: null, calEdit: null, calForm: false
};
if (state.prefs.rememberPlan) state.plan = store.get(KEYS.plan, null);
const savePrefs = () => { store.set(KEYS.prefs, state.prefs); try { localStorage.setItem('clearcare-language', legacyLabel(state.prefs.lang)); } catch { /* ignore */ } };

const synth = new WebSpeechSynthesisProvider();
const player = new SpeechPlaybackController(synth);
const recognizer = new WebSpeechRecognitionProvider();
let briefing = [];

// ---------------- plan ingestion ----------------
async function planFromBridge(detail) {
  try {
    if (detail.file) {
      const doc = await ingestPdfInBrowser(detail.file);
      setPlan(extractInstructions(doc), { method: doc.method, status: doc.status, pageCount: doc.pageCount, warnings: doc.warnings, filename: detail.file.name });
    } else if (detail.doc?.source) {
      const doc = pagesFromPlainText(detail.doc.source, 'synthetic-demo');
      setPlan(extractInstructions(doc), { method: 'synthetic-demo', status: 'ok', pageCount: 1, warnings: ['Synthetic example text (no PDF). Page numbers are not available.'], filename: detail.doc.filename });
    }
  } catch (err) { state.docMeta = { error: err.message || 'The document could not be read.' }; render(); }
}
function setPlan(plan, meta) {
  state.plan = plan; state.docMeta = meta; state.ai.clear(); state.itemMode.clear(); state.answer = null;
  if (state.prefs.rememberPlan) store.set(KEYS.plan, plan);
  render();
}

// ---------------- day + briefing ----------------
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
function todayIso() { return isoDate(new Date(), tz()); }
function remindersWithDay1() { return state.reminders; }
function dayFor(iso) { return buildDay(state.plan, { date: iso, reminders: remindersWithDay1(), done: state.done }); }
function currentBriefing() {
  const day = dayFor(todayIso());
  briefing = buildBriefing(day, { lang: state.prefs.lang, part: partOfDay(new Date(), tz()), mode: state.prefs.importantOnly ? 'important' : 'full', planPresent: Boolean(state.plan) });
  // Family doctor visits (added by the user) for today and tomorrow, read before the closing line.
  const lang = state.prefs.lang, today = todayIso();
  const visitSegs = [[today, L('Today', 'Hoy', 'आज')], [addDays(today, 1), L('Tomorrow', 'Mañana', 'कल')]].flatMap(([d, when]) =>
    userVisitsOn(d).map((v, i) => ({ id: `visit-${d}-${i}`, kind: 'visit', text: `${pick(when, lang)}: ${visitSentence(v, lang)}` })));
  if (visitSegs.length) briefing.splice(state.plan ? briefing.length - 1 : briefing.length, 0, ...visitSegs);
  return { day, briefing };
}

// ---------------- more languages (AI translation, verified on the server) ----------------
// ClearCare's own English text is translated by Gemini in batches; a line is shown translated only when
// the server's checks passed, otherwise it stays in English. The AI key may allow one request a
// minute, so translations are cached in this browser and on this computer.
const xl = () => (EXTRA_LANGS[state.prefs.xlang] ? state.prefs.xlang : null);
const xcache = new Map(Object.entries(store.get(KEYS.xcache, {})));
const xpending = new Set();
let xtimer = null, xbusy = false;
state.xmsg = '';
function tx(text) {
  const code = xl();
  if (!code || !text || !/\p{L}/u.test(text)) return { text, code: null };
  const k = code + '|' + text;
  if (xcache.has(k)) { const v = xcache.get(k); return v ? { text: v, code } : { text, code: null, failed: true }; }
  xpending.add(text); if (!xtimer) xtimer = setTimeout(flushTx, 120);
  return { text, code: null, pending: true };
}
async function flushTx() {
  xtimer = null;
  const code = xl();
  if (xbusy || !code || !xpending.size) return;
  const batch = []; let n = 0;
  for (const t of xpending) { if (t.length > 1200) { xcache.set(code + '|' + t, false); xpending.delete(t); continue; } if (n + t.length > 2400 || batch.length >= 30) break; batch.push(t); n += t.length; }
  if (!batch.length) return;
  xbusy = true; state.xmsg = ` Translating ${batch.length} line(s)… The AI allows limited requests per minute, so this can take a minute.`; renderXStatus();
  try {
    const res = await fetch('/api/v2/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: code, texts: batch }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Translation failed.'), { code: data.code });
    for (const it of data.items || []) { xcache.set(code + '|' + it.source, it.status === 'verified' ? it.text : false); xpending.delete(it.source); }
    store.set(KEYS.xcache, Object.fromEntries([...xcache].filter(([, v]) => v).slice(-1500)));
    state.xmsg = '';
  } catch (e) {
    state.xmsg = e.code === 'not_configured' ? ' AI translation needs the Gemini key on this computer. Showing English.' : ' The AI is busy. Translation will try again in a minute; English is shown meanwhile.';
    xbusy = false; renderXStatus(); setTimeout(flushTx, 60000); return;
  }
  xbusy = false;
  if (xl() === code) render();
  if (xpending.size) xtimer = setTimeout(flushTx, 120);
}
function renderXStatus() { const el = $('#cc-x-status'); if (el) el.textContent = state.xmsg; }
/** Resolves once every text has a translation result (verified or not). */
async function ensureTx(texts) {
  const code = xl(); if (!code) return;
  texts.forEach(t => tx(t));
  for (let i = 0; i < 400 && texts.some(t => /\p{L}/u.test(t) && !xcache.has(code + '|' + t)) && xl() === code; i++) await new Promise(r => setTimeout(r, 500));
}
// Text in the viewer's language, with lang/dir attributes and an honest marker per line.
function txHtml(text, { tag = 'span', cls = '' } = {}) {
  const r = tx(text), lang = state.prefs.lang;
  const code = r.code || (xl() ? 'en' : lang);
  const attrs = `lang="${(EXTRA_LANGS[code] || LANGS[normalizeLang(code)]).bcp47}"${EXTRA_LANGS[code]?.rtl ? ' dir="rtl"' : ''}${cls ? ` class="${cls}"` : ''}`;
  const note = !xl() ? '' : r.code ? ' <span class="cc-x-tag" title="AI translation by Gemini. Numbers, doses and medicine names were locked and checked.">🌐</span>' : r.pending ? ' <span class="cc-x-tag" title="Translating…">…</span>' : ' <span class="cc-x-tag" title="This line could not be translated safely, so it is shown in English.">EN</span>';
  return `<${tag} ${attrs}>${esc(r.text)}</${tag}>${note}`;
}

// ---------------- Care Agent (agentic, explainable) ----------------
state.agent = null;
async function askAgent(question) {
  const lang = state.prefs.lang, started = Date.now();
  state.questionDraft = question; state.questionStatus = ''; state.agent = { question, working: true }; render();
  const tick = setInterval(() => { const el = $('#cc-agent-wait'); if (el) el.textContent = ` ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  try {
    const items = state.plan?.items || []; // the local server needs the full items to rebuild schedules
    const res = await fetch('/api/v2/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, language: lang, today: todayIso(), items, visits: state.visits }) });
    const data = await res.json().catch(() => ({}));
    state.agent = res.ok ? { question, ...data } : { question, status: 'error', error: data.error || 'The Care Agent could not answer right now.' };
  } catch { state.agent = { question, status: 'error', error: 'The Care Agent could not be reached.' }; }
  clearInterval(tick);
  render();
  $('.cc-agent')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
const TOOL_LABEL = { search_document: L('Searched your discharge papers', 'Buscó en sus papeles de alta', 'आपके डिस्चार्ज कागज़ों में खोजा'), get_item: L('Read one instruction in detail', 'Leyó una indicación en detalle', 'एक निर्देश ध्यान से पढ़ा'), day_schedule: L('Checked the day’s schedule', 'Revisó el horario del día', 'दिन का कार्यक्रम देखा'), upcoming_visits: L('Listed upcoming doctor visits', 'Listó las próximas citas', 'आने वाली मुलाक़ातें देखीं'), safety_flags: L('Checked safety flags', 'Revisó las alertas de seguridad', 'सुरक्षा चेतावनियाँ देखीं') };
function obsSummary(o) {
  if (Array.isArray(o)) return `${o.length} result(s)`;
  if (!o || typeof o !== 'object') return '';
  if (o.result || o.error) return o.result || o.error;
  return Object.entries(o).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v.length}`).join(' · ');
}
function agentHtml() {
  const a = state.agent, lang = state.prefs.lang;
  if (!a) return '';
  if (a.working) return `<div class="cc-agent" aria-live="polite"><p class="cc-label">🤖 ${esc(pick(L('Care Agent is working: planning, checking its tools, then asking the AI', 'El Agente está trabajando: planifica, usa sus herramientas y consulta a la IA', 'केयर एजेंट काम कर रहा है: योजना, टूल से जाँच, फिर AI से पूछना'), lang))}…<span id="cc-agent-wait"></span></p><p class="cc-muted">${esc(pick(L('The AI allows limited requests per minute, so this can take a minute or two.', 'La IA permite pocas solicitudes por minuto; puede tardar uno o dos minutos.', 'AI प्रति मिनट सीमित अनुरोध लेता है, इसलिए एक-दो मिनट लग सकते हैं।'), lang))}</p></div>`;
  if (a.status === 'error') return `<div class="cc-agent cc-ai-warn" aria-live="polite"><p>${esc(a.error)}</p></div>`;
  const statusLabel = { verified: L('Answer checked against your papers', 'Respuesta verificada con sus papeles', 'जवाब आपके कागज़ों से जाँचा गया'), withheld: L('Answer withheld: it did not pass the safety checks', 'Respuesta retenida: no pasó las comprobaciones', 'जवाब रोका गया: सुरक्षा जाँच में पास नहीं हुआ'), tools_only: L('AI not available: showing what the agent’s tools found, word for word', 'IA no disponible: se muestra lo que encontraron las herramientas, tal cual', 'AI उपलब्ध नहीं: टूल ने जो पाया, वही शब्दशः'), not_found: L('Not found in your papers or calendar', 'No encontrado en sus papeles ni calendario', 'आपके कागज़ों या कैलेंडर में नहीं मिला'), refused: L('Question not accepted', 'Pregunta no aceptada', 'सवाल स्वीकार नहीं') }[a.status] || L(String(a.status), String(a.status), String(a.status));
  const conf = a.confidence ? ` · ${pick(L('confidence', 'confianza', 'भरोसा'), lang)}: ${a.confidence}` : '';
  const answer = a.answer ? `<p class="cc-agent-answer">${txHtml(a.answer)}</p><button type="button" data-act="agent-listen">🔊 ${esc(t('listen', lang))}</button>` : '';
  const sources = (a.sources || []).length ? `<h4>${esc(pick(L('Evidence it used', 'Evidencia usada', 'इस्तेमाल किए गए सबूत'), lang))}</h4><ul class="cc-agent-src">${a.sources.map(s => `<li><span class="cc-chip">${s.kind === 'calendar' ? '📅' : '📄'} ${esc(s.kind === 'calendar' ? pick(L('Your calendar', 'Su calendario', 'आपका कैलेंडर'), lang) : `${pick(L('Discharge papers', 'Papeles de alta', 'डिस्चार्ज कागज़'), lang)}${s.page ? ` · ${t('page', lang)} ${s.page}` : ''}`)}</span> <q lang="en">${esc(s.text)}</q></li>`).join('')}</ul>` : '';
  const steps = (a.trace || []).length ? `<h4>${esc(pick(L('Steps the agent took', 'Pasos del agente', 'एजेंट के कदम'), lang))}</h4><ol class="cc-agent-steps">${a.trace.map(s => `<li><strong>${esc(pick(TOOL_LABEL[s.tool] || L(s.tool, s.tool, s.tool), lang))}</strong> <span class="cc-muted">${esc(obsSummary(s.observation))}</span><br><span>${esc(s.thought)}</span></li>`).join('')}</ol>` : '';
  const reasoning = (a.reasoning || []).length ? `<h4>${esc(pick(L('How the AI reasoned', 'Cómo razonó la IA', 'AI ने कैसे सोचा'), lang))}</h4><ul>${a.reasoning.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  const checks = (a.checks || []).length ? `<h4>${esc(pick(L('Safety checks', 'Comprobaciones de seguridad', 'सुरक्षा जाँच'), lang))}</h4><ul class="cc-agent-checks">${a.checks.map(c => `<li class="${c.ok ? 'is-ok' : 'is-bad'}">${c.ok ? '✔' : '✘'} ${esc(c.name)}${c.note ? ` <span class="cc-muted">(${esc(c.note)})</span>` : ''}</li>`).join('')}</ul>${a.failures?.length ? `<p class="cc-muted">${esc(a.failures.join(', '))}</p>` : ''}` : '';
  return `<div class="cc-agent" aria-live="polite"><p class="cc-label">🤖 Care Agent · ${esc(pick(statusLabel, lang))}${esc(conf)}${a.provider?.mock ? ' · TEST MOCK' : ''}</p><p class="cc-q-echo">“${esc(a.question)}”</p>${a.aiError ? `<p class="cc-muted">${esc(a.aiError)}</p>` : ''}${answer}
    <details class="cc-agent-why" ${a.status !== 'verified' ? 'open' : ''}><summary>${esc(pick(L('Why this answer? (explainable AI)', '¿Por qué esta respuesta? (IA explicable)', 'यह जवाब क्यों? (समझाने योग्य AI)'), lang))}</summary>${steps}${reasoning}${sources}${checks}</details></div>`;
}

// ---------------- family calendar (doctor visits) ----------------
// Visits the user adds themselves (e.g. a parent taking a child to the paediatrician) plus the
// CLEAR, dated follow-ups from the discharge document. Unclear follow-ups are never placed on a date.
const saveVisits = () => store.set(KEYS.visits, state.visits);
const visitSort = (a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99'));
function userVisitsOn(date) { return state.visits.filter(v => v.date === date).sort(visitSort); }
function docVisits() { return (state.plan?.items || []).filter(i => (i.category === 'appointment' || i.category === 'test') && i.clarity === 'clear' && i.date); }
function visitTitle(v) { return `${v.who ? `${v.who}: ` : ''}${v.title}`; }
function visitSentence(v, lang) {
  const parts = [visitTitle(v)];
  if (v.doctor) parts.push(pick(L(`with ${v.doctor}`, `con ${v.doctor}`, `${v.doctor} के साथ`), lang));
  if (v.time) parts.push(pick(L(`at ${formatTime(v.time, 'en')}`, `a las ${formatTime(v.time, 'es')}`, `${formatTime(v.time, 'hi')} बजे`), lang));
  if (v.place) parts.push(pick(L(`at ${v.place}`, `en ${v.place}`, `${v.place} में`), lang));
  let s = parts.join(', ') + (lang === 'hi' ? '।' : '.');
  if (v.notes) s += ' ' + pick(L('Note: ', 'Nota: ', 'ध्यान दें: '), lang) + v.notes;
  return s;
}
function daysUntil(date) { return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${todayIso()}T12:00:00Z`)) / 86400000); }
function relDay(date, lang) { try { return new Intl.RelativeTimeFormat(LANGS[lang].locale, { numeric: 'auto' }).format(daysUntil(date), 'day'); } catch { return formatDate(date, lang); } }
const REMIND = [[[], L('No reminder', 'Sin recordatorio', 'कोई रिमाइंडर नहीं')], [[60], L('1 hour before', '1 hora antes', '1 घंटा पहले')], [[120], L('2 hours before', '2 horas antes', '2 घंटे पहले')], [[1440], L('1 day before', '1 día antes', '1 दिन पहले')], [[1440, 60], L('1 day before and 1 hour before', '1 día antes y 1 hora antes', '1 दिन पहले और 1 घंटा पहले')]];
function visitToIcs(v) { return { uid: `visit-${v.id}`, title: visitTitle(v) + (v.doctor ? ` (${v.doctor})` : ''), date: v.date, time: v.time || null, location: v.place || '', description: [v.notes, 'Added by you in ClearCare.'].filter(Boolean).join(' '), alarms: v.time ? v.remind || [] : [] }; }
function docVisitToIcs(a) { return { uid: `doc-${a.id}`, title: `Follow-up${a.with ? ` with ${a.with}` : ''}`, date: a.date, time: a.time || null, location: a.location || '', description: `From your discharge document: "${a.provenance?.text || ''}". Check with your care team if anything changes.`, alarms: a.time ? [1440] : [] }; }

function calendarHtml() {
  const lang = state.prefs.lang, today = todayIso();
  const month = state.calMonth || today.slice(0, 7), sel = state.calSel || today;
  const first = `${month}-01`, lead = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const nextMonth = addDays(first, 32).slice(0, 7);
  const lastDay = addDays(`${nextMonth}-01`, -1);
  const weeks = Math.ceil((lead + Number(lastDay.slice(8))) / 7);
  const loc = LANGS[lang].locale;
  const monthName = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${first}T12:00:00Z`));
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const docs = docVisits();
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const d = addDays(first, i - lead), inMonth = d.slice(0, 7) === month;
    const mine = userVisitsOn(d), doc = docs.filter(a => a.date === d);
    const meds = state.plan && d >= today && dayFor(d).medications.length;
    const chips = [...mine.map(v => `<span class="cc-cal-chip">${v.time ? esc(formatTime(v.time, lang)) + ' ' : ''}${esc(visitTitle(v))}</span>`), ...doc.map(a => `<span class="cc-cal-chip cc-cal-chip-doc">${a.time ? esc(formatTime(a.time, lang)) + ' ' : ''}${esc(pick(L('Follow-up', 'Control', 'फ़ॉलो-अप'), lang))}</span>`)];
    const label = `${formatDate(d, lang)}${mine.length + doc.length ? ` · ${mine.length + doc.length} ${pick(L('visit(s)', 'cita(s)', 'मुलाक़ात'), lang)}` : ''}`;
    return `<button type="button" class="cc-cal-day ${inMonth ? '' : 'is-out'} ${d === today ? 'is-today' : ''} ${d === sel ? 'is-sel' : ''}" data-cal-day="${d}" aria-pressed="${d === sel}" aria-label="${esc(label)}"><span class="cc-cal-num">${Number(d.slice(8))}${meds ? ' <span class="cc-cal-med" aria-hidden="true">💊</span>' : ''}</span>${chips.slice(0, 2).join('')}${chips.length > 2 ? `<span class="cc-cal-more">+${chips.length - 2}</span>` : ''}</button>`;
  }).join('');

  const upcoming = [...state.visits.filter(v => v.date >= today).map(v => ({ date: v.date, time: v.time, html: esc(visitTitle(v)) + (v.doctor ? ` <span class="cc-muted">· ${esc(v.doctor)}</span>` : ''), place: v.place })),
    ...docs.filter(a => a.date >= today).map(a => ({ date: a.date, time: a.time, html: esc(pick(L('Follow-up (from your papers)', 'Control (de sus papeles)', 'फ़ॉलो-अप (आपके कागज़ों से)'), lang)) + (a.with ? ` <span class="cc-muted">· ${esc(a.with)}</span>` : ''), place: a.location }))].sort(visitSort).slice(0, 4);
  const nextHtml = upcoming.length
    ? upcoming.map(u => `<li><span class="cc-cal-when"><strong>${esc(relDay(u.date, lang))}</strong><span>${esc(formatDate(u.date, lang))}${u.time ? ' · ' + esc(formatTime(u.time, lang)) : ''}</span></span><span>${u.html}${u.place ? `<br><span class="cc-muted">${esc(u.place)}</span>` : ''}</span></li>`).join('')
    : `<li class="cc-muted">${esc(pick(L('No visits coming up. Add one with “Add a doctor visit”.', 'No hay citas próximas. Agregue una con “Agregar una cita”.', 'कोई आने वाली मुलाक़ात नहीं। “डॉक्टर की मुलाक़ात जोड़ें” से जोड़ें।'), lang))}</li>`;

  const selMine = userVisitsOn(sel), selDoc = docs.filter(a => a.date === sel), selMeds = state.plan && sel >= today ? dayFor(sel).medications : [];
  const agenda = [
    ...selMine.map(v => `<div class="cc-visit"><div><strong>${v.time ? esc(formatTime(v.time, lang)) + ' · ' : ''}${esc(visitTitle(v))}</strong>${v.doctor ? `<span>${esc(v.doctor)}</span>` : ''}${v.place ? `<span>📍 ${esc(v.place)}</span>` : ''}${v.notes ? `<span>📝 ${esc(v.notes)}</span>` : ''}${v.time && v.remind?.length ? `<span>🔔 ${esc(pick(REMIND.find(r => r[0].join() === v.remind.join())?.[1] || REMIND[0][1], lang))}</span>` : ''}</div>
      <div class="cc-row"><button type="button" data-act="visit-speak" data-visit="${esc(v.id)}">🔊 ${esc(t('listen', lang))}</button><button type="button" data-act="visit-edit" data-visit="${esc(v.id)}">${esc(pick(L('Edit', 'Editar', 'बदलें'), lang))}</button><button type="button" data-act="visit-ics" data-visit="${esc(v.id)}">${esc(pick(L('Add to my calendar', 'Agregar a mi calendario', 'मेरे कैलेंडर में जोड़ें'), lang))}</button><button type="button" data-act="visit-del" data-visit="${esc(v.id)}">${esc(pick(L('Delete', 'Borrar', 'हटाएँ'), lang))}</button></div></div>`),
    ...selDoc.map(a => card(a)),
    selMeds.length ? `<div class="cc-visit"><div><strong>💊 ${esc(t('medicines', lang))}</strong>${selMeds.map(m => `<span>${esc(title(m.item))}${m.slots.some(s => s.userTime) ? ' · ' + m.slots.map(s => s.userTime).filter(Boolean).map(x => formatTime(x, lang)).join(', ') : ''}</span>`).join('')}</div></div>` : ''
  ].join('');

  const e = state.calEdit ? state.visits.find(v => v.id === state.calEdit) || {} : {};
  const whoList = [...new Set(state.visits.map(v => v.who).filter(Boolean))];
  const form = state.calForm ? `<form class="cc-visit-form" data-form="visit" aria-labelledby="cc-vf-h"><h3 class="cc-h3" id="cc-vf-h">${esc(state.calEdit ? pick(L('Change this visit', 'Cambiar esta cita', 'यह मुलाक़ात बदलें'), lang) : pick(L('Add a doctor visit', 'Agregar una cita médica', 'डॉक्टर की मुलाक़ात जोड़ें'), lang))}</h3>
    <label>${esc(pick(L('Who is it for?', '¿Para quién es?', 'किसके लिए?'), lang))}<input name="who" maxlength="60" list="cc-who-list" value="${esc(e.who || '')}" placeholder="${esc(pick(L('e.g. Riya, Papa, me', 'p. ej. Sofía, papá, yo', 'जैसे रिया, पापा, मैं'), lang))}"><datalist id="cc-who-list">${whoList.map(w => `<option value="${esc(w)}">`).join('')}</datalist></label>
    <label>${esc(pick(L('What is the visit?', '¿Qué cita es?', 'मुलाक़ात किस लिए?'), lang))} *<input name="title" required maxlength="100" value="${esc(e.title || '')}" placeholder="${esc(pick(L('e.g. Child specialist check-up, vaccination', 'p. ej. Revisión con el pediatra, vacuna', 'जैसे बच्चों के डॉक्टर से जाँच, टीका'), lang))}"></label>
    <label>${esc(pick(L('Doctor', 'Médico', 'डॉक्टर'), lang))}<input name="doctor" maxlength="80" value="${esc(e.doctor || '')}" placeholder="${esc(pick(L('e.g. Dr. Mehta', 'p. ej. Dra. López', 'जैसे डॉ. मेहता'), lang))}"></label>
    <div class="cc-row"><label>${esc(pick(L('Date', 'Fecha', 'तारीख़'), lang))} *<input type="date" name="date" required value="${esc(e.date || sel)}"></label><label>${esc(pick(L('Time', 'Hora', 'समय'), lang))}<input type="time" name="time" value="${esc(e.time || '')}"></label></div>
    <label>${esc(pick(L('Place', 'Lugar', 'जगह'), lang))}<input name="place" maxlength="120" value="${esc(e.place || '')}" placeholder="${esc(pick(L('e.g. City Children’s Clinic, MG Road', 'p. ej. Clínica Infantil, Calle Mayor', 'जैसे सिटी चिल्ड्रन क्लिनिक, एमजी रोड'), lang))}"></label>
    <label>${esc(pick(L('Notes (what to bring, questions to ask)', 'Notas (qué llevar, qué preguntar)', 'नोट (क्या ले जाना है, क्या पूछना है)'), lang))}<textarea name="notes" maxlength="300" rows="2">${esc(e.notes || '')}</textarea></label>
    <label>${esc(pick(L('Remind me', 'Recordarme', 'मुझे याद दिलाएँ'), lang))}<select name="remind">${REMIND.map(([m, l], i) => `<option value="${i}" ${(e.remind || [1440, 60]).join() === m.join() ? 'selected' : ''}>${esc(pick(l, lang))}</option>`).join('')}</select></label>
    <p class="cc-muted">${esc(pick(L('Reminders pop up while ClearCare is open. Use “Add to my calendar” so your phone or computer calendar reminds you even when ClearCare is closed.', 'Los recordatorios aparecen con ClearCare abierto. Use “Agregar a mi calendario” para que su calendario le avise aunque ClearCare esté cerrado.', 'रिमाइंडर तब दिखते हैं जब ClearCare खुला हो। “मेरे कैलेंडर में जोड़ें” से आपका फ़ोन या कंप्यूटर कैलेंडर ClearCare बंद होने पर भी याद दिलाएगा।'), lang))}</p>
    <div class="cc-row"><button type="submit" class="cc-primary">${esc(pick(L('Save visit', 'Guardar cita', 'मुलाक़ात सेव करें'), lang))}</button><button type="button" data-act="visit-cancel">${esc(pick(L('Cancel', 'Cancelar', 'रद्द करें'), lang))}</button></div></form>` : '';

  return `<div class="cc-cal">
    <div class="cc-cal-next panel"><h3 class="cc-h3">${esc(pick(L('Coming up', 'Próximas citas', 'आने वाली मुलाक़ातें'), lang))}</h3><ul>${nextHtml}</ul>
      <div class="cc-row"><button type="button" class="cc-primary" data-act="visit-add">＋ ${esc(pick(L('Add a doctor visit', 'Agregar una cita médica', 'डॉक्टर की मुलाक़ात जोड़ें'), lang))}</button><button type="button" data-act="ics">${esc(pick(L('Add everything to my calendar (.ics)', 'Agregar todo a mi calendario (.ics)', 'सब कुछ मेरे कैलेंडर में जोड़ें (.ics)'), lang))}</button></div></div>
    ${form}
    <div class="cc-cal-head"><button type="button" data-cal-nav="-1" aria-label="${esc(pick(L('Previous month', 'Mes anterior', 'पिछला महीना'), lang))}">‹</button><h3 class="cc-h3" aria-live="polite">${esc(monthName)}</h3><button type="button" data-cal-nav="1" aria-label="${esc(pick(L('Next month', 'Mes siguiente', 'अगला महीना'), lang))}">›</button><button type="button" data-cal-nav="0">${esc(t('today', lang))}</button></div>
    <div class="cc-cal-grid" role="group" aria-label="${esc(monthName)}">${weekdays.map(w => `<span class="cc-cal-wd" aria-hidden="true">${esc(w)}</span>`).join('')}${cells}</div>
    <p class="cc-muted">${esc(pick(L('💊 = medicines from your papers that day. Follow-ups appear only when your papers give a clear date.', '💊 = medicamentos de sus papeles ese día. Los controles aparecen solo si sus papeles dan una fecha clara.', '💊 = उस दिन आपके कागज़ों की दवाएँ। फ़ॉलो-अप सिर्फ़ तब दिखते हैं जब कागज़ों में तारीख़ साफ़ लिखी हो।'), lang))}</p>
    <div class="cc-cal-agenda"><h3 class="cc-h3">${esc(formatDate(sel, lang))} · ${esc(relDay(sel, lang))}</h3>${agenda || `<p class="cc-muted">${esc(pick(L('Nothing planned for this day.', 'Nada planeado para este día.', 'इस दिन कुछ तय नहीं है।'), lang))}</p>`}
      <button type="button" data-act="visit-add">＋ ${esc(pick(L('Add a visit on this day', 'Agregar una cita este día', 'इस दिन मुलाक़ात जोड़ें'), lang))}</button></div>
  </div>`;
}
function saveVisitForm(form) {
  const lang = state.prefs.lang, f = new FormData(form), s = k => String(f.get(k) || '').trim();
  const date = s('date'), time = s('time');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !s('title')) return toast(pick(L('Please give the visit a name and a date.', 'Indique el nombre y la fecha de la cita.', 'कृपया मुलाक़ात का नाम और तारीख़ दें।'), lang));
  const v = { id: state.calEdit || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, who: s('who').slice(0, 60), title: s('title').slice(0, 100), doctor: s('doctor').slice(0, 80), date, time: /^\d{2}:\d{2}$/.test(time) ? time : null, place: s('place').slice(0, 120), notes: s('notes').slice(0, 300), remind: REMIND[Number(f.get('remind'))]?.[0] || [] };
  state.visits = [...state.visits.filter(x => x.id !== v.id), v];
  saveVisits();
  state.calForm = false; state.calEdit = null; state.calSel = date; state.calMonth = date.slice(0, 7);
  toast(pick(L('Visit saved.', 'Cita guardada.', 'मुलाक़ात सेव हो गई।'), lang) + ' ' + visitSentence(v, lang));
  // Ask for system notifications at the moment the user sets a reminder (a real click).
  if (v.time && v.remind.length && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  render();
}

// ---------------- rendering ----------------
const TABS = ['today', 'tomorrow', 'calendar', 'upcoming', 'medicines', 'appointments', 'recovery', 'clarify', 'all'];
const TAB_LABEL = { today: 'today', tomorrow: 'tomorrow', calendar: null, upcoming: 'upcoming', medicines: 'medicines', appointments: 'appointments', recovery: 'recovery', clarify: 'clarify', all: null };
const TAB_OWN_LABEL = { calendar: L('📅 Calendar', '📅 Calendario', '📅 कैलेंडर'), all: L('All', 'Todo', 'सब') };

function chip(item) {
  const lang = state.prefs.lang;
  if (item.category === 'medication' && ['STOP', 'HOLD'].includes(item.status)) return `<span class="cc-chip cc-chip-stop">${esc(t('dontTake', lang))}</span>`;
  if (item.clarity === 'unreadable') return `<span class="cc-chip cc-chip-review">${esc(pick(L('Unreadable', 'Ilegible', 'पढ़ा नहीं गया'), lang))}</span>`;
  if (item.clarity !== 'clear') return `<span class="cc-chip cc-chip-review">${esc(t('clarify', lang))}</span>`;
  if (item.highRisk) return `<span class="cc-chip cc-chip-review">${esc(t('clarify', lang))}</span>`;
  if (item.frequency?.prn) return `<span class="cc-chip">${esc(pick(L('Only when needed', 'Solo si lo necesita', 'ज़रूरत पड़ने पर'), lang))}</span>`;
  if (item.category === 'warning') return `<span class="cc-chip cc-chip-warn">${esc(item.severity === 'emergency' ? pick(L('Emergency', 'Emergencia', 'आपातकाल'), lang) : t('watchFor', lang))}</span>`;
  return `<span class="cc-chip cc-chip-ok">${esc(pick(L('Clear in your document', 'Claro en su documento', 'दस्तावेज़ में साफ़ लिखा'), lang))}</span>`;
}
function sourceLine(item) {
  const lang = state.prefs.lang, p = item.provenance || {};
  const where = p.page ? `${t('page', lang)} ${p.page}${p.lines ? ` · ${pick(L('lines', 'líneas', 'पंक्ति'), lang)} ${p.lines[0]}${p.lines[1] !== p.lines[0] ? '–' + p.lines[1] : ''}` : ''}` : pick(L('page not available', 'página no disponible', 'पृष्ठ उपलब्ध नहीं'), lang);
  const method = { 'pdfjs-text-layer': 'PDF text', 'legacy-pdf-parser': 'basic PDF parser', 'ocr-tesseract': 'OCR', 'synthetic-demo': 'synthetic example', 'plain-text': 'text' }[p.method] || p.method || '';
  return `${esc(t('fromDocument', lang))} · ${esc(where)}${method ? ` · ${esc(method)}` : ''}`;
}
function card(item, { slots = null, done = null } = {}) {
  const lang = state.prefs.lang, mode = state.itemMode.get(item.id) || state.prefs.mode;
  const r = renderItem(item, lang, mode);
  const ai = state.ai.get(`${item.id}|${lang}|${mode}`);
  const id = esc(item.id);
  const canAI = item.provenance?.text && item.provenance.text.length <= 1200 && !r.blocked && item.clarity !== 'unreadable';
  const steps = r.steps?.length ? `<ol class="cc-steps">${r.steps.map(s => `<li>${txHtml(s)}</li>`).join('')}</ol>` : '';
  const slotHtml = slots ? `<div class="cc-slots">${slots.map((s, i) => `<div class="cc-slot"><button type="button" class="cc-check ${s.takenByPatient ? 'is-on' : ''}" data-dose="${esc(s.key)}" aria-pressed="${s.takenByPatient}">${s.takenByPatient ? '✓ ' : ''}${esc(t('markTaken', lang))} <span class="cc-muted">(${i + 1}/${slots.length})</span></button><label class="cc-time">${esc(pick(L('Reminder (your choice)', 'Recordatorio (su elección)', 'रिमाइंडर (आपकी पसंद)'), lang))} <input type="time" data-reminder="${id}" data-slot="${i}" value="${esc(s.userTime || '')}"></label></div>`).join('')}<p class="cc-note">${esc(pick(L('Taken/not taken is only what you mark here. ClearCare never assumes a dose was taken.', 'Tomado/no tomado es solo lo que usted marque aquí. ClearCare nunca supone que se tomó una dosis.', 'ली/नहीं ली — सिर्फ़ वही जो आप यहाँ चिह्नित करें। ClearCare कभी नहीं मानता कि खुराक ले ली गई।'), lang))}</p>${item.duration?.value && !item.start ? `<label class="cc-time">${esc(pick(L('Day 1 of this course (if you know it)', 'Día 1 de este tratamiento (si lo sabe)', 'इस कोर्स का पहला दिन (अगर पता हो)'), lang))} <input type="date" data-day1="${id}" value="${esc(state.day1[item.id] || '')}"></label>` : ''}</div>` : '';
  const doneHtml = done !== null ? `<button type="button" class="cc-check ${done ? 'is-on' : ''}" data-task-done="${id}" aria-pressed="${done}">${done ? '✓ ' : ''}${esc(t('markDone', lang))}</button>` : '';
  const aiHtml = ai ? aiBlock(ai) : '';
  return `<article class="cc-card ${item.clarity !== 'clear' || item.highRisk ? 'cc-card-review' : ''} ${state.speakingId === item.id ? 'is-speaking' : ''}" data-item="${id}">
    <header class="cc-card-head"><h3>${esc(title(item))}</h3>${chip(item)}</header>
    ${txHtml(r.text, { tag: 'p', cls: 'cc-explain' })}${steps}
    <p class="cc-label">${esc(t('rulesLabel', lang))}${r.untranslated ? ' · ' + esc(pick(L('', 'texto original en inglés', 'मूल पाठ अंग्रेज़ी में'), lang)) : ''}</p>
    ${aiHtml}${slotHtml}${doneHtml}
    <details class="cc-source" ${state.understood.has('open:' + item.id) ? 'open' : ''}><summary>${esc(t('showOriginal', lang))}</summary><p class="cc-source-meta">${sourceLine(item)}</p><blockquote lang="en">${esc(item.provenance?.text || item.text || '')}</blockquote></details>
    <div class="cc-actions" role="group" aria-label="${esc(pick(L('Understanding controls', 'Controles de comprensión', 'समझने के विकल्प'), lang))}">
      <button type="button" data-act="listen" data-id="${id}">🔊 ${esc(t('listen', lang))}</button>
      ${canAI ? `<button type="button" data-act="ai" data-id="${id}">✦ ${esc(t('explainAI', lang))}</button>` : ''}
      <button type="button" data-act="clarify" data-id="${id}">${esc(t('needClarification', lang))}</button>
      <details class="cc-more"><summary>${esc(pick(L('More help', 'Más ayuda', 'और मदद'), lang))}</summary><div class="cc-actions">
      <button type="button" data-act="understand" data-id="${id}" aria-pressed="${state.understood.has(item.id)}">${state.understood.has(item.id) ? '✓ ' : ''}${esc(t('understand', lang))}</button>
      <button type="button" data-act="again" data-id="${id}">${esc(t('explainAgain', lang))}</button>
      <button type="button" data-act="slower" data-id="${id}">${esc(t('slower', lang))}</button>
      <button type="button" data-act="original" data-id="${id}">${esc(t('showOriginal', lang))}</button></div></details>
    </div></article>`;
}
function title(item) {
  const lang = state.prefs.lang;
  if (item.category === 'note') return pick(L('Instruction (document’s words)', 'Indicación (palabras del documento)', 'निर्देश (दस्तावेज़ के शब्द)'), lang);
  if (item.category === 'medication') return item.name ? `${item.name}${item.strength && item.clarity === 'clear' && !renderItem(item, 'en', 'simple').fallback ? ` · ${item.strength.range ? item.strength.range.join('–') : item.strength.value}${item.strength.unit ? ' ' + item.strength.unit : ''}` : ''}` : pick(L('Medicine (name not clear)', 'Medicamento (nombre no claro)', 'दवा (नाम साफ़ नहीं)'), lang);
  if (item.category === 'appointment') return item.date ? `${pick(L('Follow-up', 'Cita de control', 'फ़ॉलो-अप'), lang)} · ${formatDate(item.date, lang)}` : pick(L('Follow-up visit', 'Cita de control', 'फ़ॉलो-अप मुलाक़ात'), lang);
  if (item.category === 'test') return pick(L('Test', 'Prueba', 'जाँच'), lang);
  return pick({ warning: L('Warning sign', 'Señal de alarma', 'चेतावनी'), contact: L('Who to contact', 'A quién llamar', 'किससे संपर्क करें'), wound: L('Wound care', 'Cuidado de la herida', 'घाव की देखभाल'), activity: L('Activity', 'Actividad', 'गतिविधि'), diet: L('Food and drink', 'Comida y bebida', 'खान-पान'), home: L('At home', 'En casa', 'घर पर'), caution: L('Important caution', 'Precaución importante', 'ज़रूरी सावधानी'), allergy: L('Allergy mentioned', 'Alergia mencionada', 'एलर्जी का ज़िक्र'), mention: L('Mentioned (not an instruction)', 'Mencionado (no es una indicación)', 'ज़िक्र (निर्देश नहीं)') }[item.category] || L(item.category, item.category, item.category), lang);
}
function aiBlock(ai) {
  const lang = state.prefs.lang;
  if (ai.loading) return `<div class="cc-ai" aria-live="polite"><p>${esc(pick(L('Asking Gemini to explain this one instruction…', 'Pidiendo a Gemini que explique esta indicación…', 'Gemini से इस एक निर्देश को समझाने को कहा जा रहा है…'), lang))}</p></div>`;
  if (ai.status === 'verified') return `<div class="cc-ai" aria-live="polite"><p class="cc-label cc-label-ai">${esc(t('aiLabel', lang))}${ai.provider?.mock ? ' · TEST MOCK' : ''} · ${esc(ai.provider?.model || '')}</p><p lang="${LANGS[lang].bcp47}">${esc(ai.explanation)}</p>${ai.steps?.length ? `<ol class="cc-steps">${ai.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}<button type="button" data-act="listen-ai" data-id="${esc(ai.itemId)}">🔊 ${esc(t('listen', lang))}</button></div>`;
  if (ai.status === 'withheld') return `<div class="cc-ai cc-ai-warn" aria-live="polite"><p>${esc(t('withheld', lang))}</p><p class="cc-muted">${esc(pick(L('Checks that failed: ', 'Comprobaciones fallidas: ', 'जो जाँच विफल हुईं: '), lang))}${esc((ai.failures || []).join(', '))}</p></div>`;
  if (ai.status === 'needs_clarification') return `<div class="cc-ai cc-ai-warn" aria-live="polite"><p>${esc(pick(L('This instruction is unclear in your document, so it wasn’t sent to AI. Please ask your care team.', 'Esta indicación no está clara en su documento, así que no se envió a la IA. Pregunte a su equipo.', 'यह निर्देश दस्तावेज़ में साफ़ नहीं है, इसलिए AI को नहीं भेजा गया। कृपया अपनी टीम से पूछें।'), lang))}</p></div>`;
  return `<div class="cc-ai cc-ai-warn" aria-live="polite"><p>${esc(ai.error || pick(L('The AI explanation is unavailable right now. The explanation above comes from ClearCare’s rules, and your original instruction is unchanged.', 'La explicación de IA no está disponible ahora. La explicación de arriba viene de las reglas de ClearCare y su indicación original no cambia.', 'AI स्पष्टीकरण अभी उपलब्ध नहीं है। ऊपर का स्पष्टीकरण ClearCare के नियमों से है, और आपका मूल निर्देश वैसा ही है।'), lang))}</p></div>`;
}

function tabContent(tab) {
  const lang = state.prefs.lang;
  if (tab === 'calendar') return calendarHtml(); // works without discharge papers too
  if (!state.plan) return `<div class="cc-empty"><p>${esc(t('noPlan', lang))}</p><p class="cc-muted">${esc(pick(L('Or try a synthetic sample PDF (fictional patient):', 'O pruebe un PDF de ejemplo sintético (paciente ficticio):', 'या एक नमूना PDF आज़माएँ (काल्पनिक मरीज़):'), lang))}</p><div class="cc-samples">${SAMPLES.map(s => `<button type="button" data-sample="${esc(s.file)}">${esc(s.label)}</button>`).join('')}</div></div>`;
  const today = todayIso();
  const items = state.plan.items;
  const list = arr => (arr.length ? arr.join('') : `<p class="cc-muted">${esc(pick(L('Nothing here.', 'Nada aquí.', 'यहाँ कुछ नहीं है।'), lang))}</p>`);
  const section = (h, arr) => (arr.length ? `<h3 class="cc-h3">${esc(h)}</h3>${arr.join('')}` : '');
  if (tab === 'today' || tab === 'tomorrow') {
    const d = dayFor(tab === 'today' ? today : addDays(today, 1));
    state.lastItemIds = [...d.medications.map(m => m.item.id), ...d.appointments.map(a => a.id), ...d.recovery.map(r => r.item.id), ...d.dontTake.map(m => m.id), ...d.clarify.map(c => c.id)];
    const body = [
      section(t('medicines', lang), d.medications.map(m => card(m.item, { slots: m.slots }))),
      section(t('appointments', lang), d.appointments.map(a => card(a))),
      section(t('recovery', lang), d.recovery.map(r => card(r.item, { done: r.doneByPatient }))),
      section(pick(L('Please remember', 'Recuerde', 'ध्यान रखें'), lang), d.remember.map(r => card(r))),
      section(t('dontTake', lang), d.dontTake.map(m => card(m))),
      section(pick(L('Only when needed', 'Solo cuando lo necesite', 'सिर्फ़ ज़रूरत पड़ने पर'), lang), [...d.asNeeded, ...d.conditional].map(m => card(m))),
      section(t('watchFor', lang), d.watchFor.map(w => card(w))),
      section(pick(L('In your document’s own words', 'Con las palabras de su documento', 'दस्तावेज़ के अपने शब्दों में'), lang), d.notes.map(n => card(n))),
      section(t('clarify', lang), d.clarify.map(c => card(c)))
    ].join('');
    return body || `<p class="cc-muted">${esc(pick(L('Your papers don’t list anything confirmed for this day.', 'Sus papeles no indican nada confirmado para este día.', 'इस दिन के लिए कागज़ों में कुछ पक्का नहीं लिखा है।'), lang))}</p>`;
  }
  if (tab === 'upcoming') { const d = dayFor(today); const appts = items.filter(i => (i.category === 'appointment' || i.category === 'test') && i.clarity === 'clear' && i.date >= today).sort((a, b) => a.date.localeCompare(b.date)); return list([...appts.map(a => card(a)), ...d.notYetStarted.map(m => card(m))]); }
  if (tab === 'medicines') return list(items.filter(i => i.category === 'medication').map(i => card(i)));
  if (tab === 'appointments') return list(items.filter(i => i.category === 'appointment' || i.category === 'test').map(i => card(i)));
  if (tab === 'recovery') return list(items.filter(i => ['activity', 'wound', 'home', 'diet', 'contact', 'warning'].includes(i.category)).map(i => card(i)));
  if (tab === 'clarify') return list(items.filter(i => i.clarity !== 'clear' || i.highRisk).map(i => card(i))) + questionsBlock();
  return list(items.map(i => card(i)));
}
function questionsBlock() {
  const lang = state.prefs.lang;
  if (!state.questions.length) return '';
  return `<div class="cc-questions"><h3 class="cc-h3">${esc(pick(L('Questions for my care team', 'Preguntas para mi equipo de atención', 'मेरी देखभाल टीम के लिए सवाल'), lang))}</h3><ul>${state.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul><button type="button" data-act="copy-questions">${esc(pick(L('Copy questions', 'Copiar preguntas', 'सवाल कॉपी करें'), lang))}</button> <button type="button" data-act="clear-questions">${esc(pick(L('Clear list', 'Borrar lista', 'सूची साफ़ करें'), lang))}</button></div>`;
}

const SAMPLES = [{ file: '01_everyday_recovery.pdf', label: 'Everyday recovery' }, { file: '03_conflicting_warfarin.pdf', label: 'Conflicting warfarin' }, { file: '05_high_risk_apixaban.pdf', label: 'High-risk apixaban' }, { file: '07_medication_changes.pdf', label: 'Medication changes (stop/hold/taper)' }, { file: '08_two_page_two_column.pdf', label: 'Two pages, two columns' }];

function docStrip() {
  const lang = state.prefs.lang, m = state.docMeta;
  if (!m) return '';
  if (m.error) return `<div class="cc-doc cc-doc-warn" role="status">${esc(m.error)}</div>`;
  const method = { 'pdfjs-text-layer': pick(L('Read from the PDF’s text layer (pdf.js)', 'Leído de la capa de texto del PDF (pdf.js)', 'PDF की टेक्स्ट परत से पढ़ा गया (pdf.js)'), lang), 'legacy-pdf-parser': pick(L('Read with the basic built-in parser', 'Leído con el analizador básico', 'बुनियादी पार्सर से पढ़ा गया'), lang), 'ocr-tesseract': pick(L('Read by OCR on this computer — check every number', 'Leído con OCR en este equipo: revise cada número', 'इस कंप्यूटर पर OCR से पढ़ा गया — हर अंक जाँचें'), lang), 'synthetic-demo': pick(L('Synthetic example text', 'Texto de ejemplo sintético', 'नमूना पाठ'), lang) }[m.method] || m.method;
  const s = state.plan?.summary || {};
  const susp = state.plan?.suspicious?.length ? `<p class="cc-doc-warn">${esc(pick(L(`${state.plan.suspicious.length} line(s) looked like instructions to software rather than care instructions and were ignored.`, `${state.plan.suspicious.length} línea(s) parecían órdenes para software y se ignoraron.`, `${state.plan.suspicious.length} पंक्ति(याँ) सॉफ़्टवेयर के लिए निर्देश जैसी लगीं और छोड़ दी गईं।`), lang))}</p>` : '';
  const noText = m.status === 'no-text' || m.status === 'partial';
  return `<div class="cc-doc" role="status"><strong>${esc(m.filename || '')}</strong> · ${esc(method)}${m.pageCount ? ` · ${m.pageCount} ${esc(pick(L('page(s)', 'página(s)', 'पृष्ठ'), lang))}` : ''} · ${esc(pick(L(`${s.needsClarification || 0} to clarify`, `${s.needsClarification || 0} por aclarar`, `${s.needsClarification || 0} स्पष्ट करने हैं`), lang))}${(m.warnings || []).map(w => `<p class="cc-muted">${esc(w)}</p>`).join('')}${susp}${noText ? `<button type="button" data-act="ocr">${esc(pick(L('Try reading the scan on this computer (local OCR)', 'Intentar leer el escaneo en este equipo (OCR local)', 'इस कंप्यूटर पर स्कैन पढ़ने की कोशिश करें (लोकल OCR)'), lang))}</button>` : ''}</div>`;
}

function render() {
  const view = $('#cc-today'); if (!view) return;
  const lang = state.prefs.lang;
  const { day } = currentBriefing();
  const now = new Date();
  const gemini = state.status?.gemini;
  view.lang = LANGS[lang].bcp47;
  view.innerHTML = `
  <header class="cc-head">
    <div><div class="eyebrow">${esc(new Intl.DateTimeFormat(LANGS[lang].locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(now).toUpperCase())}</div>
    <h1>${esc(briefing[0]?.text.replace(/[.।]$/, '') || '')}</h1><p class="cc-sub">${esc(pick(L('Your daily check-in from your discharge papers.', 'Su repaso diario a partir de sus papeles de alta.', 'आपके डिस्चार्ज के कागज़ों से रोज़ की जानकारी।'), lang))}</p></div>
    <div class="cc-controls">
      <div class="cc-seg" role="radiogroup" aria-label="Language / Idioma / भाषा">${Object.values(LANGS).map(l => `<button type="button" role="radio" aria-checked="${l.code === lang && !xl()}" data-lang="${l.code}" lang="${l.bcp47}">${esc(l.label)}</button>`).join('')}</div>
      <select class="cc-xlang" data-xlang aria-label="More languages (AI translation)"><option value="">🌐 ${esc(pick(L('More languages…', 'Más idiomas…', 'और भाषाएँ…'), lang))}</option>${Object.values(EXTRA_LANGS).map(x => `<option value="${x.code}" ${xl() === x.code ? 'selected' : ''}>${esc(`${x.native} · ${x.name}`)}</option>`).join('')}</select>
      <div class="cc-seg" role="radiogroup" aria-label="${esc(pick(L('Explanation style', 'Estilo de explicación', 'समझाने का तरीका'), lang))}">${['simple', 'detailed', 'steps'].map(m => `<button type="button" role="radio" aria-checked="${state.prefs.mode === m}" data-mode="${m}">${esc(t(m, lang))}</button>`).join('')}</div>
      <span class="cc-gemini ${gemini?.configured ? 'is-on' : ''}" title="${esc(gemini ? `${gemini.provider} · ${gemini.model}` : '')}">Gemini AI: ${esc(gemini ? (gemini.configured ? (gemini.mock ? 'test mock' : pick(L('ready', 'listo', 'तैयार'), lang)) : pick(L('not set up on this computer', 'no configurada en este equipo', 'इस कंप्यूटर पर सेट नहीं'), lang)) : '…')}</span>
    </div>
  </header>
  ${docStrip()}
  <section class="cc-brief panel" aria-labelledby="cc-brief-h">
    <div class="cc-brief-top"><h2 id="cc-brief-h">${esc(pick(L('Your day, in plain words', 'Su día, en palabras sencillas', 'आपका दिन, आसान शब्दों में'), lang))}</h2>
      <div class="cc-player" role="group" aria-label="${esc(pick(L('Voice controls', 'Controles de voz', 'आवाज़ नियंत्रण'), lang))}">
        <button type="button" class="cc-hear" data-act="hear">▶ ${esc(t('hearMyDay', lang))}</button>
        <button type="button" data-act="pause">${esc(player.state === 'paused' ? t('resume', lang) : t('pause', lang))}</button>
        <button type="button" data-act="stop">■ ${esc(t('stop', lang))}</button>
      </div></div>
    <p class="cc-voice-status" id="cc-voice-status" role="status">${esc(state.voiceMsg || '')}</p>${xl() ? `<p class="cc-x-note">🌐 ${esc(`${EXTRA_LANGS[xl()].native}: AI translation by Gemini. Medicine names, doses and numbers are locked and checked; a line that fails the check stays in English (EN).`)}<span id="cc-x-status">${esc(state.xmsg)}</span></p>` : ''}
    <ol class="cc-transcript" aria-label="${esc(pick(L('Transcript', 'Transcripción', 'लिखित रूप'), lang))}">${briefing.map((s, i) => `<li data-seg="${i}" class="${state.speakingSeg === i ? 'is-speaking' : ''}">${txHtml(s.text)} <button type="button" class="cc-mini" data-replay="${i}" aria-label="${esc(t('replay', lang))}: ${i + 1}">↻</button></li>`).join('')}</ol>
  </section>
  `;
  const askHost = $('#home-agent-slot'); if (askHost) askHost.innerHTML = askPanelHtml();
  void day;
}
function askPanelHtml() {
  const lang = state.prefs.lang;
  return `<section class="cc-ask panel" aria-labelledby="cc-ask-h">
    <h2 id="cc-ask-h">${esc(pick(L('Ask about your document', 'Pregunta sobre su documento', 'अपने दस्तावेज़ के बारे में पूछें'), lang))}</h2>
    <form class="cc-ask-form" data-form="ask"><label class="cc-sr" for="cc-q">${esc(t('ask', lang))}</label><input id="cc-q" name="q" maxlength="500" autocomplete="off" value="${esc(state.questionDraft)}" placeholder="${esc(t('askPlaceholder', lang))}" lang="${LANGS[lang].bcp47}">
      <button type="button" data-act="mic" class="cc-mic ${recognizer.listening ? 'is-on' : ''}" aria-pressed="${recognizer.listening}" ${recognizer.available ? '' : 'disabled'} title="${esc(recognizer.available ? t('speakQuestion', lang) : pick(L('Voice questions need Chrome or Edge', 'Las preguntas por voz requieren Chrome o Edge', 'बोलकर पूछने के लिए Chrome या Edge चाहिए'), lang))}">🎤 <span class="cc-sr">${esc(t('speakQuestion', lang))}</span></button>
      <button type="button" data-act="agent" class="cc-agent-btn" title="${esc(pick(L('The Care Agent checks your papers, then sends only relevant evidence to Gemini for a grounded answer.', 'El Agente revisa sus documentos y envía a Gemini solo la evidencia necesaria para responder.', 'केयर एजेंट आपके कागज़ जाँचता है और जवाब के लिए Gemini को सिर्फ़ ज़रूरी जानकारी भेजता है।'), lang))}">🤖 ${esc(pick(L('Ask the Care Agent', 'Preguntar al Agente', 'केयर एजेंट से पूछें'), lang))}</button></form>
    ${recognizer.listening ? `<p class="cc-listening" role="status">● ${esc(t('listening', lang))} — ${esc(state.questionDraft || pick(L('Start speaking; your words will appear above.', 'Empiece a hablar; sus palabras aparecerán arriba.', 'बोलना शुरू करें; आपके शब्द ऊपर दिखेंगे।'), lang))}</p>` : state.questionStatus ? `<p class="cc-question-status" role="status">${esc(state.questionStatus)}</p>` : ''}
    <div class="cc-answer" aria-live="polite">${answerHtml()}</div>${agentHtml()}
  </section>`;
}
function answerHtml() {
  const a = state.answer, lang = state.prefs.lang;
  if (!a) return '';
  const label = a.source === 'ai' ? `${t('aiLabel', lang)}${a.mock ? ' · TEST MOCK' : ''}` : a.source === 'ai-fallback' ? pick(L('From your document (AI answer not available or not verified)', 'De su documento (respuesta de IA no disponible o no verificada)', 'आपके दस्तावेज़ से (AI जवाब उपलब्ध नहीं या जाँच में पास नहीं)'), lang) : t('rulesLabel', lang);
  return `<p class="cc-q-echo">“${esc(a.question)}”</p><p>${xl() ? txHtml(a.text) : `<span lang="${LANGS[a.lang || lang].bcp47}">${esc(a.text).replace(/\n/g, '<br>')}</span>`}</p><p class="cc-label">${esc(label)}</p>${a.offerLang ? `<button type="button" data-lang="${a.offerLang}">${esc(pick(L('Answer in ', 'Responder en ', 'जवाब दें: '), lang) + LANGS[a.offerLang].label)}</button>` : ''}<button type="button" data-act="listen-answer">🔊 ${esc(t('listen', lang))}</button>${(a.items || []).slice(0, 4).map(i => `<details class="cc-source"><summary>${esc(t('showOriginal', lang))}: ${esc(title(i))}</summary><p class="cc-source-meta">${sourceLine(i)}</p><blockquote lang="en">${esc(i.provenance?.text || i.text || '')}</blockquote></details>`).join('')}`;
}
function settingsHtml() {
  const lang = state.prefs.lang, p = state.prefs;
  const notif = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  return `<section class="cc-settings panel" aria-labelledby="cc-set-h"><h2 id="cc-set-h">${esc(pick(L('Your preferences and privacy', 'Sus preferencias y privacidad', 'आपकी पसंद और निजता'), lang))}</h2>
    <label class="cc-toggle"><input type="checkbox" data-pref="autoRead" ${p.autoRead ? 'checked' : ''}> ${esc(pick(L('Read my day aloud when I open Today (if the browser allows)', 'Leer mi día en voz alta al abrir Hoy (si el navegador lo permite)', 'आज खोलने पर मेरा दिन पढ़कर सुनाएँ (अगर ब्राउज़र अनुमति दे)'), lang))}</label>
    <label class="cc-toggle"><input type="checkbox" data-pref="preferLocalVoices" ${p.preferLocalVoices ? 'checked' : ''}> ${esc(pick(L('Prefer voices installed on this device. If your language has none (often Hindi or Spanish), an online voice is used, which may send the text to the browser maker.', 'Preferir voces instaladas en este equipo. Si su idioma no tiene ninguna, se usa una voz en línea, que puede enviar el texto al fabricante del navegador.', 'इस डिवाइस पर इंस्टॉल आवाज़ों को प्राथमिकता दें। अगर आपकी भाषा की कोई आवाज़ नहीं है (अक्सर हिंदी), तो ऑनलाइन आवाज़ इस्तेमाल होगी, जो टेक्स्ट ब्राउज़र कंपनी को भेज सकती है।'), lang))}</label>
    <label class="cc-toggle"><input type="checkbox" data-pref="rememberPlan" ${p.rememberPlan ? 'checked' : ''}> ${esc(pick(L('Remember my care plan on this device (stored in this browser only)', 'Recordar mi plan en este equipo (solo en este navegador)', 'मेरी देखभाल योजना इस डिवाइस पर याद रखें (सिर्फ़ इस ब्राउज़र में)'), lang))}</label>
    <label class="cc-toggle"><input type="checkbox" data-pref="inAppReminders" ${p.inAppReminders ? 'checked' : ''}> ${esc(pick(L('Gentle in-app reminders at the times I chose (only while this page is open)', 'Recordatorios suaves a las horas elegidas (solo con esta página abierta)', 'मेरे चुने समय पर हल्के रिमाइंडर (सिर्फ़ जब यह पेज खुला हो)'), lang))}</label>
    ${p.inAppReminders && notif === 'default' ? `<button type="button" data-act="notif">${esc(pick(L('Also show browser notifications', 'Mostrar también notificaciones del navegador', 'ब्राउज़र नोटिफ़िकेशन भी दिखाएँ'), lang))}</button>` : ''}
    <div class="cc-row"><button type="button" data-act="ics">${esc(pick(L('Download my reminder times (.ics)', 'Descargar mis recordatorios (.ics)', 'मेरे रिमाइंडर डाउनलोड करें (.ics)'), lang))}</button><button type="button" data-act="print">${esc(pick(L('Print a copy for a caregiver', 'Imprimir una copia para un cuidador', 'देखभाल करने वाले के लिए प्रिंट करें'), lang))}</button><button type="button" data-act="export">${esc(pick(L('Export my data', 'Exportar mis datos', 'मेरा डेटा निर्यात करें'), lang))}</button><button type="button" data-act="delete" class="cc-danger">${esc(pick(L('Delete my data from this browser', 'Borrar mis datos de este navegador', 'इस ब्राउज़र से मेरा डेटा मिटाएँ'), lang))}</button></div>
    <p class="cc-muted">${esc(pick(L('Reminders: in-app reminders work only while ClearCare is open. The .ics file lets your own calendar app remind you. Background or phone notifications are not provided.', 'Recordatorios: los del programa solo funcionan con ClearCare abierto. El archivo .ics permite que su propio calendario le avise. No hay notificaciones en segundo plano ni del teléfono.', 'रिमाइंडर: ऐप के रिमाइंडर सिर्फ़ तब काम करते हैं जब ClearCare खुला हो। .ics फ़ाइल से आपका अपना कैलेंडर याद दिलाएगा। बैकग्राउंड या फ़ोन नोटिफ़िकेशन नहीं हैं।'), lang))}</p>
  </section>`;
}

// ---------------- voice ----------------
function voiceStatus(msg) { state.voiceMsg = msg || ''; const el = $('#cc-voice-status'); if (el) el.textContent = state.voiceMsg; }
player.on(e => {
  if (e.type === 'segment') { state.speakingSeg = state.playingBriefing ? e.index : null; $$('.cc-transcript li').forEach((li, i) => li.classList.toggle('is-speaking', i === state.speakingSeg)); }
  if (e.type === 'done' || e.type === 'stopped') { state.speakingSeg = null; $$('.cc-transcript li').forEach(li => li.classList.remove('is-speaking')); }
});
async function speak(segments, { auto = false } = {}) {
  const lang = state.prefs.lang, code = xl();
  state.playingBriefing = segments === briefing;
  await synth.ready;
  // In a translated language, wait for the translations; a line that could not be verified is read in English.
  if (code) { voiceStatus('Preparing the translation…'); await ensureTx(segments.map(s => s.text)); segments = segments.map(s => { const x = tx(s.text); return x.code ? { ...s, text: x.text } : { ...s, lang: 'en' }; }); }
  const r = await player.play(segments, { lang: code || lang, rate: state.prefs.rate, preferLocal: state.prefs.preferLocalVoices });
  if (r.started) voiceStatus(`${pick(L('Speaking with', 'Hablando con', 'आवाज़:'), lang)} ${r.voice}${r.local ? '' : ' (online)'}`);
  else if (r.reason === 'no-voice' || r.reason === 'no-speech-api') voiceStatus(t('noVoice', lang) + (state.prefs.preferLocalVoices && synth.voicesFor(lang).length ? ' ' + pick(L('An online voice is available — untick “Use only voices installed on this device” to use it.', 'Hay una voz en línea disponible: desmarque “Usar solo voces instaladas” para usarla.', 'एक ऑनलाइन आवाज़ उपलब्ध है — इसे इस्तेमाल करने के लिए “सिर्फ़ इंस्टॉल आवाज़ें” का निशान हटाएँ।'), lang) : ''));
  else if (r.blocked) voiceStatus(auto ? t('autoplayBlocked', lang) : pick(L('The browser did not start speaking. Please try again.', 'El navegador no empezó a hablar. Inténtelo de nuevo.', 'ब्राउज़र ने बोलना शुरू नहीं किया। फिर से कोशिश करें।'), lang));
  return r;
}

// ---------------- actions ----------------
const itemById = id => state.plan?.items.find(i => i.id === id);
async function explainWithAI(item) {
  const lang = state.prefs.lang, mode = state.itemMode.get(item.id) || state.prefs.mode, key = `${item.id}|${lang}|${mode}`;
  state.ai.set(key, { loading: true }); render();
  try {
    const res = await fetch('/api/v2/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: item.provenance.text, language: lang, mode }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) state.ai.set(key, { status: 'error', error: data.code === 'not_configured' ? pick(L('AI explanation isn’t set up on this computer (no Gemini key). The explanation above comes from ClearCare’s rules.', 'La explicación con IA no está configurada en este equipo (sin clave de Gemini). La explicación de arriba viene de las reglas de ClearCare.', 'इस कंप्यूटर पर AI स्पष्टीकरण सेट नहीं है (Gemini key नहीं)। ऊपर का स्पष्टीकरण ClearCare के नियमों से है।'), lang) : data.error });
    else state.ai.set(key, { ...data, itemId: item.id });
  } catch { state.ai.set(key, { status: 'error' }); }
  render();
}
async function ask(question) {
  const lang = state.prefs.lang;
  const local = answerLocally(question, { plan: state.plan, day: state.plan ? dayFor(todayIso()) : null, lang, mode: state.prefs.mode, lastItemIds: state.lastItemIds, focusItemId: state.focusItemId });
  const c = classify(question);
  const offerLang = !local.switchTo && c.detected.lang !== local.lang && c.detected.script === 'latin' && c.detected.lang === 'hi' ? 'hi' : null;
  if (local.switchTo && local.action === 'set-language') { state.prefs.lang = local.switchTo; savePrefs(); }
  if (local.action === 'slower') { state.prefs.rate = Math.max(0.6, +(state.prefs.rate - 0.15).toFixed(2)); savePrefs(); }
  if (local.mode && ['simpler', 'detailed', 'steps'].includes(local.intent) && local.items?.[0]) state.itemMode.set(local.items[0].id, local.mode);
  if (local.items?.[0]) state.focusItemId = local.items[0].id;
  if (local.needsAI) {
    state.answer = { question, text: '…', lang: local.lang, source: 'rules', items: local.items }; render();
    try {
      const res = await fetch('/api/v2/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, language: local.lang, snippets: local.items.map(i => ({ id: i.id, text: i.provenance.text.slice(0, 1200) })) }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === 'verified') state.answer = { question, text: data.answer, lang: local.lang, source: 'ai', mock: data.provider?.mock, items: local.items.filter(i => data.sources?.some(s => s.id === i.id)) };
      else if (res.ok && (data.status === 'not_found' || data.status === 'refused')) state.answer = { question, text: data.answer, lang: local.lang, source: 'ai', items: [] };
      else state.answer = { question, text: pick(L('Here is what your document says that may relate to your question:', 'Esto es lo que dice su documento que puede estar relacionado:', 'आपके सवाल से जुड़ा आपके दस्तावेज़ में यह लिखा है:'), local.lang) + ' ' + local.fallback, lang: local.lang, source: 'ai-fallback', items: local.items };
    } catch { state.answer = { question, text: local.fallback, lang: local.lang, source: 'ai-fallback', items: local.items }; }
  } else state.answer = { question, text: local.answer, lang: local.lang, source: 'rules', items: local.items, offerLang };
  if (local.action === 'brief-today') { state.tab = 'today'; }
  if (local.action === 'brief-tomorrow') { state.tab = 'tomorrow'; }
  render();
  if (local.intent === 'repeat' || local.intent === 'slower' || local.intent === 'simpler' || local.action === 'brief-today') {
    if (local.action === 'brief-today') speak(briefing); else speak([{ id: 'answer', text: state.answer.text }]);
  }
}
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })); const a = Object.assign(document.createElement('a'), { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function toast(msg, ms = 5000) { const r = $('#toast-region'); if (!r) return; const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; el.addEventListener('click', () => el.remove()); r.append(el); setTimeout(() => el.remove(), ms); }

function onClick(e) {
  const b = e.target.closest('button'); if (!b || (!$('#cc-today')?.contains(b) && !$('#home-agent-slot')?.contains(b))) return;
  const lang = state.prefs.lang;
  if (b.dataset.lang) { state.voiceMsg = ''; state.prefs.xlang = null; state.prefs.lang = b.dataset.lang; savePrefs(); player.stop(true); if (state.answer?.offerLang) state.answer = null; return render(); }
  if (b.dataset.mode) { state.prefs.mode = b.dataset.mode; state.itemMode.clear(); savePrefs(); return render(); }
  if (b.dataset.tab) { state.tab = b.dataset.tab; render(); return $(`[data-tab="${b.dataset.tab}"]`)?.focus(); }
  if (b.dataset.sample) return loadSample(b.dataset.sample);
  if (b.dataset.replay != null) { const i = Number(b.dataset.replay); return speak([briefing[i]]); }
  if (b.dataset.dose) { state.done.has(b.dataset.dose) ? state.done.delete(b.dataset.dose) : state.done.add(b.dataset.dose); store.set(KEYS.done, [...state.done].slice(-500)); return render(); }
  if (b.dataset.taskDone) { const k = `${b.dataset.taskDone}:${todayIso()}`; state.done.has(k) ? state.done.delete(k) : state.done.add(k); store.set(KEYS.done, [...state.done].slice(-500)); return render(); }
  if (b.dataset.calDay) { state.calSel = b.dataset.calDay; if (b.dataset.calDay.slice(0, 7) !== (state.calMonth || todayIso().slice(0, 7))) state.calMonth = b.dataset.calDay.slice(0, 7); render(); return $(`[data-cal-day="${b.dataset.calDay}"]`)?.focus(); }
  if (b.dataset.calNav != null) { const n = Number(b.dataset.calNav), cur = `${state.calMonth || todayIso().slice(0, 7)}-15`; if (n === 0) { state.calMonth = todayIso().slice(0, 7); state.calSel = todayIso(); } else state.calMonth = addDays(cur, n * 30).slice(0, 7); render(); return $(`[data-cal-nav="${n}"]`)?.focus(); }
  const act = b.dataset.act, item = b.dataset.id ? itemById(b.dataset.id) : null;
  const visit = b.dataset.visit ? state.visits.find(v => v.id === b.dataset.visit) : null;
  if (act === 'visit-add') { state.calForm = true; state.calEdit = null; render(); return $('.cc-visit-form input[name="who"]')?.focus(); }
  if (act === 'visit-edit' && visit) { state.calForm = true; state.calEdit = visit.id; render(); return $('.cc-visit-form input[name="title"]')?.focus(); }
  if (act === 'visit-cancel') { state.calForm = false; state.calEdit = null; return render(); }
  if (act === 'visit-del' && visit) { if (!confirm(pick(L(`Delete “${visitTitle(visit)}”?`, `¿Borrar “${visitTitle(visit)}”?`, `“${visitTitle(visit)}” हटाएँ?`), lang))) return; state.visits = state.visits.filter(v => v.id !== visit.id); saveVisits(); return render(); }
  if (act === 'visit-speak' && visit) return speak([{ id: `visit-${visit.id}`, text: `${relDay(visit.date, lang)}, ${formatDate(visit.date, lang)}: ${visitSentence(visit, lang)}` }]);
  if (act === 'visit-ics' && visit) { download(`clearcare-visit-${visit.date}.ics`, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ClearCare//Family visits//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...visitEventLines([visitToIcs(visit)]), 'END:VCALENDAR'].join('\r\n'), 'text/calendar;charset=utf-8'); return toast(pick(L('Calendar file saved to your Downloads. Open it to add the visit to your calendar.', 'Archivo guardado en Descargas. Ábralo para agregar la cita a su calendario.', 'कैलेंडर फ़ाइल डाउनलोड में सेव हुई। मुलाक़ात जोड़ने के लिए इसे खोलें।'), lang)); }
  if (act === 'agent') { const q = $('#cc-q')?.value.trim(); if (!q) { toast(pick(L('Type a question first, for example: What do I have tomorrow?', 'Escriba primero una pregunta, por ejemplo: ¿Qué tengo mañana?', 'पहले सवाल लिखें, जैसे: कल मुझे क्या करना है?'), lang)); return $('#cc-q')?.focus(); } return askAgent(q); }
  if (act === 'agent-listen' && state.agent?.answer) return speak([{ id: 'agent', text: state.agent.answer }]);
  if (act === 'hear') return speak(briefing);
  if (act === 'pause') { if (player.state === 'paused') player.resume(); else player.pause(); b.textContent = player.state === 'paused' ? t('resume', lang) : t('pause', lang); return; }
  if (act === 'stop') return player.stop();
  if (act === 'listen' && item) { state.speakingId = item.id; return speak([{ id: item.id, text: renderItem(item, lang, state.itemMode.get(item.id) || state.prefs.mode).text }]); }
  if (act === 'listen-ai' && item) { const ai = state.ai.get(`${item.id}|${lang}|${state.itemMode.get(item.id) || state.prefs.mode}`); if (ai?.explanation) return speak([{ id: item.id, text: [ai.explanation, ...(ai.steps || [])].join(' ') }]); }
  if (act === 'listen-answer' && state.answer) return speak([{ id: 'answer', text: state.answer.text }]);
  if (act === 'ai' && item) return explainWithAI(item);
  if (act === 'understand' && item) { state.understood.has(item.id) ? state.understood.delete(item.id) : state.understood.add(item.id); store.set(KEYS.understood, [...state.understood].slice(-300)); toast(pick(L('Thank you. You can come back to this any time.', 'Gracias. Puede volver a esto cuando quiera.', 'धन्यवाद। आप कभी भी इसे फिर देख सकते हैं।'), lang)); return render(); }
  if (act === 'again' && item) { const cur = state.itemMode.get(item.id) || state.prefs.mode; const next = { simple: 'steps', steps: 'detailed', detailed: 'simple' }[cur]; state.itemMode.set(item.id, next); render(); return speak([{ id: item.id, text: renderItem(item, lang, next).text + ' ' + (renderItem(item, lang, next).steps || []).join('. ') }]); }
  if (act === 'slower' && item) { state.prefs.rate = Math.max(0.6, +(state.prefs.rate - 0.15).toFixed(2)); savePrefs(); render(); return speak([{ id: item.id, text: renderItem(item, lang, state.itemMode.get(item.id) || state.prefs.mode).text }]); }
  if (act === 'original' && item) { const d = b.closest('.cc-card')?.querySelector('details'); if (d) { d.open = true; d.querySelector('blockquote')?.focus?.(); } return; }
  if (act === 'clarify' && item) { const q = `${pick(L('Please clarify this instruction from my discharge papers', 'Por favor, aclare esta indicación de mis papeles de alta', 'कृपया मेरे डिस्चार्ज के कागज़ के इस निर्देश को स्पष्ट करें'), lang)}: “${item.provenance?.text || item.text}”${item.reasons?.length ? ` — ${item.reasons.map(r => reasonText(r.code, lang)).join(' ')}` : ''}`; if (!state.questions.includes(q)) state.questions.push(q); store.set(KEYS.questions, state.questions); state.tab = 'clarify'; toast(pick(L('Added to “Questions for my care team”.', 'Agregado a “Preguntas para mi equipo”.', '“देखभाल टीम के लिए सवाल” में जोड़ा गया।'), lang)); return render(); }
  if (act === 'copy-questions') { const text = state.questions.join('\n'); navigator.clipboard?.writeText(text).then(() => toast(pick(L('Questions copied.', 'Preguntas copiadas.', 'सवाल कॉपी हो गए।'), lang))).catch(() => toast(text)); return; }
  if (act === 'clear-questions') { state.questions = []; store.set(KEYS.questions, []); return render(); }
  if (act === 'mic') return toggleMic();
  if (act === 'ocr') return runOcr();
  if (act === 'notif') { Notification.requestPermission().then(render); return; }
  if (act === 'ics') return exportIcs();
  if (act === 'print') return window.print();
  if (act === 'export') return download('clearcare-my-data.json', JSON.stringify({ exportedAt: new Date().toISOString(), note: 'ClearCare data stored in this browser. Contains health information — keep it private.', preferences: state.prefs, reminders: state.reminders, patientMarked: [...state.done], understood: [...state.understood], questions: state.questions, doctorVisits: state.visits, plan: state.plan }, null, 2), 'application/json');
  if (act === 'delete') { if (!confirm(pick(L('Delete ClearCare data saved in this browser (preferences, reminders, saved plan, questions, doctor visits)?', '¿Borrar los datos de ClearCare guardados en este navegador?', 'इस ब्राउज़र में सेव ClearCare डेटा मिटाएँ?'), lang))) return; Object.values(KEYS).forEach(k => store.del(k)); try { sessionStorage.removeItem('clearcare-reviewed-items'); } catch { /* ignore */ } state.reminders = {}; state.done = new Set(); state.understood = new Set(); state.questions = []; state.day1 = {}; state.visits = []; state.plan = null; state.docMeta = null; state.answer = null; state.prefs = { ...state.prefs, rememberPlan: false, autoRead: false, inAppReminders: false }; savePrefs(); toast(pick(L('Your ClearCare data was deleted from this browser.', 'Sus datos de ClearCare se borraron de este navegador.', 'आपका ClearCare डेटा इस ब्राउज़र से मिटा दिया गया।'), lang)); return render(); }
}
function onChange(e) {
  const el = e.target; if (!$('#cc-today')?.contains(el)) return;
  if (el.dataset.xlang !== undefined) { state.voiceMsg = ''; state.prefs.xlang = el.value || null; if (el.value) state.prefs.lang = 'en'; savePrefs(); player.stop(true); return render(); }
  if (el.dataset.pref) {
    const k = el.dataset.pref; state.prefs[k] = el.type === 'checkbox' ? el.checked : Number(el.value); savePrefs();
    if (k === 'rememberPlan') { if (el.checked && state.plan) store.set(KEYS.plan, state.plan); if (!el.checked) store.del(KEYS.plan); }
    if (k === 'rate') return;
    return render();
  }
  if (el.dataset.reminder) { const arr = state.reminders[el.dataset.reminder] || []; arr[Number(el.dataset.slot)] = el.value || null; state.reminders[el.dataset.reminder] = arr; store.set(KEYS.reminders, state.reminders); return render(); }
  if (el.dataset.day1) { state.day1[el.dataset.day1] = el.value; store.set(KEYS.day1, state.day1); }
}
function exportIcs() {
  const lang = state.prefs.lang;
  const entries = (state.plan?.items || []).filter(i => i.schedulable && i.clarity === 'clear' && !renderItem(i, 'en', 'simple').fallback).map(i => ({ item: i, times: (state.reminders[i.id] || []).filter(Boolean), startDate: i.start?.date || state.day1[i.id] || null, startSource: i.start?.date ? 'document' : state.day1[i.id] ? 'patient' : null }));
  const visits = [...state.visits.map(visitToIcs), ...docVisits().map(docVisitToIcs)];
  const { ics, count } = buildReminderIcs(entries, { visits });
  if (!count) return toast(pick(L('Nothing to add yet. Add a doctor visit in the Calendar tab, or choose reminder times for a clear medicine.', 'Aún no hay nada que agregar. Agregue una cita en la pestaña Calendario o elija horas de recordatorio para un medicamento claro.', 'अभी जोड़ने को कुछ नहीं है। कैलेंडर टैब में डॉक्टर की मुलाक़ात जोड़ें, या किसी साफ़ दवा के लिए रिमाइंडर का समय चुनें।'), lang));
  download('clearcare-calendar.ics', ics, 'text/calendar;charset=utf-8');
  toast(pick(L(`${count} item(s) saved to a calendar file in your Downloads. Open it to add them to your calendar.`, `${count} elemento(s) guardados en un archivo de calendario en Descargas. Ábralo para agregarlos.`, `${count} चीज़ें कैलेंडर फ़ाइल में डाउनलोड में सेव हुईं। उन्हें जोड़ने के लिए फ़ाइल खोलें।`), lang));
}
function toggleMic() {
  const lang = state.prefs.lang;
  if (recognizer.listening) { recognizer.stop(); return render(); }
  let consent = false; try { consent = sessionStorage.getItem('clearcare-mic-ok') === '1'; } catch { /* ignore */ }
  if (!consent && !confirm(pick(L('Your browser will listen through the microphone only until you stop speaking. In Chrome and Edge, speech recognition may send the audio to the browser maker to turn it into text. ClearCare does not store audio. Continue?', 'El navegador escuchará por el micrófono solo hasta que deje de hablar. En Chrome y Edge, el reconocimiento de voz puede enviar el audio al fabricante del navegador. ClearCare no guarda audio. ¿Continuar?', 'ब्राउज़र सिर्फ़ तब तक माइक से सुनेगा जब तक आप बोलना बंद न करें। Chrome और Edge में आवाज़ पहचान के लिए ऑडियो ब्राउज़र कंपनी को भेजा जा सकता है। ClearCare ऑडियो सेव नहीं करता। जारी रखें?'), lang))) return;
  try { sessionStorage.setItem('clearcare-mic-ok', '1'); } catch { /* ignore */ }
  player.stop(true);
  state.questionDraft = '';
  state.questionStatus = '';
  recognizer.start({ lang, onText: (txt) => { state.questionDraft = txt; const q = $('#cc-q'); if (q) q.value = txt; }, onEnd: (finalText) => { if (finalText) state.questionDraft = finalText; state.questionStatus = finalText ? pick(L('Review or edit your words above, then choose Ask the Care Agent.', 'Revise o edite lo que dijo arriba y luego elija Preguntar al Agente.', 'ऊपर अपने बोले हुए शब्द देखें या बदलें, फिर केयर एजेंट से पूछें।'), lang) : ''; render(); if (finalText) $('#cc-q')?.focus(); }, onError: (err) => { state.questionStatus = err === 'not-allowed' ? pick(L('Microphone permission was not given.', 'No se dio permiso al micrófono.', 'माइक की अनुमति नहीं मिली।'), lang) : err === 'unsupported' ? pick(L('Voice questions need Chrome or Edge.', 'Las preguntas por voz requieren Chrome o Edge.', 'बोलकर पूछने के लिए Chrome या Edge चाहिए।'), lang) : `${pick(L('Speech recognition error', 'Error de reconocimiento de voz', 'आवाज़ पहचान में त्रुटि'), lang)}: ${err}`; render(); } });
  render();
}
let lastFile = null;
async function runOcr() {
  const lang = state.prefs.lang;
  if (!lastFile) return;
  state.docMeta = { ...state.docMeta, warnings: [...(state.docMeta?.warnings || []), pick(L('Reading the scan with OCR on this computer…', 'Leyendo el escaneo con OCR en este equipo…', 'इस कंप्यूटर पर OCR से स्कैन पढ़ा जा रहा है…'), lang)] }; render();
  try {
    const res = await fetch('/api/v2/ocr', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: lastFile });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'OCR failed.');
    setPlan(data.plan, { method: data.document.method, status: data.document.status, pageCount: data.document.pageCount, warnings: data.document.warnings, filename: lastFile.name });
  } catch (err) { state.docMeta = { ...state.docMeta, error: err.message }; render(); }
}
async function loadSample(name) {
  const res = await fetch(`/samples/${encodeURIComponent(name)}`);
  if (!res.ok) return toast('Sample not available.');
  const file = new File([await res.blob()], name, { type: 'application/pdf' });
  if (window.ClearCareBridge?.loadFile) window.ClearCareBridge.loadFile(file); else planFromBridge({ file });
}

// ---------------- reminders (in-app, page open only) ----------------
// Visit reminders: the user chose them per visit, so they don't depend on the medicine toggle.
setInterval(() => {
  const now = Date.now(), lang = state.prefs.lang;
  for (const v of state.visits) {
    if (!v.time) continue;
    const start = new Date(`${v.date}T${v.time}:00`).getTime();
    for (const m of v.remind || []) {
      const key = `visit:${v.id}:${v.date}:${v.time}:${m}`, at = start - m * 60000;
      if (now < at || now - at > 5 * 60000 || state.firedReminders.has(key)) continue;
      state.firedReminders.add(key);
      const msg = `${pick(L('Reminder', 'Recordatorio', 'रिमाइंडर'), lang)} · ${relDay(v.date, lang)}: ${visitSentence(v, lang)}`;
      toast(msg, 60000);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') try { new Notification('ClearCare', { body: msg }); } catch { /* ignore */ }
      speak([{ id: `visit-reminder-${v.id}`, text: msg }]);
    }
  }
}, 20000);
setInterval(() => {
  if (!state.prefs.inAppReminders || !state.plan) return;
  const now = new Date(), hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, today = todayIso();
  for (const m of dayFor(today).medications) for (const s of m.slots) if (s.userTime === hhmm && !state.firedReminders.has(s.key) && !s.takenByPatient) {
    state.firedReminders.add(s.key);
    const lang = state.prefs.lang, msg = `${pick(L('Gentle reminder (your chosen time)', 'Recordatorio (hora elegida por usted)', 'हल्का रिमाइंडर (आपका चुना समय)'), lang)}: ${renderItem(m.item, lang, 'simple').text}`;
    toast(msg);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') try { new Notification('ClearCare', { body: msg }); } catch { /* ignore */ }
  }
}, 20000);

// ---------------- mount ----------------
function mount() {
  const nav = $('.main-nav');
  if (!nav || $('#cc-nav-today')) return;
  const a = document.createElement('a'); a.href = '#today'; a.id = 'cc-nav-today'; a.className = 'nav-item'; a.dataset.ccPage = 'today';
  a.innerHTML = `<span class="nav-icon">☀</span>${esc(t('today', state.prefs.lang))} · ${esc(t('hearMyDay', state.prefs.lang))}`;
  nav.appendChild(a); // after the original items, so their positions are unchanged
  const view = document.createElement('section'); view.id = 'cc-today'; view.className = 'cc-view'; view.hidden = true; view.setAttribute('aria-label', 'Today');
  $('.main-area')?.append(view);
  document.addEventListener('click', e => { if (e.target.closest('.main-nav [data-page], [data-page]')) closeToday(false); }, true);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  const calendarLink = nav.querySelector('[data-page="calendar"]');
  nav.insertBefore(a, calendarLink || nav.querySelector('.settings-nav') || null);
  a.addEventListener('click', e => { e.preventDefault(); state.tab = 'today'; openToday(true); });
  document.addEventListener('input', e => { if (e.target.id === 'cc-q') state.questionDraft = e.target.value; });
  document.addEventListener('submit', e => { if (e.target.dataset.form === 'ask') { e.preventDefault(); const q = e.target.q.value.trim(); state.questionDraft = e.target.q.value; if (q) askAgent(q); } if (e.target.dataset.form === 'visit') { e.preventDefault(); saveVisitForm(e.target); } });
  if (location.hash === '#today') openToday(false);
}
function openToday(userGesture) {
  const view = $('#cc-today'); if (!view) return;
  window.ClearCareBridge?.openHome?.();
  $$('.main-area > .content').forEach(el => { el.dataset.ccHidden = el.hidden ? 'keep' : '1'; el.hidden = true; });
  view.hidden = false; $$('.nav-item').forEach(n => n.classList.toggle('active', n.id === 'cc-nav-today'));
  const crumb = $('.breadcrumbs strong'); if (crumb) { crumb.dataset.ccOrig ??= crumb.textContent; crumb.textContent = pick(L('Today · Hear my day', 'Hoy · Escucha mi día', 'आज · मेरा दिन सुनें'), state.prefs.lang); }
  history.replaceState(null, '', '#today');
  render(); view.querySelector('h1')?.focus?.();
  window.scrollTo({ top: 0 });
  // Auto-read only with explicit consent AND a real user gesture; otherwise show the button.
  if (state.prefs.autoRead) { if (userGesture) speak(briefing, { auto: true }); else voiceStatus(t('autoplayBlocked', state.prefs.lang)); }
}
function closeToday(restoreContent = true) {
  const view = $('#cc-today'); if (!view || view.hidden) return;
  player.stop(true); recognizer.stop(); view.hidden = true;
  const crumb = $('.breadcrumbs strong'); if (crumb?.dataset.ccOrig) crumb.textContent = crumb.dataset.ccOrig;
  $$('.main-area > .content[data-cc-hidden]').forEach(el => { if (restoreContent && el.dataset.ccHidden === '1') el.hidden = false; delete el.dataset.ccHidden; });
  $('#cc-nav-today')?.classList.remove('active');
}

document.addEventListener('clearcare:document', e => { lastFile = e.detail.file || null; planFromBridge(e.detail); });
document.addEventListener('clearcare:preferences', e => { Object.assign(state.prefs, e.detail || {}); savePrefs(); player.stop(true); if (state.prefs.rememberPlan && state.plan) store.set(KEYS.plan, state.plan); if (!state.prefs.rememberPlan) store.del(KEYS.plan); render(); });
document.addEventListener('clearcare:document-error', async e => {
  lastFile = e.detail.file || null;
  const lang = state.prefs.lang;
  const addButton = (label, fn) => { const actions = $('#modal-actions'); if (!actions) return; const btn = document.createElement('button'); btn.className = 'modal-primary'; btn.textContent = label; btn.onclick = () => { $('#modal-backdrop').hidden = true; fn(); }; actions.prepend(btn); };
  if (!lastFile) return;
  // The original basic parser failed. Try the improved reader (pdf.js) before giving up.
  try {
    const doc = await ingestPdfInBrowser(lastFile);
    if (doc.status !== 'no-text') {
      setPlan(extractInstructions(doc), { method: doc.method, status: doc.status, pageCount: doc.pageCount, warnings: [...doc.warnings, pick(L('The basic reader could not read this PDF; the improved reader could. The Overview page still shows the previous document.', 'El lector básico no pudo leer este PDF; el lector mejorado sí. La página Resumen sigue mostrando el documento anterior.', 'बुनियादी रीडर यह PDF नहीं पढ़ सका; बेहतर रीडर ने पढ़ लिया। ओवरव्यू पेज पर अभी पिछला दस्तावेज़ है।'), lang)], filename: lastFile.name });
      addButton(pick(L('Open in Today (improved reader could read it)', 'Abrir en Hoy (el lector mejorado pudo leerlo)', 'आज में खोलें (बेहतर रीडर ने पढ़ लिया)'), lang), () => openToday(true));
      return;
    }
    state.plan = null; state.docMeta = { method: doc.method, status: 'no-text', filename: lastFile.name, warnings: doc.warnings };
    addButton(pick(L('Try local OCR in Today view', 'Probar OCR local en Hoy', 'आज वाले पेज में लोकल OCR आज़माएँ'), lang), () => { openToday(true); runOcr(); });
  } catch (err) { state.plan = null; state.docMeta = { error: err.message || e.detail.message, filename: lastFile.name }; }
  render();
});
fetch('/api/v2/status').then(r => r.json()).then(s => { state.status = s; render(); }).catch(() => { state.status = null; });
mount();
if (window.ClearCareBridge?.getDoc && !state.plan) { const d = window.ClearCareBridge.getDoc(); void d; /* The default overview demo is structured demo data, not a document: Today starts empty with sample PDFs. */ }
render();
export const __test = { state, render, ask, setPlan };
