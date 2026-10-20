import test from 'node:test';
import assert from 'node:assert/strict';
import { lock, unlock, verifyTranslation, translateV2, resetTranslateForTests, asciiDigits } from '../lib/ext/translate.js';
import { planFor, runCareAgent, makeTools } from '../lib/ext/agent.js';
import { geminiGenerate, resetTelemetryForTests, geminiQueueStatus } from '../lib/ext/gemini-provider.js';
import { visitEventLines } from '../public/ext/calendar/ics.js';
import { extractInstructions } from '../public/ext/clinical/engine.js';
import { pagesFromPlainText } from '../public/ext/document/layout.js';

const env = { GEMINI_API_KEY: 'test-secret' };
const reply = content => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof content === 'string' ? content : JSON.stringify(content) }] } }], modelVersion: 'gemini-3.8-flash' }), { status: 200 });

test('lock/unlock protects medicine names, doses, times and numbers', () => {
  const l = lock('Take 1 tablet of Paracetamol 500 mg twice a day at 8:00 AM for 5 days. Call 108.');
  assert.deepEqual(l.vals, ['1', 'Paracetamol', '500 mg', '8:00 AM', '5', '108']);
  assert.equal(unlock('[[2]] [[3]] [[1]] [[4]] [[5]] [[6]]', l.vals), 'Paracetamol 500 mg 1 8:00 AM 5 108');
  assert.equal(unlock('[[2]] [[3]]', l.vals), null, 'missing tokens are rejected');
  assert.equal(unlock('[[1]] [[1]] [[2]] [[3]] [[4]] [[5]] [[6]]', l.vals), null, 'duplicated tokens are rejected');
  assert.equal(unlock('[[1]] [[2]] [[3]] [[4]] [[5]] [[7]]', l.vals), null, 'unknown tokens are rejected');
});

test('native digits count as numbers', () => { assert.equal(asciiDigits('১০৮ ௧௦'), '108 10'); });

test('verifyTranslation catches a dropped number, a lost name and a lost negation', () => {
  const src = 'Do not take ibuprofen 400 mg.';
  assert.equal(verifyTranslation(src, 'ibuprofen 400 mg எடுத்துக் கொள்ள வேண்டாம்.', 'Do not take ibuprofen 400 mg.').ok, true);
  assert.ok(verifyTranslation(src, 'ibuprofen mg வேண்டாம்.', 'Do not take ibuprofen mg.').failures.some(f => f.startsWith('number_missing')));
  assert.ok(verifyTranslation(src, 'இபுப்ரோஃபென் 400 mg வேண்டாம்.', 'Do not take ibuprofen 400 mg.').failures.some(f => f.startsWith('name_missing')));
  assert.ok(verifyTranslation(src, 'ibuprofen 400 mg எடுத்துக் கொள்ளுங்கள்.', 'Take ibuprofen 400 mg.').failures.some(f => f.startsWith('back_negation')));
});

test('translateV2 uses one AI request, restores locked values, and withholds lines that fail', async () => {
  resetTranslateForTests();
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls++;
    const items = JSON.parse(JSON.parse(opts.body).contents[0].parts[0].text).items;
    assert.ok(items[0].includes('[[1]]') && !/ibuprofen|400/.test(items[0]), 'names and numbers are not sent as text');
    return reply({ t: ['[[1]] [[2]] எடுக்க வேண்டாம்.', 'காலை வணக்கம்.', 'எடுக்கவும்.'], en: ['Do not take [[1]] [[2]].', 'Good morning.', 'Take it.'] });
  };
  const r = await translateV2({ language: 'ta', texts: ['Do not take ibuprofen 400 mg.', 'Good morning.', 'Take 2 tablets.'] }, { fetchImpl, env });
  assert.equal(calls, 1);
  assert.equal(r.items[0].status, 'verified'); assert.equal(r.items[0].text, 'ibuprofen 400 mg எடுக்க வேண்டாம்.');
  assert.equal(r.items[1].status, 'verified');
  assert.equal(r.items[2].status, 'unverified', 'the dropped [[1]] token makes this line fall back to English');
  const again = await translateV2({ language: 'ta', texts: ['Good morning.'] }, { fetchImpl, env });
  assert.equal(calls, 1, 'cached lines cost no request'); assert.equal(again.items[0].status, 'verified');
  await assert.rejects(translateV2({ language: 'xx', texts: ['Hi'] }, { fetchImpl, env }), e => e.status === 400);
});

const plan = extractInstructions(pagesFromPlainText(['Medications:', 'Stop aspirin until reviewed by your doctor.', 'Amoxicillin 500 mg three times daily for 5 days.', 'When to seek help:', 'Call 108 right away for chest pain.'].join('\n')));
const items = plan.items;
const idOf = name => items.find(i => i.name === name).id;
const visits = [{ id: 'v1', who: 'Riya', title: 'Child specialist check-up', doctor: 'Dr. Mehta', date: '2026-10-18', time: '10:30', place: 'City Clinic' }];

test('the planner explains each tool choice', () => {
  const steps = planFor('Should I stop aspirin before Riya’s visit tomorrow?', '2026-10-17');
  assert.deepEqual(steps.map(s => s.tool), ['day_schedule', 'upcoming_visits', 'search_document', 'safety_flags']);
  assert.equal(steps[0].args.date, '2026-10-18');
  assert.ok(steps.every(s => s.thought.length > 20));
  const tools = makeTools({ items, visits: [{ ...visits[0], id: 'visit:v1' }], today: '2026-10-17' });
  assert.equal(tools.safety_flags().stopOrHold[0].id, idOf('aspirin'));
  assert.equal(tools.upcoming_visits({ days: 7 }).visits[0].id, 'visit:v1');
});

test('Care Agent: one AI call, grounded and verified answer with a trace', async () => {
  resetTelemetryForTests();
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply({ reasoning: ['The papers say stop aspirin; visit:v1 is tomorrow at 10:30.'], answer: 'Stop aspirin until your doctor reviews it. Riya’s check-up with Dr. Mehta is tomorrow at 10:30.', sources: [idOf('aspirin'), 'visit:v1', 'day_schedule'], confidence: 'high' }); };
  const r = await runCareAgent({ question: 'Should I stop aspirin, and what is tomorrow?', language: 'en', today: '2026-10-17', items, visits }, { fetchImpl, env });
  assert.equal(calls, 1);
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.sources.map(s => s.id), [idOf('aspirin'), 'visit:v1']);
  assert.ok(r.trace.length >= 3 && r.checks.every(c => c.ok));
});

test('Care Agent withholds invented doses, lost negations and made-up sources', async () => {
  const run = final => runCareAgent({ question: 'What about aspirin?', language: 'en', today: '2026-10-17', items, visits }, { fetchImpl: async () => reply(final), env });
  assert.equal((await run({ answer: 'Take aspirin 75 mg daily.', sources: [idOf('aspirin')], confidence: 'high' })).status, 'withheld');
  assert.equal((await run({ answer: 'Keep taking aspirin as usual.', sources: [idOf('aspirin')], confidence: 'high' })).status, 'withheld');
  const ghost = await run({ answer: 'Stop aspirin.', sources: ['m99'], confidence: 'high' });
  assert.equal(ghost.status, 'withheld'); assert.ok(ghost.failures.some(f => f.startsWith('ungrounded')));
});

test('Care Agent still answers from its tools when the AI is busy', async () => {
  const r = await runCareAgent({ question: 'What do I have tomorrow?', language: 'en', today: '2026-10-17', items, visits }, { fetchImpl: async () => new Response('{}', { status: 429 }), env, retries: 0 });
  assert.equal(r.status, 'tools_only');
  assert.ok(r.sources.some(s => s.id === 'visit:v1'));
});

test('requests are spaced when a per-minute limit is configured', async () => {
  resetTelemetryForTests();
  const spaced = { ...env, GEMINI_MIN_INTERVAL_MS: '150' };
  const times = [];
  const fetchImpl = async () => { times.push(Date.now()); return reply('ok'); };
  await Promise.all([geminiGenerate({ system: 's', user: 'u', fetchImpl, env: spaced }), geminiGenerate({ system: 's', user: 'u', fetchImpl, env: spaced })]);
  assert.ok(times[1] - times[0] >= 140, `second call waited ${times[1] - times[0]} ms`);
  assert.equal(geminiQueueStatus(spaced).intervalMs, 150);
  resetTelemetryForTests();
});

test('calendar visits export with reminders, and untimed visits are all-day', () => {
  const lines = visitEventLines([{ uid: 'a', title: 'Riya, check-up', date: '2026-10-21', time: '10:30', location: 'City Clinic', alarms: [1440, 60] }, { uid: 'b', title: 'Vaccine', date: '2026-11-02' }]);
  assert.ok(lines.includes('DTSTART:20261021T103000') && lines.includes('TRIGGER:-PT1440M') && lines.includes('SUMMARY:Riya\\, check-up'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261102'));
});

test('Calendar Agent puts dated appointments and prescriptions on the calendar, flagging what is unclear', async () => {
  const { syncCalendarFromPlan, medsOn } = await import('../public/ext/calendar/agent-sync.js');
  const p = extractInstructions(pagesFromPlainText(['Medications:', 'Apixaban 5 mg: Take twice daily. Do not stop taking unless instructed by your provider.', 'Stop ibuprofen.', 'Amoxicillin 500 mg three times daily for 5 days starting October 17, 2026.', 'Follow-up:', 'Follow up with your clinician October 19, 2026 at 9:00 AM. Clinic location is not specified.', 'Return to clinic in 2 weeks.'].join('\n')));
  const { entries, log } = syncCalendarFromPlan(p, { today: '2026-10-17', source: 'test.pdf' });
  const visit = entries.find(e => e.kind === 'visit');
  assert.equal(visit.date, '2026-10-19'); assert.equal(visit.time, '09:00'); assert.equal(visit.needsConfirm, true, 'missing place is flagged, not hidden');
  assert.equal(visit.place, '', 'no place is invented');
  const apixaban = entries.find(e => e.title === 'Apixaban');
  assert.equal(apixaban.kind, 'med'); assert.equal(apixaban.needsConfirm, true, 'high-risk medicine is flagged');
  assert.equal(entries.find(e => /ibuprofen/i.test(e.title)).kind, 'stop');
  assert.ok(log.some(l => l.action === 'skipped' && /exact date/.test(l.why)), 'relative dates are skipped with a reason');
  assert.ok(log.every(l => l.why && l.source), 'every decision is explained and quoted');
  assert.ok(medsOn(entries, '2026-10-18').some(m => m.title === 'Apixaban'));
});

test('regressions found while preparing the demo: “No …” restrictions, typographic apostrophes, nothing hidden', () => {
  const q = extractInstructions(pagesFromPlainText(['Care at home', 'No sports or heavy lifting for 2 weeks.', 'No known allergies.', 'Follow-up', 'Follow up with Dr. Mehta at City Children’s Clinic on October 23, 2026 at 10:30 AM.'].join('\n')));
  assert.ok(q.items.some(i => i.category === 'activity' && /No sports/.test(i.provenance.text)), 'restriction starting with “No” is kept');
  const a = q.items.find(i => i.category === 'appointment');
  assert.equal(a.location, 'City Children’s Clinic'); assert.equal(a.clarity, 'clear');
  assert.ok(q.other.some(o => /No known allergies/.test(o.text)), 'uninterpreted lines are kept for display');
});

test('Care Agent evidence includes every instruction the answer names, not only what the AI cited', async () => {
  const fetchImpl = async () => reply({ reasoning: ['Schedule lists amoxicillin; aspirin is stopped.'], answer: 'Take amoxicillin 500 mg three times daily, and stop aspirin until your doctor reviews it.', sources: [idOf('aspirin')], confidence: 'high' });
  const r = await runCareAgent({ question: 'What should I take today?', language: 'en', today: '2026-10-17', items, visits }, { fetchImpl, env });
  assert.equal(r.status, 'verified');
  assert.ok(r.sources.some(s => /Amoxicillin/i.test(s.text)), 'amoxicillin line listed as evidence');
});
