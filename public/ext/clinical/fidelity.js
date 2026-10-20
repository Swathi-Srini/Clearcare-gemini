// SourceGroundingValidator / AIResponseVerifier.
// Independent, deterministic meaning checks of an explanation against its source.
// Used on every Gemini output before display and in tests on every deterministic rendering.
import { GENERICS, BRANDS } from './vocab.js';
import { normalizeLang } from '../i18n.js';

const WORDNUM = {
  en: { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, half: 0.5, once: 1, twice: 2, thrice: 3 },
  es: { cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, catorce: 14, quince: 15, veinte: 20, treinta: 30, media: 0.5, medio: 0.5 },
  hi: { 'शून्य': 0, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'चौदह': 14, 'पंद्रह': 15, 'बीस': 20, 'तीस': 30, 'आधा': 0.5, 'आधी': 0.5 }
};
const IMPLIED = [[/\b(?:once|every day|q\.?d\.?|OD)\b|(?<!twice |times )\bdaily\b/i, 1], [/\b(?:twice|b\.?i\.?d\.?)\b/i, 2], [/\b(?:three times|t\.?i\.?d\.?|thrice)\b/i, 3], [/\b(?:four times|q\.?i\.?d\.?)\b/i, 4], [/\bhalf\b/i, 0.5]];
const DEVA_DIGITS = '०१२३४५६७८९';
const ALL_DRUGS = [...GENERICS, ...Object.keys(BRANDS)];

function toAsciiDigits(s) { return s.replace(/[०-९]/g, d => String(DEVA_DIGITS.indexOf(d))); }
// Normalise clinical shorthand so equivalent forms compare equal (q12h, x5d, 1/2, ½, 1-0-1).
function normaliseShorthand(s) {
  return String(s)
    .replace(/\bq\.?(\d{1,2})\.?h\b/gi, 'every $1 hours')
    .replace(/\bx\s*(\d+)\s*d\b/gi, 'for $1 days')
    .replace(/(?<![\d/])([13])\s*\/\s*([24])(?=\s+(?:tab|tablet|cap|capsule|of))/gi, (_, a, b) => String(Number(a) / Number(b)))
    .replace(/½/g, '0.5')
    .replace(/\b([0-2])\s*-\s*([0-2])\s*-\s*([0-2])\b/g, '');
}
function stripListMarkers(s) { return s.split(/\n/).map(l => l.replace(/^\s*(?:\d{1,2}[.)]|[-•*])\s+/, '')).join('\n'); }

export function numbersIn(text, lang = 'en', { implied = false, words = true } = {}) {
  const s = stripListMarkers(toAsciiDigits(normaliseShorthand(String(text))));
  const out = [];
  for (const m of s.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?![\d])/g)) out.push(Number(m[1].replace(/,/g, '').replace(/^\./, '0.')));
  for (const m of s.matchAll(/(\d+):(\d{2})/g)) { /* times already captured as two numbers */ void m; }
  const lower = s.toLowerCase();
  if (!words) return out;
  for (const [w, v] of Object.entries(WORDNUM[normalizeLang(lang)])) { const rx = lang === 'hi' ? new RegExp(`(?:^|[\\s,(“"])${w}(?=$|[\\s,।.)”"])`, 'g') : new RegExp(`\\b${w}\\b`, 'g'); const c = (lower.match(rx) || []).length; for (let i = 0; i < c; i++) out.push(v); }
  // Articles ("un/una", "एक") count as 1 only in quantity contexts.
  if (lang === 'es') for (const _ of lower.matchAll(/(?:^|[\s(“"])(?:un|una|uno)\s+(?:vez|tableta|cápsula|gota|inhalación|sobre|parche|cucharada|cucharadita|inyección|día|hora|semana|mes)\b/g)) out.push(1);
  if (lang === 'hi') for (const _ of s.matchAll(/(?:^|[\s(“"])एक\s+(?:बार|गोली|कैप्सूल|बूँद|पफ़|पाउच|पैच|इंजेक्शन|दिन|घंटे|हफ़्ते|महीने|छोटा|बड़ा)/g)) out.push(1);
  if (implied) for (const [rx, v] of IMPLIED) if (rx.test(s)) out.push(v);
  return out;
}

const UNIT_FORMS = {
  mg: { en: /\bmg\b|milligrams?/i, es: /\bmg\b|miligramos?/i, hi: /\bmg\b|मिलीग्राम|मि\.ग्रा/i },
  mcg: { en: /\bmcg\b|micrograms?|µg|μg/i, es: /\bmcg\b|microgramos?|µg|μg/i, hi: /\bmcg\b|माइक्रोग्राम|µg/i },
  mL: { en: /\bml\b|milliliters?|millilitres?/i, es: /\bml\b|mililitros?/i, hi: /\bml\b|मिलीलीटर|मि\.ली/i },
  g: { en: /\bg\b|grams?/i, es: /\bg\b|gramos?/i, hi: /\bg\b|ग्राम/i },
  units: { en: /\bunits?\b|\bIU\b/i, es: /\bunidad(?:es)?\b|\bUI\b|\bunits?\b/i, hi: /यूनिट|इकाई|\bunits?\b/i }
};
const SRC_UNIT = { mg: /\b\d[\d.,]*\s*mg\b/i, mcg: /\b\d[\d.,]*\s*(?:mcg|µg|μg)\b/i, mL: /\b\d[\d.,]*\s*ml\b/i, g: /\b\d[\d.,]*\s*g\b/i, units: /\b\d[\d.,]*\s*(?:units?|IU)\b/i };
const NEG_SRC = /\b(?:do not|don't|never|avoid|stop|discontinue[d]?|cease|no longer|hold|held|withhold|withheld|pause|skip|not|without|unless)\b/i;
const NEG_OUT = { en: /\b(?:not|never|avoid|stop|don't|no longer|hold off|without)\b|n't\b/i, es: /\b(?:no|nunca|evite|deje de|suspend\w*|sin|ni)\b/i, hi: /(?:^|\s)(?:न|ना|नहीं|मत)(?=$|[\s,।.])|बंद|बिना/ };
const NEG_DIRECTIVE_OUT = { en: /\b(?:do not|don't|never)\s+(?:take|use)\b|\bstop taking\b/i, es: /\bno\s+(?:tome|use)\b|\bdeje de tomar\b/i, hi: /(?:न|मत)\s+लें|लेना बंद/ };
const EMERG_SRC = /\b(?:911|108|112|emergency|ambulance|immediately|right away|ER)\b/i;
const EMERG_OUT = { en: /emergency|911|108|112|right away|immediately|urgent/i, es: /urgencia|emergencia|911|108|112|inmediato|de inmediato/i, hi: /आपात|इमरजेंसी|तुरंत|108|112|911/ };
const FREQ_OUT = {
  1: { en: /\bonce\b|\bone time\b|\b1 time\b|\bdaily\b|\bevery day\b|\ba day\b/i, es: /una vez|1 vez|cada día|diari/i, hi: /एक बार|1 बार|रोज़|रोज|हर दिन|प्रतिदिन/ },
  2: { en: /\btwice\b|\btwo times\b|\b2 times\b|every 12 hours/i, es: /dos veces|2 veces|cada 12 horas/i, hi: /दो बार|2 बार|हर 12 घंटे/ },
  3: { en: /three times|3 times|every 8 hours/i, es: /tres veces|3 veces|cada 8 horas/i, hi: /तीन बार|3 बार|हर 8 घंटे/ },
  4: { en: /four times|4 times|every 6 hours/i, es: /cuatro veces|4 veces|cada 6 horas/i, hi: /चार बार|4 बार|हर 6 घंटे/ }
};

const UNIT_KIND = [
  [/^(?:mg|milligrams?|miligramos?|मिलीग्राम)$/i, 'mg'], [/^(?:mcg|µg|μg|micrograms?|microgramos?|माइक्रोग्राम)$/i, 'mcg'], [/^(?:g|grams?|gramos?|ग्राम)$/i, 'g'], [/^(?:ml|milliliters?|millilitres?|mililitros?|मिलीलीटर)$/i, 'ml'], [/^(?:units?|iu|unidades?|यूनिट)$/i, 'units'],
  [/^(?:days?|d|días?|दिन)$/i, 'day'], [/^(?:weeks?|wks?|semanas?|हफ़्ते|हफ्ते|सप्ताह)$/i, 'week'], [/^(?:months?|mes|meses|महीने)$/i, 'month'], [/^(?:hours?|hrs?|horas?|घंटे|घंटा)$/i, 'hour'], [/^(?:minutes?|mins?|minutos?|मिनट)$/i, 'minute'],
  [/^(?:tablets?|tabs?|tabletas?|गोलियाँ|गोली|गोलियां)$/i, 'tablet'], [/^(?:capsules?|cápsulas?|कैप्सूल)$/i, 'capsule'], [/^(?:puffs?|inhalaciones|inhalación|पफ़)$/i, 'puff'], [/^(?:pounds?|lbs?|libras?|पाउंड)$/i, 'lb'], [/^(?:kg|kilograms?|kilos?|किलो)$/i, 'kg']
];
const PAIR_WORDS = { one: 1, two: 2, three: 3, four: 4, half: 0.5, una: 1, un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, media: 0.5, medio: 0.5, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'आधी': 0.5, 'आधा': 0.5 };
export function pairsIn(text, lang = 'en') {
  let s = toAsciiDigits(normaliseShorthand(String(text))).replace(/(\d{1,3}),(?=\d{3}\b)/g, '$1');
  s = s.replace(/(^|[\s(“"])(one|two|three|four|half(?: an?)?|una|un|uno|dos|tres|cuatro|media|medio|एक|दो|तीन|चार|आधी|आधा)\s+(?=(?:tablets?|tabs?|capsules?|puffs?|tabletas?|cápsulas?|inhalaci\w+|गोली|गोलियाँ|कैप्सूल|पफ़)\b|(?:गोली|गोलियाँ|कैप्सूल|पफ़))/gi, (_, pre, w) => `${pre}${PAIR_WORDS[w.toLowerCase().replace(/ an?$/, '')]} `);
  const out = [];
  for (const m of s.matchAll(/(?<![\w.])(\d+(?:\.\d+)?|\.\d+)\s*([A-Za-zÁÉÍÓÚáéíóúñµμ\u0900-\u097F]+)/g)) {
    const kind = UNIT_KIND.find(([rx]) => rx.test(m[2]))?.[1];
    if (kind) out.push(`${Number(m[1].replace(/^\./, '0.'))}|${kind}`);
  }
  return out;
}
function multiset(arr) { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return m; }

export function verifyExplanation({ sourceText, item = null, explanation, lang = 'en', allowExtraNumbers = [], partial = false, repeats = false }) {
  lang = normalizeLang(lang);
  const failures = [];
  const out = String(explanation || '').trim();
  const src = String(sourceText || '');
  if (!out) return { ok: false, failures: [{ code: 'empty', detail: 'No explanation text.' }] };
  if (out.length > 1500) failures.push({ code: 'too_long', detail: 'Explanation is too long.' });
  if (/<[a-z/!]|https?:\/\/|www\./i.test(out)) failures.push({ code: 'unsafe_content', detail: 'Explanation contains markup or links.' });
  // Script / language.
  // Medicine names, units and abbreviations legitimately stay in Latin script; ignore them here.
  const nameRx = new RegExp(`\\b(?:${[...ALL_DRUGS, item?.name, item?.generic].filter(Boolean).map(n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const forLang = out.replace(nameRx, ' ').replace(/\b(?:mg|mcg|ml|mL|g|IU|units?|BID|TID|QID|PRN|PO|OD|HS|INR|AM|PM)\b/g, ' ');
  const deva = (forLang.match(/[\u0900-\u097F]/g) || []).length, latin = (forLang.match(/[A-Za-zÁÉÍÓÚÑáéíóúñü]/g) || []).length;
  if (lang === 'hi' && deva < Math.max(4, latin * 0.5)) failures.push({ code: 'wrong_language', detail: 'Expected mostly Hindi (Devanagari).' });
  if (lang !== 'hi' && deva > 0) failures.push({ code: 'wrong_language', detail: 'Unexpected Devanagari text.' });
  if (lang === 'es' && !/[áéíóúñ¿¡]|\b(?:el|la|los|las|de|del|al|que|tome|su|sus|una|por|con|para|día|días|cuando|lo|se|en|si|más|y|es|tiene|necesite|descanse|camine|llame|mantenga|lleve|pida|siga|deje)\b/i.test(out)) failures.push({ code: 'wrong_language', detail: 'Expected Spanish.' });
  // Numbers: every source number must survive; no new numbers.
  const srcNums = numbersIn(src, 'en', { implied: true });
  const outNums = numbersIn(out, lang);
  const srcSet = new Set([...srcNums, ...allowExtraNumbers]);
  const outSet = new Set(outNums);
  const digitNums = new Set(numbersIn(normaliseShorthand(src).replace(/\b[a-z]+\b/gi, w => (/^(?:one|two|three|four|five|six|seven|eight|nine|ten|half)$/i.test(w) ? w : '')), 'en'));
  if (!partial) for (const v of digitNums) if (!outSet.has(v)) failures.push({ code: 'number_missing', detail: `Number ${v} from the document is missing.` });
  for (const v of outSet) if (!srcSet.has(v)) failures.push({ code: 'number_added', detail: `Number ${v} does not appear in the document.` });
  // Number+unit pairs must match exactly (catches 5 days → 5 weeks, 12.5 mg → 12.5 g, duplicated numbers).
  if (!partial) {
    const a = multiset(pairsIn(src, 'en')), b = multiset(pairsIn(out, lang));
    for (const [k, n] of a) if ((b.get(k) || 0) < n) failures.push({ code: 'pair_missing', detail: `${k.replace('|', ' ')} is missing.` });
    for (const [k, n] of b) if ((repeats ? (a.has(k) ? Infinity : 0) : (a.get(k) || 0)) < n && !(k.endsWith('|day') && /every other day|días alternos|हर दूसरे दिन/.test(out))) failures.push({ code: 'pair_added', detail: `${k.replace('|', ' ')} is not in the document.` });
    const srcCount = numbersIn(src, 'en', { words: false }).length, outCount = numbersIn(out, lang, { words: false }).length;
    if (!repeats && outCount > srcCount + 1) failures.push({ code: 'number_repeated', detail: 'The explanation repeats or adds numbers.' });
  } else {
    const a = new Set(pairsIn(src, 'en'));
    for (const k of pairsIn(out, lang)) if (!a.has(k)) failures.push({ code: 'pair_added', detail: `${k.replace('|', ' ')} is not in the document.` });
  }
  // Units.
  for (const [u, rx] of Object.entries(SRC_UNIT)) {
    if (!partial && rx.test(src) && !UNIT_FORMS[u][lang].test(out)) failures.push({ code: 'unit_missing', detail: `Unit ${u} is missing.` });
    if (!rx.test(src) && UNIT_FORMS[u][lang].test(out) && !(u === 'g' && /\bmg\b|\bmcg\b/i.test(out))) { if (u !== 'units' || /\d\s*(?:units?|unidades|यूनिट)/i.test(out)) failures.push({ code: 'unit_added', detail: `Unit ${u} is not in the document.` }); }
  }
  // Medicine names: must keep the document's names; must not add others.
  const srcLower = src.toLowerCase();
  const names = item?.name ? [item.name] : ALL_DRUGS.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(src));
  if (!partial) for (const n of names) if (!out.toLowerCase().includes(n.toLowerCase()) && !(item?.generic && out.toLowerCase().includes(item.generic))) failures.push({ code: 'name_missing', detail: `Medicine name "${n}" is missing.` });
  for (const n of ALL_DRUGS) if (new RegExp(`\\b${n}\\b`, 'i').test(out) && !new RegExp(`\\b${n}\\b`, 'i').test(srcLower) && n !== item?.generic && BRANDS[n] !== item?.generic) failures.push({ code: 'name_added', detail: `Medicine "${n}" is not in the document.` });
  // Negation and stop/hold.
  if (!partial && NEG_SRC.test(src) && !NEG_OUT[lang].test(out)) failures.push({ code: 'negation_lost', detail: 'A "do not / stop" meaning in the document is missing.' });
  if (!NEG_SRC.test(src) && !/\b(?:exceed|max(?:imum)?|no more than|not more than|up to)\b/i.test(src) && NEG_DIRECTIVE_OUT[lang].test(out)) failures.push({ code: 'negation_added', detail: 'The explanation tells the patient not to take something the document does not.' });
  if (item && ['STOP', 'HOLD'].includes(item.status) && !NEG_OUT[lang].test(out)) failures.push({ code: 'status_changed', detail: 'Stop/hold meaning is missing.' });
  // STOP/HOLD: must say stop / do-not-take, and must NOT tell the patient to keep taking it.
  if (item && ['STOP', 'HOLD'].includes(item.status)) {
    const STOP_OUT = { en: /\b(?:stop(?:ping)? taking|stop\b|(?:do not|don't|never|not)\s+take|hold off|pause)/i, es: /\bdeje de tomar|\bno\s+(?:lo |la |los |las )?tome|\bsuspend|\bno tomar/i, hi: /(?:न|मत|नहीं)\s+लें|लेना बंद|बंद कर|न लें/ };
    const KEEP_OUT = { en: /\b(?:keep taking|continue|carry on|do not stop|don't stop|without fail|without stopping)\b/i, es: /\b(?:siga tomando|contin[uú]e|no (?:lo |la )?(?:deje|suspenda|olvide)|sin falta|sin parar)\b/i, hi: /लेते रहें|जारी रखें|बंद न करें|बिना रुके|ज़रूर लें/ };
    const POS_TAKE = { en: /(?<!\b(?:not|never|don't|stop)\s)(?<!\bstop\s)\btake\b(?!\s+more)/i, es: /(?<!\bno\s(?:lo |la )?)\b(?:tome|toma)\b/i, hi: /(?<!(?:न|मत|नहीं)\s)लें/ };
    if (!STOP_OUT[lang].test(out)) failures.push({ code: 'status_changed', detail: 'Stop/hold meaning is missing.' });
    if (KEEP_OUT[lang].test(out)) failures.push({ code: 'status_reversed', detail: 'The explanation tells the patient to keep taking a stopped medicine.' });
    const stripped = out.replace(/(?:do not|don't|never|not|stop)\s+(?:taking|take)\b/gi, '').replace(/\bno\s+(?:lo |la )?tom[ae]\b/gi, '').replace(/deje de tomar/gi, '').replace(/(?:न|मत|नहीं)\s+लें/g, '');
    if (POS_TAKE[lang].test(stripped)) failures.push({ code: 'status_reversed', detail: 'The explanation tells the patient to take a stopped medicine.' });
  }
  // Schedule shape must not change (daily → weekly/monthly/alternate days/weekends).
  const SHAPE = /\bweek|month|every other|alternate|weekend|skip|semana|\bmes\b|alternos|fin de semana|हफ़्त|हफ्त|महीन|दूसरे दिन|सप्ताह/i;
  if (item?.frequency && !SHAPE.test(src) && SHAPE.test(out.replace(/\bfor \d+ weeks?\b|durante \d+ semanas?|\d+ हफ़्ते तक/gi, ''))) failures.push({ code: 'frequency_changed', detail: 'The explanation changes how often (weekly, monthly, alternate days…).' });
  // Food timing must not be reversed.
  const WITH_FOOD = /with (?:meals|food)|after (?:meals|food|eating)|\bPC\b|con (?:las )?comidas?|después de (?:las )?comidas|खाने के (?:साथ|बाद)/i, EMPTY = /empty stomach|without food|before (?:meals|food|breakfast)|ayunas|sin comida|antes de (?:las )?comidas|ख़ाली पेट|खाली पेट|खाने के बिना|खाने से पहले/i;
  if (WITH_FOOD.test(src) && !EMPTY.test(src) && EMPTY.test(out)) failures.push({ code: 'timing_changed', detail: 'Food timing reversed.' });
  if (EMPTY.test(src) && !WITH_FOOD.test(src) && /with (?:meals|food)|con (?:las )?comidas?|खाने के साथ/i.test(out)) failures.push({ code: 'timing_changed', detail: 'Food timing reversed.' });
  // No added conditions, as-needed status, early stopping, extra doses, or "not the case" double negatives.
  if (item?.category === 'medication' && !/\bif\b|\bunless\b|as needed|when needed|prn|sos/i.test(src) && /\bonly if\b|\bif you\b|\bwhen you feel\b|\bsolo si\b|\bsi (?:tiene|siente|se siente)\b|होने पर ही|\bअगर\b|\bजब\b.*\bलगे\b|ठीक लगे/i.test(out)) failures.push({ code: 'condition_added', detail: 'The explanation adds a condition.' });
  if (item?.frequency && !item.frequency.prn && /as needed|when needed|if needed|only when you need|cuando lo necesite|si lo necesita|ज़रूरत पड़ने पर|ज़रूरत हो/i.test(out) && !/as needed|when needed|if needed|prn|sos|necesit|ज़रूरत/i.test(src)) failures.push({ code: 'prn_added', detail: 'The explanation makes a scheduled medicine "as needed".' });
  if (item?.frequency?.prn && /around the clock|even if|regularly|every day without|todos los días|aunque no|हर हाल|चाहे/i.test(out)) failures.push({ code: 'prn_lost', detail: 'An as-needed medicine was made regular.' });
  if (!/\b(?:stop|discontinue|hold|until|when finished)\b/i.test(src) && /\b(?:may|can) stop\b|\bstop (?:when|once|if)\b|puede (?:dejar|suspender)|बंद कर (?:दें|सकते)/i.test(out)) failures.push({ code: 'stop_added', detail: 'The explanation allows stopping early.' });
  if (!/\b(?:extra|additional|another|double|more)\b/i.test(src) && /\b(?:extra|additional|another dose|double)\b|adicional|\bdoble\b|अतिरिक्त|दोगुन|और यूनिट/i.test(out)) failures.push({ code: 'dose_added', detail: 'The explanation adds extra doses.' });
  if (/ऐसा नहीं है|no es así|that'?s not (?:true|the case)|isn'?t the case|not really/i.test(out)) failures.push({ code: 'negation_lost', detail: 'Ambiguous double negative.' });
  // As-needed, route and time of day must survive and must not be contradicted.
  if (!partial && !(item && ['STOP', 'HOLD'].includes(item.status)) && item?.frequency?.prn && !/need|necesit|necesario|ज़रूरत|जरूरत|आवश्यकता|when necessary|as required/i.test(out)) failures.push({ code: 'prn_lost', detail: '"Only when needed" is missing.' });
  const ROUTE_OUT = { subcutaneous: /skin|piel|त्वचा/i, intravenous: /vein|vena|नस/i, intramuscular: /muscle|músculo|मांसपेशी/i, oral: /mouth|boca|मुँह|मुंह|oral/i, sublingual: /tongue|lengua|जीभ/i, inhaled: /inhal|इनहेल/i, topical: /skin|piel|त्वचा/i };
  if (!partial && item?.route && ROUTE_OUT[item.route]) {
    if (['subcutaneous', 'intravenous', 'intramuscular'].includes(item.route) && !ROUTE_OUT[item.route].test(out)) failures.push({ code: 'route_changed', detail: 'How to take it is missing.' });
    for (const [r, rx] of Object.entries(ROUTE_OUT)) if (r !== item.route && !(r === 'topical' && item.route === 'subcutaneous') && !(r === 'subcutaneous' && item.route === 'topical') && ['intravenous', 'intramuscular', 'subcutaneous'].includes(r) && rx.test(out)) failures.push({ code: 'route_changed', detail: `Route "${r}" is not in the document.` });
  }
  const TIME_WORDS = { morning: /morning|mañana|सुबह/i, bedtime: /bed|acost|सोने|night|noche|रात/i, evening: /evening|noche|tarde|शाम/i, afternoon: /afternoon|tarde|दोपहर/i };
  if (!partial && !(item && ['STOP', 'HOLD'].includes(item.status)) && item?.frequency?.timing?.length) {
    for (const k of item.frequency.timing) if (TIME_WORDS[k] && !TIME_WORDS[k].test(out)) failures.push({ code: 'timing_changed', detail: `Time of day "${k}" is missing.` });
    for (const [k, rx] of Object.entries(TIME_WORDS)) if (!item.frequency.timing.includes(k) && rx.test(out) && !rx.test(src) && !(k === 'evening' && item.frequency.timing.includes('bedtime')) && !(k === 'afternoon' && lang === 'es')) failures.push({ code: 'timing_changed', detail: `Time of day "${k}" is not in the document.` });
  }
  // Frequency.
  const stopped = item && ['STOP', 'HOLD'].includes(item.status);
  const tpd = stopped ? null : item?.frequency?.timesPerDay;
  const TIMING_OUT = { en: /bed|evening|morning|night/i, es: /acost|noche|mañana/i, hi: /सोने|शाम|सुबह|रात/ };
  if (!partial && !stopped && item?.frequency?.fromTiming && !TIMING_OUT[lang].test(out)) failures.push({ code: 'frequency_changed', detail: 'Time of day is missing.' });
  if (!partial && tpd && FREQ_OUT[tpd] && !item.frequency.everyHours && !item.frequency.fromTiming && !FREQ_OUT[tpd][lang].test(out)) failures.push({ code: 'frequency_changed', detail: 'How often to take it is missing or changed.' });
  const STRICT_FREQ = { 1: /\bonce\b|\bone time\b|una vez|एक बार|\b1 (?:time|vez|बार)/i, 2: /\btwice\b|two times|\b2 times|dos veces|\b2 veces|दो बार|\b2 बार/i, 3: /three times|\b3 times|tres veces|\b3 veces|तीन बार|\b3 बार/i, 4: /four times|\b4 times|cuatro veces|\b4 veces|चार बार|\b4 बार/i };
  if (tpd && !item.frequency.everyHours) for (const [k, rx] of Object.entries(STRICT_FREQ)) if (Number(k) !== tpd && rx.test(out)) failures.push({ code: 'frequency_changed', detail: 'The explanation gives a different schedule.' });
  // Warning severity must not be downgraded.
  if (!partial && EMERG_SRC.test(src) && !EMERG_OUT[lang].test(out)) failures.push({ code: 'severity_downgraded', detail: 'Emergency wording is missing.' });
  if (EMERG_SRC.test(src) && /\b(?:next week|tomorrow|wait|later|when you can|no rush)\b|la próxima semana|mañana|espere|más tarde|बाद में|अगले हफ़्ते|इंतज़ार|कल/i.test(out) && !/\b(?:next week|tomorrow|wait|later)\b/i.test(src)) failures.push({ code: 'severity_downgraded', detail: 'The explanation delays an emergency action.' });
  // A "do not" in the source must stay attached to the same action (English output).
  if (lang === 'en') for (const m of src.matchAll(/\b(?:do not|don't|never)\s+(lift|drive|take|use|drink|eat|bathe|swim|shower|stop|exceed|crush)\b/gi)) {
    const verb = m[1].toLowerCase();
    if (new RegExp(`\\b${verb}`, 'i').test(out) && !new RegExp(`(?:not|never|don't|avoid|no)\\s+(?:\\w+\\s+){0,2}${verb}|${verb}\\w*\\s+(?:\\w+\\s+){0,3}(?:not|never)\\b`, 'i').test(out)) failures.push({ code: 'negation_lost', detail: `"do not ${verb}" lost its negation.` });
  }
  if (/\b(?:you(?:'| a)re fine|nothing to worry|without worry|no need to (?:call|worry)|it(?:'s| is) (?:safe|normal|not dangerous)|sin preocupaci[oó]n|बिना चिंता|no te preocupes|no se preocupe|चिंता (?:की )?(?:कोई )?(?:बात )?नहीं)\b/i.test(out) && !/\b(?:safe|normal|worry)\b/i.test(src)) failures.push({ code: 'false_reassurance', detail: 'Reassurance that is not in the document.' });
  return { ok: failures.length === 0, failures };
}
