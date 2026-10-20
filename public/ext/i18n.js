// LanguageProvider: ClearCare supports exactly three languages.
export const LANGS = Object.freeze({
  en: { code: 'en', label: 'English', legacy: 'English', bcp47: 'en-US', speech: ['en-IN', 'en-US', 'en-GB', 'en'], locale: 'en-US' },
  es: { code: 'es', label: 'Español', legacy: 'Español', bcp47: 'es-ES', speech: ['es-US', 'es-MX', 'es-ES', 'es'], locale: 'es-ES' },
  hi: { code: 'hi', label: 'हिन्दी', legacy: 'हिन्दी', bcp47: 'hi-IN', speech: ['hi-IN', 'hi'], locale: 'hi-IN' }
});
export const SUPPORTED = Object.keys(LANGS);
export function normalizeLang(v) {
  if (!v) return 'en';
  const s = String(v).toLowerCase();
  if (s === 'es' || s.startsWith('es-') || s === 'español' || s === 'espanol' || s === 'spanish') return 'es';
  if (s === 'hi' || s.startsWith('hi-') || s === 'हिन्दी' || s === 'हिंदी' || s === 'hindi') return 'hi';
  return 'en';
}
export function legacyLabel(code) { return LANGS[normalizeLang(code)].legacy; }

const T = {
  today: { en: 'Today', es: 'Hoy', hi: 'आज' },
  tomorrow: { en: 'Tomorrow', es: 'Mañana', hi: 'कल' },
  upcoming: { en: 'Upcoming', es: 'Próximamente', hi: 'आने वाले दिन' },
  medicines: { en: 'Medicines', es: 'Medicamentos', hi: 'दवाएँ' },
  appointments: { en: 'Appointments', es: 'Citas', hi: 'अपॉइंटमेंट' },
  recovery: { en: 'Recovery tasks', es: 'Tareas de recuperación', hi: 'ठीक होने के काम' },
  clarify: { en: 'Needs clarification', es: 'Necesita aclaración', hi: 'स्पष्ट करना ज़रूरी' },
  dontTake: { en: 'Do not take', es: 'No tomar', hi: 'न लें' },
  watchFor: { en: 'Watch for', es: 'Esté atento a', hi: 'इन बातों पर ध्यान दें' },
  hearMyDay: { en: 'Hear my day', es: 'Escuchar mi día', hi: 'मेरा दिन सुनें' },
  pause: { en: 'Pause', es: 'Pausa', hi: 'रोकें' },
  resume: { en: 'Resume', es: 'Continuar', hi: 'फिर चलाएँ' },
  stop: { en: 'Stop', es: 'Detener', hi: 'बंद करें' },
  replay: { en: 'Replay', es: 'Repetir', hi: 'दोबारा सुनें' },
  speed: { en: 'Speed', es: 'Velocidad', hi: 'गति' },
  listen: { en: 'Listen', es: 'Escuchar', hi: 'सुनें' },
  showOriginal: { en: 'Show original', es: 'Ver original', hi: 'मूल देखें' },
  understand: { en: 'I understand', es: 'Entiendo', hi: 'मैं समझ गया/गई' },
  explainAgain: { en: 'Explain again', es: 'Explíquelo otra vez', hi: 'फिर से समझाएँ' },
  slower: { en: 'Speak more slowly', es: 'Hable más despacio', hi: 'धीरे बोलें' },
  needClarification: { en: 'I need clarification', es: 'Necesito una aclaración', hi: 'मुझे स्पष्टीकरण चाहिए' },
  simple: { en: 'Simple', es: 'Sencillo', hi: 'आसान' },
  detailed: { en: 'Detailed', es: 'Detallado', hi: 'विस्तार से' },
  steps: { en: 'Step by step', es: 'Paso a paso', hi: 'एक-एक करके' },
  explainAI: { en: 'Explain with Gemini AI', es: 'Explicar con IA de Gemini', hi: 'Gemini AI से समझाएँ' },
  ask: { en: 'Ask about your document', es: 'Pregunte sobre su documento', hi: 'अपने दस्तावेज़ के बारे में पूछें' },
  askPlaceholder: { en: 'For example: When is my follow-up?', es: 'Por ejemplo: ¿Cuándo es mi cita?', hi: 'जैसे: मेरा फ़ॉलो-अप कब है?' },
  send: { en: 'Ask', es: 'Preguntar', hi: 'पूछें' },
  speakQuestion: { en: 'Speak your question', es: 'Diga su pregunta', hi: 'बोलकर पूछें' },
  listening: { en: 'Listening… (microphone on)', es: 'Escuchando… (micrófono encendido)', hi: 'सुन रहा है… (माइक चालू)' },
  fromDocument: { en: 'From your document', es: 'De su documento', hi: 'आपके दस्तावेज़ से' },
  page: { en: 'page', es: 'página', hi: 'पृष्ठ' },
  rulesLabel: { en: 'Explained by ClearCare rules (not AI)', es: 'Explicado por reglas de ClearCare (no IA)', hi: 'ClearCare नियमों से समझाया गया (AI नहीं)' },
  aiLabel: { en: 'Gemini AI explanation · checked against your document', es: 'Explicación de IA de Gemini · verificada con su documento', hi: 'Gemini AI स्पष्टीकरण · आपके दस्तावेज़ से जाँचा गया' },
  withheld: { en: 'We couldn’t safely simplify this one. Please read your document’s own words below and check with your care team.', es: 'No pudimos simplificar esto con seguridad. Lea las palabras de su documento abajo y consulte con su equipo de atención.', hi: 'इसे सुरक्षित रूप से आसान नहीं बना सके। कृपया नीचे दस्तावेज़ के अपने शब्द पढ़ें और अपनी देखभाल टीम से पूछें।' },
  markTaken: { en: 'I took this dose', es: 'Tomé esta dosis', hi: 'मैंने यह खुराक ले ली' },
  markDone: { en: 'Mark done', es: 'Marcar hecho', hi: 'हो गया' },
  yourTime: { en: 'your chosen time', es: 'hora elegida por usted', hi: 'आपका चुना समय' },
  noVoice: { en: 'No voice for this language is installed in this browser, so it can’t read aloud. The text is shown here.', es: 'Este navegador no tiene una voz instalada para este idioma, así que no puede leer en voz alta. El texto se muestra aquí.', hi: 'इस ब्राउज़र में इस भाषा की आवाज़ इंस्टॉल नहीं है, इसलिए पढ़कर नहीं सुना सकता। लिखा हुआ यहाँ है।' },
  autoplayBlocked: { en: 'Your browser didn’t allow automatic reading. Tap “Hear my day” whenever you’re ready.', es: 'Su navegador no permitió la lectura automática. Toque “Escuchar mi día” cuando quiera.', hi: 'आपके ब्राउज़र ने अपने-आप पढ़ने की अनुमति नहीं दी। जब चाहें “मेरा दिन सुनें” दबाएँ।' },
  noPlan: { en: 'Add your discharge papers to see your day here.', es: 'Agregue sus papeles de alta para ver su día aquí.', hi: 'अपना दिन यहाँ देखने के लिए डिस्चार्ज के कागज़ जोड़ें।' }
};
export function t(key, lang) { const e = T[key]; if (!e) return key; return e[normalizeLang(lang)] ?? e.en; }

// More languages: ClearCare's own text is shown in English, then translated by Gemini AI and only
// displayed when a back-translation passes the same fidelity checks (see lib/ext/translate.js).
// [code, English name, native name, speech BCP-47 preferences, right-to-left]
export const EXTRA_LANGS = Object.freeze(Object.fromEntries([
  ['bn', 'Bengali', 'বাংলা', ['bn-IN', 'bn-BD', 'bn']], ['ta', 'Tamil', 'தமிழ்', ['ta-IN', 'ta']], ['te', 'Telugu', 'తెలుగు', ['te-IN', 'te']],
  ['mr', 'Marathi', 'मराठी', ['mr-IN', 'mr']], ['gu', 'Gujarati', 'ગુજરાતી', ['gu-IN', 'gu']], ['kn', 'Kannada', 'ಕನ್ನಡ', ['kn-IN', 'kn']],
  ['ml', 'Malayalam', 'മലയാളം', ['ml-IN', 'ml']], ['pa', 'Punjabi', 'ਪੰਜਾਬੀ', ['pa-IN', 'pa']], ['or', 'Odia', 'ଓଡ଼ିଆ', ['or-IN', 'or']],
  ['ur', 'Urdu', 'اردو', ['ur-IN', 'ur-PK', 'ur'], true], ['ne', 'Nepali', 'नेपाली', ['ne-NP', 'ne']], ['si', 'Sinhala', 'සිංහල', ['si-LK', 'si']],
  ['ar', 'Arabic', 'العربية', ['ar-SA', 'ar-EG', 'ar'], true], ['fa', 'Persian', 'فارسی', ['fa-IR', 'fa'], true], ['he', 'Hebrew', 'עברית', ['he-IL', 'he'], true],
  ['fr', 'French', 'Français', ['fr-FR', 'fr-CA', 'fr']], ['de', 'German', 'Deutsch', ['de-DE', 'de']], ['pt', 'Portuguese', 'Português', ['pt-BR', 'pt-PT', 'pt']],
  ['it', 'Italian', 'Italiano', ['it-IT', 'it']], ['nl', 'Dutch', 'Nederlands', ['nl-NL', 'nl']], ['ru', 'Russian', 'Русский', ['ru-RU', 'ru']],
  ['uk', 'Ukrainian', 'Українська', ['uk-UA', 'uk']], ['pl', 'Polish', 'Polski', ['pl-PL', 'pl']], ['ro', 'Romanian', 'Română', ['ro-RO', 'ro']],
  ['el', 'Greek', 'Ελληνικά', ['el-GR', 'el']], ['tr', 'Turkish', 'Türkçe', ['tr-TR', 'tr']], ['zh', 'Chinese (Simplified)', '简体中文', ['zh-CN', 'zh']],
  ['ja', 'Japanese', '日本語', ['ja-JP', 'ja']], ['ko', 'Korean', '한국어', ['ko-KR', 'ko']], ['vi', 'Vietnamese', 'Tiếng Việt', ['vi-VN', 'vi']],
  ['th', 'Thai', 'ไทย', ['th-TH', 'th']], ['id', 'Indonesian', 'Bahasa Indonesia', ['id-ID', 'id']], ['ms', 'Malay', 'Bahasa Melayu', ['ms-MY', 'ms']],
  ['fil', 'Filipino', 'Filipino', ['fil-PH', 'fil']], ['sw', 'Swahili', 'Kiswahili', ['sw-KE', 'sw-TZ', 'sw']], ['am', 'Amharic', 'አማርኛ', ['am-ET', 'am']],
  ['so', 'Somali', 'Soomaali', ['so-SO', 'so']], ['zu', 'Zulu', 'isiZulu', ['zu-ZA', 'zu']]
].map(([code, name, native, speech, rtl = false]) => [code, Object.freeze({ code, name, native, speech, bcp47: speech[0], rtl })])));
