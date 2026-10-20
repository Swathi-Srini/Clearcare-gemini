// Small .env reader so ClearCare can load local configuration on every supported Node version.
// Existing shell environment values take precedence. Never log the values from this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ALLOWED_SETTINGS = new Set([
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MIN_INTERVAL_MS', 'PORT',
  'CLEARCARE_GEMINI_BASE_URL', 'CLEARCARE_TRANSLATION_CACHE'
]);

export function loadEnvFile(path = resolve(process.cwd(), '.env'), env = process.env) {
  let source;
  try { source = readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name] = match;
    if (!ALLOWED_SETTINGS.has(name)) continue;
    let value = match[2].trim();

    // Remove comments only when they follow whitespace, preserving # inside quoted values.
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      if (end >= 0) value = value.slice(1, end).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end >= 0) value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    if (env[name] === undefined) env[name] = value;
  }
  return true;
}
