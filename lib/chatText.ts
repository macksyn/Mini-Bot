// lib/chatText.ts — pure text helpers for the chatbot (no I/O, easy to test)

// ── Reply cleaning ───────────────────────────────────────────────────────────

// Models sometimes write roleplay actions like "*winks*". Turn those (and ONLY those,
// i.e. a whole action wrapped in asterisks) into an emoji. The old version replaced the
// bare words everywhere, so "he thinks you're right" became "he 🤔 you're right".
const ACTION_EMOJI: Record<string, string> = {
  wink: '😉', winks: '😉',
  'roll eyes': '🙄', 'rolls eyes': '🙄', 'eye roll': '🙄', 'eyeroll': '🙄', 'rolls his eyes': '🙄', 'rolls my eyes': '🙄',
  shrug: '🤷', shrugs: '🤷',
  'raises eyebrow': '🤨', 'raises an eyebrow': '🤨', 'raises one eyebrow': '🤨',
  smile: '😊', smiles: '😊',
  laugh: '😂', laughs: '😂',
  cry: '😢', cries: '😢',
  think: '🤔', thinks: '🤔',
  sleep: '😴', sleeps: '😴'
};

export function cleanResponse(text: string): string {
  return text
    .trim()
    // Strip ChatGPT-web ":::writing{variant=... id=... title=...}" wrapper (and its closing ":::") leaked by the proxy.
    .replace(/^[ \t]*:::[ \t]*writing\s*\{[^}]*\}[ \t]*\r?\n?/gim, '')
    .replace(/^[ \t]*:::[ \t]*$/gm, '')
    .trim()
    .replace(/\*\s*([a-z ]{3,20}?)\s*\*/gi, (match, action: string) =>
      ACTION_EMOJI[action.trim().toLowerCase()] ?? match)
    // Strip prompt-instruction lines the model sometimes echoes — only when the line STARTS with the marker.
    .replace(/^[ \t]*(?:Remember|IMPORTANT):.*$/gm, '')
    .replace(/^(Groq|Bot|AI|Assistant)\s*:\s*/gim, '')
    .replace(/By the way, to unlock the full functionality of all Apps, enable\s*\[?Gemini Apps Activity\]?[^\n]*/gi, '')
    .replace(/\[Gemini Apps Activity\]\(https?:\/\/[^)]+\)/gi, '')
    .replace(/https?:\/\/myactivity\.\S+\/product\/gemini\S*/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ── Profile extraction (age / location) ─────────────────────────────────────

// Words that are never a place name when they come first ("I live in a small house").
const LOCATION_BAD_FIRST = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that', 'these', 'those',
  'here', 'there', 'home', 'work', 'school', 'bed', 'love', 'fear', 'trouble', 'pain', 'debt',
  'general', 'fact', 'case', 'doubt'
]);
// Words that end the place name ("I'm from Abuja o", "I live in Lagos and I love it").
const LOCATION_STOP_AFTER = new Set([
  'and', 'but', 'so', 'because', 'cos', 'since', 'right', 'now', 'today', 'currently', 'o', 'oh',
  'abeg', 'though', 'tho', 'lol', 'that', 'which', 'where', 'when', 'with', 'for', 'at', 'how', 'what'
]);

/** Returns a clean place name, or null if the text doesn't look like one. Safe to run on stored values too. */
export function cleanLocation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const sentence = raw.split(/[.!?;:\n]/)[0];
  const tokens: string[] = [];
  for (const tok of sentence.split(/\s+/).filter(Boolean)) {
    if (tokens.length >= 4) break;
    if (LOCATION_STOP_AFTER.has(tok.toLowerCase().replace(/,+$/, ''))) break;
    tokens.push(tok);
  }
  if (tokens.length === 0) return null;
  if (LOCATION_BAD_FIRST.has(tokens[0].toLowerCase().replace(/,+$/, ''))) return null;

  const joined = tokens.join(' ').replace(/[,\s]+$/, '');
  if (!/^[\p{L}][\p{L} ,'-]{1,39}$/u.test(joined)) return null;
  return joined.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const LOCATION_RE =
  /\b(?:i\s+live\s+in|i\s+stay\s+in|i\s+come\s+from|i\s+am\s+from|i'?m\s+from|i\s+am\s+based\s+in|i'?m\s+based\s+in|my\s+(?:city|country|state|town)\s+is)\s+([a-z][a-z ,.'-]{1,50})/i;

// Only when the number is clearly the person's age: followed by "years old", "yo", punctuation,
// end of message, or a joining word — never "I'm 5 minutes away" or "I'm 100% sure".
const AGE_RE =
  /\b(?:i\s+am|i'?m|my\s+age\s+is)\s*(\d{1,3})(?=\s*(?:years?\s*old|yrs?\s*old|yo\b|y\/o|[.,!?]|$|\s+(?:and|but|so|from|in|male|female|guy|lady|man|woman|boy|girl)\b))/i;

/** Pulls an explicit, self-describing age/location out of a message. Never guesses from stray "in"/"from". */
export function extractUserInfo(message: string): { age?: string; location?: string } {
  // Phones often type curly apostrophes (I’m) — normalise so the patterns match.
  const text = message.trim().replace(/[’‘`]/g, "'");
  const info: { age?: string; location?: string } = {};

  const ageMatch = text.match(AGE_RE);
  if (ageMatch?.[1]) {
    const n = Number(ageMatch[1]);
    if (n >= 10 && n <= 99) info.age = String(n);
  }

  const locMatch = text.match(LOCATION_RE);
  if (locMatch?.[1]) {
    const loc = cleanLocation(locMatch[1]);
    if (loc) info.location = loc;
  }
  return info;
}