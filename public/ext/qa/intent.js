// Grounded question handling for English, Spanish, Hindi (Devanagari) and romanised Hindi
// ("Hinglish"). Deterministic intents are answered from the plan; open questions retrieve
// at most 3 instructions for Gemini. If nothing matches: "not in your document".
import { renderItemSafe as renderItem, reasonText, formatDate, formatTime } from '../clinical/render.js';
import { GLOSSARY, ABBREVIATIONS } from '../clinical/vocab.js';
import { normalizeLang } from '../i18n.js';
import { safetyGate } from './safety.js';

const L = (en, es, hi) => ({ en, es, hi });
const pick = (o, lang) => o[lang] ?? o.en;

export function detectLanguage(text) {
  const s = String(text);
  if (/[ऀ-ॿ]/.test(s)) return { lang: 'hi', script: 'devanagari' };
  if (/[¿¡ñ]|\b(?:qué|cuándo|cómo|cuánto|medicina|medicamento|pastilla|cita|tengo|debo|hoy|mañana|por qué|dónde|explíque|repita|despacio|español)\b/i.test(s)) return { lang: 'es', script: 'latin' };
  if (/\b(?:kya|kab|kaise|kitna|kitni|kyun|kyon|hai|hain|mein|ne|dawa|dawai|dawaai|goli|batao|bolo|samajh|samjha|nahi|nahin|aaj|dobara|phir|dheere|mujhe|karna|leni|lena|wala|matlab)\b/i.test(s)) return { lang: 'hi', script: 'latin' };
  return { lang: 'en', script: 'latin' };
}

const RX = {
  language: /\b(?:in|en|mein)\s+(hindi|spanish|español|espanol|english|inglés|ingles)\b|(hindi|english|spanish)\s+(?:mein|me)\s+(?:bolo|batao|samjhao)|(हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी|स्पेनिश)\s+में|\bhabla(?:r)?\s+en\s+(español|inglés|hindi)|\b(?:speak|explain|say it)\s+(?:in\s+)?(hindi|spanish|english)\b/i,
  repeat: /\b(?:repeat|again|say that again|dobara|phir se|fir se|ek baar aur|repite|repita|otra vez|de nuevo)\b|दोबारा|फिर से|एक बार और/i,
  simpler: /\b(?:simpler|more simply|simple words|didn'?t understand|did not understand|don'?t understand|samajh nahi|samjha nahi|samjhi nahi|aasaan|asaan|más simple|más fácil|mas simple|no entend[ií]|no lo entiendo)\b|समझ नहीं|आसान|सरल/i,
  slower: /\b(?:slow(?:er|ly)?|dheere|dhire|despacio|más lento)\b|धीरे/i,
  important: /\b(?:tired|only (?:the )?important|just the important|thak gay[ai]|thaka|thaki|cansad[oa]|solo lo importante)\b|थक|सिर्फ़ ज़रूरी|सिर्फ ज़रूरी/i,
  detailed: /\b(?:more detail|in detail|explain more|tell me more|vistaar|vistar se|más detalle|detalladamente)\b|विस्तार/i,
  steps: /\b(?:step by step|one by one|ek ek karke|paso a paso|uno por uno)\b|एक-एक करके|एक एक करके|क्रम से/i,
  original: /\b(?:original|show (?:me )?the source|actually say|what does (?:my |the )?doctor (?:actually )?say|doctor ne (?:kya|kyaa) (?:bola|likha|kaha)|discharge (?:mein|me) kya|qué dice (?:el|mi) (?:médico|documento|doctor)|palabras exactas)\b|डॉक्टर ने क्या|मूल|असली शब्द/i,
  clarify: /\b(?:need clarification|confused|not sure|unclear|which (?:ones?|instructions?) (?:are|is) unclear|doubt|aclaraci[oó]n|no estoy segur[oa]|confus[oa])\b|स्पष्ट|उलझन|शक/i,
  today: /\b(?:today|aaj|hoy|what (?:should|do) i (?:do|need to do)|my day)\b|आज/i,
  tomorrow: /\b(?:tomorrow|kal|mañana)\b|कल/i,
  appointment: /\b(?:follow[- ]?up|appointment|visit|check-?up|clinic visit|doctor se milna|milna|cita|consulta|revisión)\b|अपॉइंटमेंट|फ़ॉलो|फॉलो|मुलाक़ात|मुलाकात|जाँच|जांच/i,
  medicine: /\b(?:medicine|medicines|medication|medications|tablet|tablets|pill|pills|dose|dawa|dawai|dawaai|davai|goli|goliyan|medicina|medicamento|medicamentos|pastilla|pastillas|dosis)\b|दवा|दवाई|गोली|खुराक/i,
  when: /\b(?:when|what time|how often|kab|kitne baje|kitni baar|cuándo|cuando|a qué hora|cada cuánto)\b|कब|कितनी बार|किस समय/i,
  howMuch: /\b(?:how much|how many|kitna|kitni|cuánto|cuanta|cuánta|cuantas|cuántas)\b|कितना|कितनी/i,
  why: /\b(?:why|kyun|kyon|kyu|por qué|porque|para qué)\b|क्यों/i,
  define: /\bwhat (?:does|is) (?:the word |the term )?["“']?([A-Za-z.-]{2,30})["”']?(?: mean)?\??$|\b([A-Za-z.-]{2,30}) (?:ka|ki|ke) (?:matlab|arth)\b|\bqué significa ["“']?([A-Za-záéíóúñ.-]{2,30})|([A-Za-zऀ-ॿ.-]{2,30}) का (?:मतलब|अर्थ)/i
};
const ORD = [[/\b(?:first|pehl[aie]|primer[oa]?)\b|पहल/i, 0], [/\b(?:second|dusr[aie]|doosr[aie]|segund[oa])\b|दूसर/i, 1], [/\b(?:third|tisr[aie]|tercer[oa]?)\b|तीसर/i, 2], [/\b(?:fourth|chauth[aie]|cuart[oa])\b|चौथ/i, 3]];

export function classify(question) {
  const q = String(question || '').trim();
  const detected = detectLanguage(q);
  const out = { intent: 'open', detected, switchTo: null, ordinal: null, term: null, medicineName: null };
  const lm = q.match(RX.language);
  if (lm) { const w = (lm[1] || lm[2] || lm[3] || lm[4] || lm[5] || '').toLowerCase(); out.switchTo = /hind|हिं|हिन/.test(w) ? 'hi' : /span|esp|स्पे/.test(w) ? 'es' : 'en'; }
  for (const [rx, i] of ORD) if (rx.test(q)) { out.ordinal = i; break; }
  const d = q.match(RX.define);
  if (RX.original.test(q)) out.intent = 'original';
  else if (RX.repeat.test(q)) out.intent = 'repeat';
  else if (RX.simpler.test(q)) out.intent = 'simpler';
  else if (RX.slower.test(q)) out.intent = 'slower';
  else if (RX.important.test(q)) out.intent = 'important';
  else if (RX.steps.test(q)) out.intent = 'steps';
  else if (RX.detailed.test(q)) out.intent = 'detailed';
  else if (RX.clarify.test(q)) out.intent = 'clarify';
  else if (/\b(?:can i|could i|should i(?! do (?:today|tomorrow))|may i|is it (?:ok|okay|safe|fine)|what if|what should i do if|how much [\w ]+ if)\b|\bif (?:my |the )?(?:sugar|pain|bp|pressure|fever)\b|\b(?:kya main|kya mai|kar sakta|kar sakti|le sakta|le sakti|puedo|debo|¿puedo)\b|सकता|सकती/i.test(q)) out.intent = 'advice';
  else if (d) { out.intent = 'define'; out.term = (d[1] || d[2] || d[3] || d[4]).replace(/[.?]$/, ''); }
  else if (RX.why.test(q)) out.intent = 'why';
  else if (RX.appointment.test(q)) out.intent = 'appointment';
  else if (RX.medicine.test(q) && RX.howMuch.test(q)) out.intent = 'medicine_dose';
  else if (RX.medicine.test(q) || (RX.when.test(q) && /\b[A-Z][a-z]{4,}\b/.test(q))) out.intent = 'medicine_when';
  else if (RX.tomorrow.test(q)) out.intent = 'tomorrow';
  else if (RX.today.test(q)) out.intent = 'today';
  else if (lm) out.intent = 'language';
  return out;
}

const HINGLISH = { dawa: 'medicine', dawai: 'medicine', dawaai: 'medicine', goli: 'tablet', ghaav: 'wound', ghav: 'incision', chot: 'wound', tanka: 'stitches', tanke: 'stitches', khoon: 'bleeding', bukhar: 'fever', dard: 'pain', chalna: 'walk', khana: 'diet', pani: 'water', 'दवा': 'medicine', 'घाव': 'wound', 'चीरा': 'incision', 'टांके': 'stitches', 'खून': 'bleeding', 'बुखार': 'fever', 'दर्द': 'pain', 'टहलना': 'walk', 'चलना': 'walk', herida: 'incision', sangrado: 'bleeding', fiebre: 'fever', dolor: 'pain', caminar: 'walk', dieta: 'diet' };
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'my', 'i', 'to', 'do', 'what', 'when', 'how', 'can', 'should', 'of', 'for', 'and', 'in', 'on', 'it', 'me', 'about']);
function tokens(s) { return String(s).toLowerCase().split(/[^a-zऀ-ॿáéíóúñ0-9]+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => HINGLISH[w] || w); }

export function retrieve(plan, question, k = 3) {
  const q = new Set(tokens(question));
  const scored = plan.items.map(it => { const text = (it.provenance?.text || it.text || '') + ' ' + (it.name || '') + ' ' + it.category; const tk = tokens(text); let s = 0; for (const w of tk) if (q.has(w)) s += 1; for (const w of q) if (w.length > 4 && text.toLowerCase().includes(w)) s += 0.5; return { it, s }; });
  return scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.it);
}

function findNamed(plan, q) { return plan.items.filter(i => i.category === 'medication' && i.name && new RegExp(`\\b${i.name}\\b`, 'i').test(q)); }
const NOT_FOUND = L('I couldn’t find that in your discharge document. Your care team or pharmacist can answer it.', 'No encontré eso en su documento de alta. Su equipo de atención o su farmacéutico pueden responderlo.', 'यह आपके डिस्चार्ज दस्तावेज़ में नहीं मिला। आपकी देखभाल टीम या फ़ार्मासिस्ट इसका जवाब दे सकते हैं।');

/**
 * Deterministic answer, or { needsAI: true, snippets } for open questions.
 * ctx: { plan, day, lang, mode, focusItemId, lastItemIds }
 */
export function answerLocally(question, ctx) {
  const c = classify(question);
  // Explicit request > clearly Spanish or Devanagari question > saved preference.
  const lang = normalizeLang(c.switchTo || (c.detected.script === 'devanagari' ? 'hi' : c.detected.lang === 'es' ? 'es' : ctx.lang));
  const plan = ctx.plan;
  const base = { intent: c.intent, lang, switchTo: c.switchTo, detected: c.detected.lang, items: [] };
  const safety = safetyGate(question, { plan: ctx.plan, lang });
  if (safety) return { ...base, safety: safety.kind, answer: safety.answer, items: safety.items || [], needsAI: false };
  if (!plan) return { ...base, answer: pick(L('Please add your discharge papers first, then I can answer from them.', 'Primero agregue sus papeles de alta y luego podré responder con ellos.', 'पहले अपने डिस्चार्ज के कागज़ जोड़ें, फिर मैं उन्हीं से जवाब दूँगा।'), lang) };
  const focus = ctx.focusItemId ? plan.items.find(i => i.id === ctx.focusItemId) : null;
  const ordinalItem = c.ordinal != null && ctx.lastItemIds?.[c.ordinal] ? plan.items.find(i => i.id === ctx.lastItemIds[c.ordinal]) : null;
  const target = ordinalItem || focus;
  const ex = (it, mode = ctx.mode || 'simple') => renderItem(it, lang, mode);
  switch (c.intent) {
    case 'language': return { ...base, answer: pick(L('Okay — I’ll explain in English from now on.', 'De acuerdo, a partir de ahora le explico en español.', 'ठीक है — अब से मैं हिंदी में समझाऊँगा।'), lang), action: 'set-language' };
    case 'slower': return { ...base, answer: pick(L('Of course. I’ll speak more slowly.', 'Claro. Hablaré más despacio.', 'ज़रूर। मैं धीरे बोलूँगा।'), lang), action: 'slower' };
    case 'original': { const it = target || null; if (it) return { ...base, items: [it], answer: pick(L(`Here are your document’s own words${it.provenance?.page ? ` (page ${it.provenance.page})` : ''}: “${it.provenance.text}”`, `Estas son las palabras de su documento${it.provenance?.page ? ` (página ${it.provenance.page})` : ''}: “${it.provenance.text}”`, `आपके दस्तावेज़ के अपने शब्द${it.provenance?.page ? ` (पृष्ठ ${it.provenance.page})` : ''}: “${it.provenance.text}”`), lang), showOriginal: true }; return { ...base, items: plan.items.slice(0, 8), answer: pick(L('Here is what your doctor wrote, instruction by instruction. Each card shows the original words.', 'Esto es lo que escribió su médico, indicación por indicación. Cada tarjeta muestra las palabras originales.', 'डॉक्टर ने जो लिखा है, वह हर निर्देश के साथ नीचे है। हर कार्ड में मूल शब्द दिखते हैं।'), lang), showOriginal: true }; }
    case 'repeat': case 'simpler': case 'detailed': case 'steps': { const it = target || plan.items.find(i => i.category === 'medication') || plan.items[0]; if (!it) return { ...base, answer: pick(NOT_FOUND, lang) }; const mode = c.intent === 'simpler' ? 'simple' : c.intent === 'detailed' ? 'detailed' : c.intent === 'steps' ? 'steps' : ctx.mode || 'simple'; const r = ex(it, mode); const prefix = c.intent === 'simpler' ? pick(L('Let me put it more simply. ', 'Se lo digo de forma más sencilla. ', 'आसान शब्दों में कहूँ तो: '), lang) : ''; return { ...base, items: [it], mode, answer: prefix + r.text + (r.steps?.length ? '\n' + r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '') }; }
    case 'important': { const d = ctx.day; const keys = [...(d?.medications || []).map(m => m.item), ...(d?.appointments || []), ...(d?.dontTake || []), ...(d?.watchFor || []).filter(w => w.severity === 'emergency')]; const lines = keys.map(i => ex(i, 'simple').text); if (d?.clarify?.length) lines.push(pick(L(`${d.clarify.length} item(s) still need checking with your care team.`, `${d.clarify.length} indicación(es) aún deben confirmarse con su equipo.`, `${d.clarify.length} बातें अभी भी देखभाल टीम से पक्की करनी हैं।`), lang)); return { ...base, items: keys, mode: 'simple', answer: [pick(L('Just the important things:', 'Solo lo importante:', 'सिर्फ़ ज़रूरी बातें:'), lang), ...(lines.length ? lines : [pick(L('Nothing confirmed is listed for today.', 'No hay nada confirmado para hoy.', 'आज के लिए कुछ भी पक्का नहीं लिखा है।'), lang)])].join(' ') }; }
    case 'clarify': { const items = plan.items.filter(i => i.clarity !== 'clear'); if (!items.length) return { ...base, answer: pick(L('Nothing in your document is flagged as unclear. If something still feels confusing, your care team can explain it.', 'Nada en su documento está marcado como poco claro. Si algo le sigue confundiendo, su equipo puede explicárselo.', 'आपके दस्तावेज़ में कुछ भी अस्पष्ट के रूप में चिह्नित नहीं है। फिर भी कुछ उलझन हो, तो आपकी टीम समझा सकती है।'), lang) }; return { ...base, items, answer: pick(L('These need checking with your care team. You could ask:', 'Esto debe confirmarse con su equipo. Podría preguntar:', 'इन्हें देखभाल टीम से पक्का करना है। आप पूछ सकते हैं:'), lang) + ' ' + items.map(i => `${i.name || i.category}: ${i.reasons.map(r => reasonText(r.code, lang)).join(' ')}`).join(' · ') }; }
    case 'define': { const term = c.term.toLowerCase().replace(/\.$/, ''); const g = GLOSSARY[term]; const ab = ABBREVIATIONS.find(a => a.meaning && a.key.toLowerCase() === term.replace(/\./g, '')); if (g) return { ...base, answer: `${c.term}: ${pick(g, lang)}.` }; if (ab) return { ...base, answer: `${ab.key}: ${pick(ab.meaning, lang)}.` }; return { ...base, answer: pick(L(`“${c.term}” isn’t in ClearCare’s small glossary. Your pharmacist or care team can explain what it means for you.`, `“${c.term}” no está en el pequeño glosario de ClearCare. Su farmacéutico o su equipo pueden explicarle qué significa para usted.`, `“${c.term}” ClearCare की छोटी शब्दावली में नहीं है। आपके फ़ार्मासिस्ट या देखभाल टीम आपको इसका मतलब बता सकते हैं।`), lang) }; }
    case 'why': { const it = target || findNamed(plan, question)[0]; if (it?.frequency?.prnReason) return { ...base, items: [it], answer: pick(L(`Your document says ${it.name} is for ${it.frequency.prnReason}. It doesn’t give any other reason.`, `Su documento dice que ${it.name} es para: “${it.frequency.prnReason}”. No da otra razón.`, `दस्तावेज़ में लिखा है कि ${it.name} “${it.frequency.prnReason}” के लिए है। इसके अलावा कोई कारण नहीं लिखा।`), lang) }; return { ...base, items: it ? [it] : [], answer: pick(L('Your document doesn’t explain why. Your doctor or pharmacist can tell you the reason for your situation.', 'Su documento no explica por qué. Su médico o farmacéutico pueden explicarle la razón en su caso.', 'आपके दस्तावेज़ में इसका कारण नहीं लिखा है। आपके डॉक्टर या फ़ार्मासिस्ट आपकी स्थिति के हिसाब से कारण बता सकते हैं।'), lang) }; }
    case 'advice': {
      const kw = tokens(question).filter(w => w.length > 3 && !['take', 'have', 'should', 'could', 'okay', 'dose', 'medicine', 'what', 'with'].includes(w));
      const hits = plan.items.filter(i => kw.some(w => (i.provenance?.text || i.text || '').toLowerCase().includes(w)) && /\b(?:not|never|avoid|only|if|unless|with|before|after|max|more than)\b/i.test(i.provenance?.text || i.text || ''));
      if (!hits.length) return { ...base, answer: pick(NOT_FOUND, lang), notFound: true };
      return { ...base, items: hits, answer: pick(L('Your document says this about it:', 'Su documento dice esto al respecto:', 'आपके दस्तावेज़ में इस बारे में यह लिखा है:'), lang) + ' ' + hits.map(i => `“${i.provenance?.text || i.text}”`).join(' ') + ' ' + pick(L('For anything else, please ask your care team or pharmacist.', 'Para cualquier otra cosa, pregunte a su equipo o farmacéutico.', 'बाक़ी किसी भी बात के लिए अपनी देखभाल टीम या फ़ार्मासिस्ट से पूछें।'), lang) };
    }
    case 'appointment': { const appts = plan.items.filter(i => i.category === 'appointment' || i.category === 'test'); if (!appts.length) return { ...base, answer: pick(L('Your document doesn’t mention a follow-up appointment.', 'Su documento no menciona una cita de control.', 'आपके दस्तावेज़ में फ़ॉलो-अप अपॉइंटमेंट का ज़िक्र नहीं है।'), lang) }; return { ...base, items: appts, answer: appts.map(a => ex(a).text).join(' ') }; }
    case 'medicine_when': case 'medicine_dose': { const named = findNamed(plan, question); const meds = named.length ? named : plan.items.filter(i => i.category === 'medication'); if (!meds.length) return { ...base, answer: pick(L('Your document doesn’t list any medicines that ClearCare could read.', 'Su documento no incluye medicamentos que ClearCare pudiera leer.', 'आपके दस्तावेज़ में ऐसी कोई दवा नहीं है जिसे ClearCare पढ़ सका।'), lang) }; return { ...base, items: meds, answer: meds.map(m => ex(m).text).join(' ') }; }
    case 'today': case 'tomorrow': { return { ...base, action: c.intent === 'today' ? 'brief-today' : 'brief-tomorrow', answer: pick(c.intent === 'today' ? L('Here’s your day.', 'Este es su día.', 'यह रहा आपका दिन।') : L('Here’s what your papers say for tomorrow.', 'Esto es lo que dicen sus papeles para mañana.', 'कल के लिए आपके कागज़ों में यह लिखा है।'), lang) }; }
    default: {
      const snippets = retrieve(plan, question, 3).filter(i => !plan.suspicious?.some(s => s.text === i.provenance?.text));
      if (!snippets.length) return { ...base, answer: pick(NOT_FOUND, lang), notFound: true };
      return { ...base, needsAI: true, items: snippets, fallback: snippets.map(i => ex(i).text).join(' ') };
    }
  }
}
export { formatDate, formatTime };
