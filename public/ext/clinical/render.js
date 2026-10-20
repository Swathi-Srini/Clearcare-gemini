// ExplanationStrategy (deterministic). Renders the STRUCTURED meaning of an item into
// English, Spanish or Hindi. It never translates free text word by word: free text is either
// matched by a reviewed phrase template (numbers captured and re-inserted) or left in the
// document's own words with a clear label.
import { normalizeLang, LANGS } from '../i18n.js';
import { verifyExplanation } from './fidelity.js';

const L = (en, es, hi) => ({ en, es, hi });
const pick = (o, lang) => o[lang] ?? o.en;
const num = v => (v == null ? '' : String(v));
const UNIT = { mg: 'mg', mcg: 'mcg', g: 'g', mL: 'mL', units: L('units', 'unidades', 'यूनिट'), '%': '%' };
const unitText = (u, lang) => (u ? (typeof UNIT[u] === 'object' ? pick(UNIT[u], lang) : UNIT[u] || u) : '');
export const strengthText = (s, lang) => (s ? `${s.range ? `${s.range[0]} ${pick(L('to', 'a', 'से'), lang)} ${s.range[1]}` : num(s.value)}${s.unit ? ' ' + unitText(s.unit, lang) : ''}` : '');

const FREQ = { 1: L('once a day', 'una vez al día', 'दिन में एक बार'), 2: L('twice a day', 'dos veces al día', 'दिन में दो बार'), 3: L('three times a day', 'tres veces al día', 'दिन में तीन बार'), 4: L('four times a day', 'cuatro veces al día', 'दिन में चार बार') };
const TIMING = { afternoon: L('in the afternoon', 'por la tarde', 'दोपहर में'), beforeMeals: L('before meals', 'antes de las comidas', 'खाने से पहले'), afterMeals: L('after meals', 'después de las comidas', 'खाने के बाद'), withMeals: L('with meals', 'con las comidas', 'खाने के साथ'), beforeBreakfast: L('before breakfast', 'antes del desayuno', 'नाश्ते से पहले'), beforeDinner: L('before dinner', 'antes de la cena', 'रात के खाने से पहले'), bedtime: L('at bedtime', 'al acostarse', 'सोने से पहले'), morning: L('in the morning', 'por la mañana', 'सुबह'), evening: L('in the evening', 'por la noche', 'शाम को'), emptyStomach: L('on an empty stomach', 'en ayunas', 'ख़ाली पेट') };
const ROUTE = { oral: L('by mouth', 'por la boca', 'मुँह से'), subcutaneous: L('as an injection under the skin', 'como inyección bajo la piel', 'त्वचा के नीचे इंजेक्शन से'), inhaled: L('with an inhaler', 'con inhalador', 'इनहेलर से'), topical: L('on the skin', 'sobre la piel', 'त्वचा पर'), sublingual: L('under the tongue', 'debajo de la lengua', 'जीभ के नीचे'), intravenous: L('into a vein', 'en una vena', 'नस में'), intramuscular: L('into a muscle', 'en un músculo', 'मांसपेशी में') };
const REASONS = { pain: L('pain', 'el dolor', 'दर्द'), fever: L('fever', 'la fiebre', 'बुखार'), nausea: L('nausea', 'las náuseas', 'मतली'), sleep: L('sleep', 'dormir', 'नींद'), constipation: L('constipation', 'el estreñimiento', 'कब्ज़'), cough: L('cough', 'la tos', 'खाँसी'), itching: L('itching', 'la picazón', 'खुजली'), anxiety: L('anxiety', 'la ansiedad', 'घबराहट'), 'shortness of breath': L('shortness of breath', 'la falta de aire', 'साँस फूलना') };
const QTY = { tablet: L(['tablet', 'tablets'], ['tableta', 'tabletas'], ['गोली', 'गोलियाँ']), capsule: L(['capsule', 'capsules'], ['cápsula', 'cápsulas'], ['कैप्सूल', 'कैप्सूल']), puff: L(['puff', 'puffs'], ['inhalación', 'inhalaciones'], ['पफ़', 'पफ़']), drop: L(['drop', 'drops'], ['gota', 'gotas'], ['बूँद', 'बूँदें']), sachet: L(['sachet', 'sachets'], ['sobre', 'sobres'], ['पाउच', 'पाउच']), teaspoon: L(['teaspoon', 'teaspoons'], ['cucharadita', 'cucharaditas'], ['छोटा चम्मच', 'छोटे चम्मच']), tablespoon: L(['tablespoon', 'tablespoons'], ['cucharada', 'cucharadas'], ['बड़ा चम्मच', 'बड़े चम्मच']), injection: L(['injection', 'injections'], ['inyección', 'inyecciones'], ['इंजेक्शन', 'इंजेक्शन']), patch: L(['patch', 'patches'], ['parche', 'parches'], ['पैच', 'पैच']) };
const SMALL = { 1: L('one', 'una', 'एक'), 2: L('two', 'dos', 'दो'), 3: L('three', 'tres', 'तीन'), 4: L('four', 'cuatro', 'चार') };

function qtyText(q, lang) {
  if (!q) return '';
  const forms = QTY[q.unit] ? pick(QTY[q.unit], lang) : [q.unit, q.unit];
  if (q.range) return pick(L(`${q.range[0]} to ${q.range[1]} ${forms[1]}`, `${q.range[0]} a ${q.range[1]} ${forms[1]}`, `${q.range[0]} से ${q.range[1]} ${forms[1]}`), lang);
  if (q.fraction && q.fraction !== '1/2') return `${q.fraction} ${forms[0]}`;
  if (q.value === 0.5) return pick(L(`half a ${forms[0]}`, `media ${forms[0]}`, `आधी ${forms[0]}`), lang);
  const word = SMALL[q.value] ? pick(SMALL[q.value], lang) : num(q.value);
  const masculine = lang === 'es' && ['sobre', 'parche'].includes(forms[0]) && q.value === 1 ? 'un' : word;
  return `${masculine} ${q.value === 1 ? forms[0] : forms[1]}`;
}

export function freqText(f, lang) {
  if (!f) return '';
  const parts = [];
  if (f.everyHoursRange) parts.push(pick(L(`every ${f.everyHoursRange[0]} to ${f.everyHoursRange[1]} hours`, `cada ${f.everyHoursRange[0]} a ${f.everyHoursRange[1]} horas`, `हर ${f.everyHoursRange[0]} से ${f.everyHoursRange[1]} घंटे में`), lang));
  else if (f.everyHours) parts.push(pick(L(`every ${f.everyHours} hours`, `cada ${f.everyHours} horas`, `हर ${f.everyHours} घंटे में`), lang));
  else if (f.perMonth === 1) parts.push(pick(L('once a month', 'una vez al mes', 'महीने में एक बार'), lang));
  else if (f.timesPerDay && FREQ[f.timesPerDay] && !(f.fromTiming && f.timing?.length)) parts.push(pick(FREQ[f.timesPerDay], lang));
  else if (f.perWeek === 1) parts.push(pick(L('once a week', 'una vez a la semana', 'हफ़्ते में एक बार'), lang));
  else if (f.everyOtherDay) parts.push(pick(L('every other day', 'en días alternos', 'हर दूसरे दिन'), lang));
  if (f.offset) { const MEAL = { breakfast: L('breakfast', 'del desayuno', 'नाश्ते'), meals: L('meals', 'de las comidas', 'खाने'), food: L('food', 'de comer', 'खाने'), dinner: L('dinner', 'de la cena', 'रात के खाने'), lunch: L('lunch', 'del almuerzo', 'दोपहर के खाने') }[f.offset.meal] || L(f.offset.meal, f.offset.meal, f.offset.meal); const u = f.offset.unit === 'hour' ? L('hours', 'horas', 'घंटे') : L('minutes', 'minutos', 'मिनट'); parts.push(pick(L(`${f.offset.value} ${u.en} ${f.offset.rel} ${MEAL.en}`, `${f.offset.value} ${u.es} ${f.offset.rel === 'before' ? 'antes' : 'después'} ${MEAL.es}`, `${MEAL.hi} से ${f.offset.value} ${u.hi} ${f.offset.rel === 'before' ? 'पहले' : 'बाद'}`), lang)); }
  for (const k of f.timing || []) if (TIMING[k] && !(k === 'bedtime' && f.timesPerDay === 1 && parts.length && /bed|acost|सोने/.test(parts[0]))) parts.push(pick(TIMING[k], lang));
  return parts.join(lang === 'hi' ? ', ' : ' ');
}

function prnText(f, lang) {
  if (!f?.prn) return '';
  const r = f.prnReason ? Object.keys(REASONS).find(k => f.prnReason.toLowerCase().includes(k)) : null;
  if (r) return pick(L(`only when you need it for ${pick(REASONS[r], 'en')}`, `solo cuando lo necesite para ${pick(REASONS[r], 'es')}`, `सिर्फ़ तब जब ${pick(REASONS[r], 'hi')} के लिए ज़रूरत हो`), lang);
  if (f.prnReason) return pick(L(`only when needed (the document says: “${f.prnReason}”)`, `solo cuando lo necesite (el documento dice: “${f.prnReason}”)`, `सिर्फ़ ज़रूरत पड़ने पर (दस्तावेज़ में लिखा है: “${f.prnReason}”)`), lang);
  return pick(L('only when you need it', 'solo cuando lo necesite', 'सिर्फ़ ज़रूरत पड़ने पर'), lang);
}

function durText(d, lang) {
  if (!d?.value) return '';
  const u = d.unit === 'hour' ? L(['hour', 'hours'], ['hora', 'horas'], ['घंटे', 'घंटे']) : d.unit === 'week' ? L(['week', 'weeks'], ['semana', 'semanas'], ['हफ़्ते', 'हफ़्ते']) : d.unit === 'month' ? L(['month', 'months'], ['mes', 'meses'], ['महीने', 'महीने']) : L(['day', 'days'], ['día', 'días'], ['दिन', 'दिन']);
  const f = pick(u, lang)[d.value === 1 ? 0 : 1];
  return pick(L(`for ${d.value} ${f}`, `durante ${d.value} ${f}`, `${d.value} ${f} तक`), lang);
}

export function formatDate(iso, lang) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  try { return new Intl.DateTimeFormat(LANGS[normalizeLang(lang)].locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d); } catch { return iso; }
}
export function formatTime(hhmm, lang) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (lang === 'hi') { const part = h < 5 ? 'रात' : h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात'; return `${part} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} बजे`; }
  if (lang === 'es') return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'de la mañana' : h < 20 ? 'de la tarde' : 'de la noche'}`;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const REASON_TEXT = {
  missing_name: L('The document doesn’t name this medicine.', 'El documento no dice el nombre de este medicamento.', 'दस्तावेज़ में इस दवा का नाम नहीं लिखा है।'),
  unrecognized_medicine: L('ClearCare doesn’t recognise this medicine name. Check it with your pharmacist.', 'ClearCare no reconoce el nombre de este medicamento. Confírmelo con su farmacéutico.', 'ClearCare इस दवा का नाम नहीं पहचानता। अपने फ़ार्मासिस्ट से पक्का करें।'),
  unreadable: L('Part of this could not be read. Nothing has been filled in.', 'Una parte no se pudo leer. No se ha rellenado nada.', 'इसका कुछ हिस्सा पढ़ा नहीं जा सका। अपनी तरफ़ से कुछ नहीं भरा गया है।'),
  conflicting_dose: L('The document gives different doses. Please don’t guess — ask your care team which one is right.', 'El documento da dosis diferentes. No adivine: pregunte a su equipo de atención cuál es la correcta.', 'दस्तावेज़ में अलग-अलग खुराक लिखी है। अंदाज़ा न लगाएँ — अपनी देखभाल टीम से पूछें कि कौन-सी सही है।'),
  missing_unit: L('A dose is written without a unit (such as mg). Ask your care team to confirm the full dose.', 'Una dosis está escrita sin unidad (como mg). Pida a su equipo que confirme la dosis completa.', 'खुराक बिना इकाई (जैसे mg) के लिखी है। पूरी खुराक अपनी देखभाल टीम से पक्की करें।'),
  missing_dose: L('The document doesn’t say how much to take.', 'El documento no dice cuánto tomar.', 'दस्तावेज़ में यह नहीं लिखा कि कितनी लेनी है।'),
  missing_frequency: L('The document doesn’t say how often to take it.', 'El documento no dice cada cuánto tomarlo.', 'दस्तावेज़ में यह नहीं लिखा कि कितनी बार लेनी है।'),
  change: L('The document describes a change to this medicine. Make sure you know which instruction is current.', 'El documento describe un cambio en este medicamento. Asegúrese de saber cuál es la indicación actual.', 'दस्तावेज़ में इस दवा में बदलाव लिखा है। पक्का करें कि अभी कौन-सा निर्देश लागू है।'),
  naked_decimal: L('A dose is written without a leading zero, which is easy to misread. Please confirm it.', 'Una dosis está escrita sin el cero inicial, lo que puede confundirse. Confírmela.', 'एक खुराक शुरुआती शून्य के बिना लिखी है, जिसे ग़लत पढ़ा जा सकता है। कृपया पक्का करें।'),
  trailing_zero: L('A dose has a trailing zero, which can be misread as ten times the amount. Please confirm it.', 'Una dosis tiene un cero al final, que puede leerse como diez veces más. Confírmela.', 'खुराक के आख़िर में शून्य है, जिसे दस गुना पढ़ा जा सकता है। कृपया पक्का करें।'),
  decimal_comma: L('A dose uses a decimal comma. Please confirm it.', 'Una dosis usa coma decimal. Confírmela.', 'खुराक में दशमलव के लिए कॉमा है। कृपया पक्का करें।'),
  error_prone_abbreviation: L('This uses an abbreviation that is easy to misread. Confirm what it means for this medicine.', 'Usa una abreviatura que se confunde fácilmente. Confirme qué significa para este medicamento.', 'इसमें ऐसा संक्षिप्त रूप है जिसे ग़लत पढ़ा जा सकता है। पक्का करें कि इसका क्या मतलब है।'),
  high_risk_review: L('This is a high-alert medicine, so ClearCare keeps it on your “check with your care team” list and doesn’t set reminders for it.', 'Este es un medicamento de alto riesgo, así que ClearCare lo mantiene en su lista para consultar con su equipo y no pone recordatorios.', 'यह ज़्यादा जोखिम वाली दवा है, इसलिए ClearCare इसे “देखभाल टीम से पूछें” सूची में रखता है और इसके रिमाइंडर नहीं लगाता।'),
  ocr_source: L('This was read from an image, and numbers can be misread. Compare it with your paper copy.', 'Esto se leyó de una imagen y los números pueden leerse mal. Compárelo con su copia en papel.', 'यह तस्वीर से पढ़ा गया है और अंक ग़लत पढ़े जा सकते हैं। काग़ज़ी कॉपी से मिलाएँ।'),
  missing_date: L('The date isn’t given.', 'No se indica la fecha.', 'तारीख़ नहीं दी गई है।'),
  ambiguous_date: L('The date is unclear (the day and month could be read either way, or the year is missing).', 'La fecha no está clara (el día y el mes pueden leerse al revés, o falta el año).', 'तारीख़ साफ़ नहीं है (दिन और महीना उलटे पढ़े जा सकते हैं, या साल नहीं है)।'),
  relative_date: L('It gives a number of days, not an exact date.', 'Indica un número de días, no una fecha exacta.', 'इसमें सही तारीख़ नहीं, सिर्फ़ दिनों की संख्या दी गई है।'),
  missing_time: L('The time isn’t given.', 'No se indica la hora.', 'समय नहीं दिया गया है।'),
  missing_location: L('The place isn’t given.', 'No se indica el lugar.', 'जगह नहीं दी गई है।'),
  conflicting_status: L('Your document both says to take and to stop or pause this medicine. Please ask your care team which is right.', 'Su documento dice que tome este medicamento y también que lo suspenda. Pregunte a su equipo cuál es correcto.', 'आपके दस्तावेज़ में यह दवा लेने और बंद करने — दोनों बातें लिखी हैं। अपनी टीम से पूछें कि कौन-सी सही है।'),
  conditional_stop: L('Your document says to stop or pause this medicine only in certain situations or from a certain time.', 'Su documento dice que suspenda este medicamento solo en ciertas situaciones o desde cierto momento.', 'दस्तावेज़ के अनुसार यह दवा सिर्फ़ कुछ हालात में या किसी तय समय से रोकनी है।'),
  unparsed_negation: L('This instruction contains a “do not” that ClearCare could not place safely, so it is shown in your document’s own words.', 'Esta indicación tiene un “no” que ClearCare no pudo interpretar con seguridad, así que se muestra con las palabras de su documento.', 'इस निर्देश में “न/नहीं” वाली बात है जिसे ClearCare सुरक्षित रूप से नहीं समझ सका, इसलिए दस्तावेज़ के अपने शब्द दिखाए गए हैं।'),
  conflicting_frequency: L('The document gives more than one schedule for this medicine.', 'El documento da más de un horario para este medicamento.', 'दस्तावेज़ में इस दवा के लिए एक से ज़्यादा समय-सारिणी लिखी है।'),
  weekday_schedule: L('This medicine has a schedule that depends on the day of the week.', 'Este medicamento tiene un horario que depende del día de la semana.', 'इस दवा का समय हफ़्ते के दिन पर निर्भर है।'),
  unrecognized_line: L('ClearCare could not tell which medicine this line is about. Please check it with your pharmacist.', 'ClearCare no pudo saber a qué medicamento se refiere esta línea. Consúltelo con su farmacéutico.', 'ClearCare समझ नहीं सका कि यह पंक्ति किस दवा के बारे में है। अपने फ़ार्मासिस्ट से पूछें।'),
  dose_range: L('The document gives a range of doses, not one dose. Ask your care team how to decide.', 'El documento da un rango de dosis, no una sola. Pregunte a su equipo cómo decidir.', 'दस्तावेज़ में एक खुराक नहीं, खुराक की एक सीमा दी गई है। अपनी टीम से पूछें कि कैसे तय करें।'),
  conditional: L('This medicine depends on a condition in your document. Check with your care team how to tell.', 'Este medicamento depende de una condición de su documento. Consulte a su equipo cómo saberlo.', 'यह दवा दस्तावेज़ में लिखी किसी शर्त पर निर्भर है। अपनी टीम से पूछें कि कैसे पहचानें।'),
  not_interpreted: L('Shown in your document’s own words.', 'Se muestra con las palabras de su documento.', 'दस्तावेज़ के अपने शब्दों में दिखाया गया है।'),
  conflicting_appointment: L('The document gives different dates or times for this visit.', 'El documento da fechas u horas diferentes para esta cita.', 'दस्तावेज़ में इस मुलाक़ात की अलग-अलग तारीख़ या समय लिखा है।')
};
export function reasonText(code, lang) { return REASON_TEXT[code] ? pick(REASON_TEXT[code], lang) : code; }

// ---- reviewed phrase templates for common free-text care instructions ----
const SYM = { bleeding: L('bleeding', 'sangrado', 'खून बह रहा'), fever: L('a fever', 'fiebre', 'बुखार'), 'chest pain': L('chest pain', 'dolor en el pecho', 'सीने में दर्द'), 'shortness of breath': L('shortness of breath', 'falta de aire', 'साँस फूलना'), 'trouble breathing': L('trouble breathing', 'dificultad para respirar', 'साँस लेने में तकलीफ़'), swelling: L('swelling', 'hinchazón', 'सूजन'), redness: L('redness', 'enrojecimiento', 'लालिमा'), pus: L('pus', 'pus', 'मवाद'), vomiting: L('vomiting', 'vómitos', 'उल्टी'), 'severe pain': L('severe pain', 'dolor fuerte', 'तेज़ दर्द') };
const PLACE = { incision: L('the incision', 'la herida de la cirugía', 'चीरे'), wound: L('the wound', 'la herida', 'घाव'), dressing: L('the dressing', 'el vendaje', 'पट्टी') };
const TEMPLATES = [
  { rx: /^walk for (\d+) minutes(?: (once|twice|three times) (?:a|per) day)?( as tolerated)?\.?$/i, out: (m, lang) => { const f = m[2] ? pick(FREQ[{ once: 1, twice: 2, 'three times': 3 }[m[2].toLowerCase()]], lang) : ''; const tol = m[3] ? pick(L(', as much as you comfortably can', ', tanto como pueda hacerlo cómodamente', ', जितना आप आराम से कर सकें'), lang) : ''; return pick(L(`Walk for ${m[1]} minutes${f ? ' ' + f : ''}${tol}.`, `Camine ${m[1]} minutos${f ? ' ' + f : ''}${tol}.`, `${f ? f + ' ' : ''}${m[1]} मिनट टहलें${tol}।`), lang); } },
  { rx: /^keep (?:the|your) (incision|wound|dressing) clean and dry\.?$/i, out: (m, lang) => { const p = PLACE[m[1].toLowerCase()]; return pick(L(`Keep ${pick(p, 'en')} clean and dry.`, `Mantenga ${pick(p, 'es')} limpi${m[1].toLowerCase() === 'dressing' ? 'o' : 'a'} y sec${m[1].toLowerCase() === 'dressing' ? 'o' : 'a'}.`, `${pick(p, 'hi')} को साफ़ और सूखा रखें।`), lang); } },
  { rx: /^do not lift (?:anything )?(?:more than|over|heavier than) (\d+) (pounds|lbs|kg|kilograms)(?: for (\d+) (days|weeks))?\.?$/i, out: (m, lang) => { const kg = /^k/i.test(m[2]); const u = kg ? L('kg', 'kg', 'किलो') : L('pounds', 'libras', 'पाउंड'); const d = m[3] ? durText({ value: Number(m[3]), unit: m[4].toLowerCase().replace(/s$/, '') }, lang) : ''; return pick(L(`Do not lift more than ${m[1]} ${pick(u, 'en')}${d ? ' ' + d : ''}.`, `No levante más de ${m[1]} ${pick(u, 'es')}${d ? ' ' + d : ''}.`, `${d ? d + ' ' : ''}${m[1]} ${pick(u, 'hi')} से ज़्यादा वज़न न उठाएँ।`), lang); } },
  { rx: /^do not drive(?: for (\d+) (days|weeks))?\.?$/i, out: (m, lang) => { const d = m[1] ? durText({ value: Number(m[1]), unit: m[2].toLowerCase().replace(/s$/, '') }, lang) : ''; return pick(L(`Do not drive${d ? ' ' + d : ''}.`, `No maneje${d ? ' ' + d : ''}.`, `${d ? d + ' ' : ''}गाड़ी न चलाएँ।`), lang); } },
  { rx: /^follow-up contact:\s*(.+?),\s*(\(?\d[\d() .-]{6,}\d)\.?$/i, out: (m, lang) => pick(L(`Contact for follow-up questions: ${m[1]}, phone ${m[2]}.`, `Contacto para el seguimiento: ${m[1]}, teléfono ${m[2]}.`, `फ़ॉलो-अप के सवालों के लिए संपर्क: ${m[1]}, फ़ोन ${m[2]}।`), lang) },
  { rx: /^rest as needed\.?$/i, out: (m, lang) => pick(L('Rest whenever you need to.', 'Descanse cuando lo necesite.', 'जब भी ज़रूरत हो, आराम करें।'), lang) },
  { rx: /^call (?:the|your) (clinic|doctor|care team) (?:for|if you (?:have|notice)) (?:any )?(bleeding|a fever|fever|swelling|redness|pus|vomiting|severe pain|chest pain|shortness of breath|trouble breathing)\.?$/i, out: (m, lang) => { const s = SYM[m[2].toLowerCase().replace(/^a /, '')]; const who = /doctor/i.test(m[1]) ? L('your doctor', 'a su médico', 'अपने डॉक्टर') : L('the clinic', 'a la clínica', 'क्लिनिक'); return pick(L(`If you have ${pick(s, 'en')}, call ${pick(who, 'en')}.`, `Si tiene ${pick(s, 'es')}, llame ${pick(who, 'es')}.`, `अगर ${pick(s, 'hi')} हो, तो ${pick(who, 'hi')} को फ़ोन करें।`), lang); } },
  { rx: /^call (?:the|your) (clinic|doctor) if you have (?:a|any) question(?:s)? about your (incision|wound|medicines?|medications?)\.?$/i, out: (m, lang) => { const what = /incision/i.test(m[2]) ? L('your incision', 'su herida', 'अपने चीरे') : /wound/i.test(m[2]) ? L('your wound', 'su herida', 'अपने घाव') : L('your medicines', 'sus medicamentos', 'अपनी दवाओं'); const who = /doctor/i.test(m[1]) ? L('your doctor', 'a su médico', 'अपने डॉक्टर') : L('your clinic', 'a su clínica', 'अपने क्लिनिक'); return pick(L(`If you have a question about ${pick(what, 'en')}, call ${pick(who, 'en')}.`, `Si tiene alguna pregunta sobre ${pick(what, 'es')}, llame ${pick(who, 'es')}.`, `${pick(what, 'hi')} के बारे में कोई सवाल हो, तो ${pick(who, 'hi')} को फ़ोन करें।`), lang); } },
  { rx: /^bring your medication list( and this discharge summary)? to your (?:follow-up )?(?:visit|appointment)\.?$/i, out: (m, lang) => pick(L(`Bring your list of medicines${m[1] ? ' and this discharge summary' : ''} to your follow-up visit.`, `Lleve su lista de medicamentos${m[1] ? ' y este resumen de alta' : ''} a su cita de control.`, `अपनी दवाओं की सूची${m[1] ? ' और यह डिस्चार्ज सारांश' : ''} फ़ॉलो-अप जाँच पर साथ लाएँ।`), lang) },
  { rx: /^call (911|108|112) or go to the (?:nearest )?emergency (?:department|room)(?: if you have (chest pain|trouble breathing|shortness of breath|severe pain|heavy bleeding))?\.?$/i, out: (m, lang) => { const s = m[2] ? (SYM[m[2].toLowerCase()] || L(m[2], m[2], m[2])) : null; return pick(L(`${s ? `If you have ${pick(s, 'en')}, ` : ''}call ${m[1]} or go to the nearest emergency department right away.`, `${s ? `Si tiene ${pick(s, 'es')}, ` : ''}llame al ${m[1]} o vaya de inmediato a urgencias.`, `${s ? `अगर ${pick(s, 'hi')} हो, तो ` : ''}तुरंत ${m[1]} पर फ़ोन करें या नज़दीकी इमरजेंसी में जाएँ।`), lang).replace(/^c/, 'C').replace(/^l/, 'L'); } },
  { rx: /^contact the clinic for a clean copy\.?$/i, out: (m, lang) => pick(L('Ask the clinic for a clear copy of this document.', 'Pida a la clínica una copia legible de este documento.', 'क्लिनिक से इस दस्तावेज़ की साफ़ कॉपी माँगें।'), lang) },
  { rx: /^if an instruction is unclear, contact the prescribing clinic or pharmacist to clarify it\.?$/i, out: (m, lang) => pick(L('If any instruction is unclear, ask the clinic that prescribed it or your pharmacist.', 'Si alguna indicación no está clara, pregunte a la clínica que la recetó o a su farmacéutico.', 'अगर कोई निर्देश साफ़ नहीं है, तो दवा लिखने वाले क्लिनिक या फ़ार्मासिस्ट से पूछें।'), lang) }
];
export function renderFreeText(text, lang) {
  const clean = String(text).trim();
  for (const tpl of TEMPLATES) { const m = clean.match(tpl.rx); if (m) return { text: tpl.out(m, lang), method: 'template' }; }
  return lang === 'en' ? { text: clean, method: 'original' } : null;
}

const SEVERITY = { emergency: L('Emergency instruction.', 'Indicación de emergencia.', 'आपातकालीन निर्देश।'), urgent: L('Important warning sign.', 'Señal de alarma importante.', 'ज़रूरी चेतावनी।'), routine: L('', '', '') };

// ---- main entry ----
export function renderItem(item, lang = 'en', mode = 'simple') {
  lang = normalizeLang(lang);
  if (item.category === 'medication') return renderMedication(item, lang, mode);
  if (item.category === 'appointment' || item.category === 'test') return renderAppointment(item, lang, mode);
  if (item.category === 'allergy' || item.category === 'mention') return { text: pick(L(`Your document mentions ${item.name || 'a medicine'} (${item.category === 'allergy' ? 'allergy' : 'history'}). This is not an instruction to take it.`, `Su documento menciona ${item.name || 'un medicamento'} (${item.category === 'allergy' ? 'alergia' : 'antecedente'}). No es una indicación para tomarlo.`, `आपके दस्तावेज़ में ${item.name || 'एक दवा'} का ज़िक्र है (${item.category === 'allergy' ? 'एलर्जी' : 'पुराना इतिहास'})। यह इसे लेने का निर्देश नहीं है।`), lang), steps: [], untranslated: false };
  if (item.category === 'caution') return { text: pick(L(`Important: your document says “${item.text}”`, `Importante: su documento dice “${item.text}”`, `ज़रूरी: आपके दस्तावेज़ में लिखा है “${item.text}”`), lang), steps: [], untranslated: lang !== 'en' };
  if (item.category === 'note') {
    if (item.docLang === lang) return { text: item.text, steps: [], untranslated: false, method: 'original' };
    const name = { hi: L('Hindi', 'hindi', 'हिंदी'), es: L('Spanish', 'español', 'स्पेनिश') }[item.docLang] || L('another language', 'otro idioma', 'दूसरी भाषा');
    return { text: pick(L(`This instruction is written in ${name.en} in your document: “${item.text}”. Use “Explain with Gemini AI” or ask your care team.`, `Esta indicación está escrita en ${name.es} en su documento: “${item.text}”. Use “Explicar con IA de Gemini” o pregunte a su equipo.`, `यह निर्देश आपके दस्तावेज़ में ${name.hi} में लिखा है: “${item.text}”। “Gemini AI से समझाएँ” दबाएँ या अपनी टीम से पूछें।`), lang), steps: [], untranslated: true };
  }
  const sev = item.severity ? pick(SEVERITY[item.severity], lang) : '';
  const r = renderFreeText(item.text, lang);
  const reasons = item.clarity !== 'clear' ? item.reasons.map(x => reasonText(x.code, lang)) : [];
  if (!r) return { text: [sev, pick(L('', 'Esta indicación está en inglés en su documento. Use “Explicar con IA de Gemini” para una explicación verificada en español, o pida ayuda a su equipo.', 'यह निर्देश आपके दस्तावेज़ में अंग्रेज़ी में है। हिंदी में जाँचा हुआ स्पष्टीकरण पाने के लिए “Gemini AI से समझाएँ” दबाएँ, या अपनी टीम से पूछें।'), lang), ...reasons].filter(Boolean).join(' '), steps: [], untranslated: true };
  return { text: [sev, r.text, ...reasons].filter(Boolean).join(' '), steps: mode === 'steps' ? [r.text] : [], untranslated: false, method: r.method };
}

function medName(m) { return m.name ? `${m.name}${m.brand && m.generic && m.generic.toLowerCase() !== m.name.toLowerCase() ? ` (${m.generic})` : ''}` : null; }

function renderMedication(m, lang, mode) {
  const name = medName(m) || pick(L('this medicine', 'este medicamento', 'यह दवा'), lang);
  const reasons = m.reasons.map(r => reasonText(r.code, lang));
  if (m.clarity === 'unreadable') return { text: reasons.join(' '), steps: [], blocked: true };
  // STOP / HOLD: the meaning is "do not take". Always explicit.
  const sname = [name, strengthText(m.strength, lang)].filter(Boolean).join(' ');
  const quote = pick(L(` Your document says: “${m.text}”`, ` Su documento dice: “${m.text}”`, ` आपके दस्तावेज़ में लिखा है: “${m.text}”`), lang);
  const flagged = m.reasons.filter(r => !['high_risk_review', 'ocr_source', 'change'].includes(r.code));
  if (m.status === 'STOP' || m.status === 'HOLD') {
    if (flagged.length) return { text: pick(L(`${name} — please check this with your care team before you take it.`, `${name}: confírmelo con su equipo antes de tomarlo.`, `${name} — इसे लेने से पहले अपनी देखभाल टीम से पक्का करें।`), lang) + ' ' + flagged.map(r => reasonText(r.code, lang)).join(' ') + quote, steps: [], blocked: true };
    if (m.status === 'STOP') return { text: pick(L(`Stop taking ${sname}.`, `Deje de tomar ${sname}.`, `${sname} लेना बंद करें।`), lang) + (reasons.length && mode !== 'simple' ? ' ' + reasons.join(' ') : ''), steps: mode === 'steps' ? [pick(L(`Do not take ${sname}.`, `No tome ${sname}.`, `${sname} न लें।`), lang)] : [] };
    const c = m.resumeCondition, d = m.duration?.value ? durText(m.duration, lang) : '';
    return { text: pick(L(`Do not take ${sname} ${d || 'for now'}${c ? ` — your document says until “${c}”` : ''}.`, `No tome ${sname} ${d || 'por ahora'}${c ? ` — su documento dice: hasta “${c}”` : ''}.`, `${d || 'अभी'} ${sname} न लें${c ? ` — दस्तावेज़ में लिखा है: “${c}” तक` : ''}।`), lang), steps: [] };
  }
  const blocking = m.reasons.filter(r => !['high_risk_review', 'ocr_source', 'change'].includes(r.code));
  if (blocking.length) {
    const alt = m.alternatives?.length ? m.alternatives.map(a => strengthText(a, lang)).join(pick(L(' and ', ' y ', ' और '), lang)) : '';
    const lead = m.reasons.some(r => r.code === 'conflicting_dose') ? pick(L(`Your document gives two different doses for ${name}: ${alt}.`, `Su documento da dos dosis diferentes de ${name}: ${alt}.`, `आपके दस्तावेज़ में ${name} की दो अलग खुराक लिखी हैं: ${alt}।`), lang) : pick(L(`${name} needs checking before you rely on it.`, `${name} necesita confirmarse antes de seguirlo.`, `${name} पर भरोसा करने से पहले इसे पक्का करना ज़रूरी है।`), lang);
    const rest = m.reasons.filter(r => r.code !== 'conflicting_dose' || !m.alternatives?.length).map(r => reasonText(r.code, lang));
    const tail = m.reasons.some(r => r.code === 'conflicting_dose') ? [reasonText('conflicting_dose', lang).replace(/^[^.।:]*[.।:]\s*/, ''), ...rest] : rest;
    const needsQuote = m.reasons.some(r => ['unparsed_negation', 'conditional_stop', 'conflicting_status', 'conflicting_frequency', 'weekday_schedule', 'unrecognized_line', 'dose_range', 'conditional', 'missing_dose', 'missing_frequency'].includes(r.code));
    return { text: [lead, ...tail].join(' ') + (needsQuote ? quote : ''), steps: mode === 'steps' ? tail : [], blocked: true };
  }
  const st = strengthText(m.strength, lang), q = qtyText(m.quantity, lang), route = m.route ? pick(ROUTE[m.route], lang) : '', fr = freqText(m.frequency, lang), prn = prnText(m.frequency, lang), du = durText(m.duration, lang);
  const what = [name, st].filter(Boolean).join(' ');
  let main;
  const verb = { START: L('Start taking', 'Empiece a tomar', 'लेना शुरू करें'), CONTINUE: L('Keep taking', 'Siga tomando', 'लेते रहें'), CHANGE: L('Take', 'Tome', 'लें'), UNKNOWN: L('Take', 'Tome', 'लें') }[m.status] || L('Take', 'Tome', 'लें');
  const listOnly = m.status === 'UNKNOWN' && !m.takes;
  if (m.taper?.length) main = pick(L(`${name}: the dose changes over time.`, `${name}: la dosis cambia con el tiempo.`, `${name}: खुराक समय के साथ बदलती है।`), lang);
  else
  if (lang === 'hi') {
    const obj = q ? `${what} की ${q}` : what;
    const bits = [route, fr, du].filter(Boolean).join(', ');
    main = listOnly ? `आपके दस्तावेज़ में ${what}${q ? ` (${q})` : ''}${bits ? ` — ${bits}` : ''}${prn ? `, ${prn}` : ''} लिखी है।` : `${obj}${bits ? `, ${bits}` : ''} ${pick(verb, 'hi')}${prn ? ` — ${prn}` : ''}।`;
  } else if (lang === 'es') {
    const obj = q ? `${what}: ${q}` : what;
    main = listOnly ? `Su documento incluye ${what}${q ? `: ${q}` : ''}${route ? ` ${route}` : ''}${fr ? `, ${fr}` : ''}${du ? ` ${du}` : ''}${prn ? `, ${prn}` : ''}.` : `${pick(verb, 'es')} ${obj}${route ? ` ${route}` : ''}${fr ? `, ${fr}` : ''}${du ? ` ${du}` : ''}${prn ? `, ${prn}` : ''}.`;
  } else {
    const obj = q ? `${what} — ${q}` : what;
    main = listOnly ? `Your document lists ${what}${q ? ` — ${q}` : ''}${route ? ` ${route}` : ''}${fr ? `, ${fr}` : ''}${du ? ` ${du}` : ''}${prn ? `, ${prn}` : ''}.` : `${pick(verb, 'en')} ${obj}${route ? ` ${route}` : ''}${fr ? `, ${fr}` : ''}${du ? ` ${du}` : ''}${prn ? `, ${prn}` : ''}.`;
  }
  const extras = [];
  if (m.taper?.length) extras.push(m.taper.map((s, i) => { const d = [s.frequency ? freqText(s.frequency, lang) : '', s.frequency ? prnText(s.frequency, lang) : '', s.duration ? durText(s.duration, lang) : ''].filter(Boolean).join(lang === 'hi' ? ', ' : ' '); const x = strengthText(s, lang); return i === 0 ? pick(L(`First take ${x}${d ? ' ' + d : ''}.`, `Primero tome ${x}${d ? ' ' + d : ''}.`, `पहले ${d ? d + ' ' : ''}${x} लें।`), lang) : pick(L(`Then take ${x}${d ? ' ' + d : ''}.`, `Después tome ${x}${d ? ' ' + d : ''}.`, `उसके बाद ${d ? d + ' ' : ''}${x} लें।`), lang); }).join(' '));
  if (m.maxDaily) { const x = m.maxDaily.unit === 'dose' ? pick(L(`${m.maxDaily.value} doses`, `${m.maxDaily.value} dosis`, `${m.maxDaily.value} खुराक`), lang) : m.maxDaily.unit === 'tablet' ? `${m.maxDaily.value} ${pick(QTY.tablet, lang)[1]}` : strengthText(m.maxDaily, lang); const per = /24/.test(m.maxDaily.per || '') ? L('in 24 hours', 'en 24 horas', '24 घंटे में') : L('in a day', 'al día', 'एक दिन में'); extras.push(pick(L(`Do not take more than ${x} ${per.en}.`, `No tome más de ${x} ${per.es}.`, `${per.hi} ${x} से ज़्यादा न लें।`), lang)); }
  const CAUT = { milk: L('milk', 'leche', 'दूध'), dairy: L('dairy products', 'lácteos', 'डेयरी चीज़ों'), 'dairy products': L('dairy products', 'lácteos', 'डेयरी चीज़ों'), food: L('food', 'comida', 'खाने'), alcohol: L('alcohol', 'alcohol', 'शराब'), grapefruit: L('grapefruit', 'toronja', 'चकोतरे'), 'grapefruit juice': L('grapefruit juice', 'jugo de toronja', 'चकोतरे के रस'), antacids: L('antacids', 'antiácidos', 'एंटासिड') };
  for (const c of m.cautions || []) { if (c === 'empty stomach') extras.push(pick(L('Do not take it on an empty stomach.', 'No lo tome en ayunas.', 'इसे ख़ाली पेट न लें।'), lang)); else if (c === 'alcohol') extras.push(pick(L('Avoid alcohol.', 'Evite el alcohol.', 'शराब न पिएँ।'), lang)); else if (CAUT[c]) extras.push(pick(L(`Do not take it with ${CAUT[c].en}.`, `No lo tome con ${CAUT[c].es}.`, `इसे ${CAUT[c].hi} के साथ न लें।`), lang)); }
  if (m.doNotMiss) extras.push(pick(L('Do not miss a dose.', 'No se salte ninguna dosis.', 'कोई खुराक न छोड़ें।'), lang));
  if (m.doNotStop) extras.push(/\bunless\b/i.test(m.text) ? pick(L('Do not stop taking it unless your provider tells you to.', 'No deje de tomarlo a menos que su médico se lo indique.', 'जब तक डॉक्टर न कहें, इसे लेना बंद न करें।'), lang) : pick(L('Do not stop taking it.', 'No deje de tomarlo.', 'इसे लेना बंद न करें।'), lang));
  if (m.start?.date) extras.push(pick(L(`Start on ${formatDate(m.start.date, 'en')}.`, `Empiece el ${formatDate(m.start.date, 'es')}.`, `${formatDate(m.start.date, 'hi')} से शुरू करें।`), lang));
  if (m.start?.raw === 'tomorrow') extras.push(pick(L('Your document says to start tomorrow.', 'Su documento dice que empiece mañana.', 'दस्तावेज़ के अनुसार कल से शुरू करें।'), lang));
  else if (m.start?.delay?.unit === 'weekday') extras.push(pick(L(`Your document says to start on ${m.start.raw}.`, `Su documento dice que empiece el “${m.start.raw}”.`, `दस्तावेज़ के अनुसार “${m.start.raw}” से शुरू करें।`), lang));
  else if (m.start?.delay?.value) extras.push(pick(L(`The document says to start after ${m.start.delay.value} ${m.start.delay.unit}s.`, `El documento dice que empiece después de ${m.start.delay.value} ${m.start.delay.unit === 'week' ? 'semanas' : 'días'}.`, `दस्तावेज़ के अनुसार ${m.start.delay.value} ${m.start.delay.unit === 'week' ? 'हफ़्ते' : 'दिन'} बाद शुरू करें।`), lang));
  if (m.duration?.until && !m.resumeCondition) extras.push(pick(L(`Your document says: until “${m.duration.until}”.`, `Su documento dice: hasta “${m.duration.until}”.`, `दस्तावेज़ में लिखा है: “${m.duration.until}” तक।`), lang));
  if (m.condition) extras.push(pick(L(`Only if: “${m.condition}” (your document’s words).`, `Solo si: “${m.condition}” (palabras de su documento).`, `सिर्फ़ तब: “${m.condition}” (दस्तावेज़ के शब्द)।`), lang));
  const notes = m.reasons.map(r => reasonText(r.code, lang));
  const abbr = m.abbreviations.map(a => `${a.key} = ${pick(a.meaning, lang)}`);
  if (mode === 'simple') return { text: [main, ...extras, ...notes.filter((_, i) => m.reasons[i].code === 'high_risk_review')].join(' '), steps: [] };
  if (mode === 'steps') {
    const steps = [];
    steps.push(pick(L(`Medicine: ${what}`, `Medicamento: ${what}`, `दवा: ${what}`), lang));
    if (q) steps.push(pick(L(`How much each time: ${q}`, `Cuánto cada vez: ${q}`, `हर बार कितनी: ${q}`), lang));
    if (route) steps.push(pick(L(`How: ${route}`, `Cómo: ${route}`, `कैसे: ${route}`), lang));
    if (fr || prn) steps.push(pick(L(`When: ${[fr, prn].filter(Boolean).join(', ')}`, `Cuándo: ${[fr, prn].filter(Boolean).join(', ')}`, `कब: ${[fr, prn].filter(Boolean).join(', ')}`), lang));
    if (du) steps.push(pick(L(`How long: ${du}`, `Por cuánto tiempo: ${du}`, `कितने दिन: ${du}`), lang));
    steps.push(...extras, ...notes);
    return { text: main, steps };
  }
  return { text: [main, ...extras, ...notes, abbr.length ? pick(L('Abbreviations: ', 'Abreviaturas: ', 'संक्षिप्त रूप: '), lang) + abbr.join('; ') + '.' : ''].filter(Boolean).join(' '), steps: [] };
}

function renderAppointment(a, lang, mode) {
  const kind = a.kind === 'test' ? L('A test', 'Una prueba', 'एक जाँच') : L('A follow-up visit', 'Una cita de control', 'एक फ़ॉलो-अप मुलाक़ात');
  const reasons = a.reasons.map(r => reasonText(r.code, lang));
  if (a.clarity !== 'clear') {
    const rel = a.relative ? pick(L(` Your document says “${a.relative.value} ${a.relative.unit}s”.`, ` Su documento dice “${a.relative.value} ${a.relative.unit === 'week' ? 'semanas' : 'días'}”.`, ` दस्तावेज़ में “${a.relative.value} ${a.relative.unit === 'week' ? 'हफ़्ते' : 'दिन'}” लिखा है।`), lang) : '';
    const known = [a.date ? formatDate(a.date, lang) : '', a.time ? formatTime(a.time, lang) : '', a.location || ''].filter(Boolean).join(', ');
    return { text: pick(L(`${kind.en} is mentioned${known ? ` (${known})` : ''}, but some details are missing.${rel}`, `Se menciona ${kind.es.toLowerCase()}${known ? ` (${known})` : ''}, pero faltan algunos datos.${rel}`, `${kind.hi} का ज़िक्र है${known ? ` (${known})` : ''}, लेकिन कुछ जानकारी नहीं है।${rel}`), lang) + ' ' + reasons.join(' ') + ' ' + pick(L('Please confirm it with your care team.', 'Confírmela con su equipo de atención.', 'कृपया अपनी देखभाल टीम से पक्का करें।'), lang), steps: [], blocked: true };
  }
  const who = a.with ? (/^dr\.?\s/i.test(a.with) ? a.with : null) : null;
  const text = pick(L(`${kind.en}${who ? ` with ${who}` : ''}: ${formatDate(a.date, 'en')} at ${formatTime(a.time, 'en')}, ${a.location}.`, `${kind.es}${who ? ` con ${who}` : ''}: ${formatDate(a.date, 'es')} a las ${formatTime(a.time, 'es')}, ${a.location}.`, `${kind.hi}${who ? ` (${who} के साथ)` : ''}: ${formatDate(a.date, 'hi')}, ${formatTime(a.time, 'hi')}, ${a.location}।`), lang);
  return { text, steps: mode === 'steps' ? [formatDate(a.date, lang), formatTime(a.time, lang), a.location] : [] };
}

// Defence in depth: every rule-based rendering of a CLEAR instruction is independently verified
// at runtime. If verification fails, the patient sees the document's own words instead.
export function renderItemSafe(item, lang = 'en', mode = 'simple') {
  const r = renderItem(item, lang, mode);
  if (r.blocked || r.untranslated || item.category === 'caution' || item.clarity !== 'clear' || !['medication', 'appointment', 'test', 'warning', 'contact', 'wound', 'activity', 'diet', 'home'].includes(item.category)) return r;
  const source = item.provenance?.text || item.text || '';
  const v = verifyExplanation({ sourceText: source, item, explanation: [r.text, ...(r.steps || [])].join('\n'), lang: normalizeLang(lang), repeats: mode === 'steps' });
  if (v.ok) return r;
  return { text: pick(L(`Here are your document’s own words: “${source}”`, `Estas son las palabras de su documento: “${source}”`, `आपके दस्तावेज़ के अपने शब्द: “${source}”`), normalizeLang(lang)), steps: [], fallback: true, failures: v.failures.map(f => f.code), untranslated: normalizeLang(lang) !== 'en' };
}
