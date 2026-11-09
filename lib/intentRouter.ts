export type ChatIntent = 'casual' | 'help' | 'moderation' | 'learning' | 'realtime';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

const HELP_PATTERNS = [
  /\b(how do i|how can i|help me|fix this|why does|why is|error|bug|issue|troubleshoot|solution|steps?)\b/i,
  /\b(can you explain|explain to me|teach me|tutorial|guide me|what should i do)\b/i
];

const LEARNING_PATTERNS = [
  /\b(explain|teach|learn|meaning of|difference between|what is|what are|how does|why does)\b/i,
  /\b(definition|concept|theory|algorithm|programming|coding)\b/i
];

const MODERATION_PATTERNS = [
  /\b(rule|rules|policy|ban|kick|mute|warn|report|moderation|admin|permission|allowed|not allowed|do not)\b/i,
  /\b(what is the rule|which rule|why was i banned|how to report|what happens if)\b/i
];

const REALTIME_PATTERNS = [
  /\b(latest|live|right now|today|tonight|current|as of|breaking|news|weather|forecast)\b/i,
  /\b(score|result|fixture|match|stock|price|crypto|exchange rate|winner|champion)\b/i
];

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','if','then','than','that','this','these','those','with','without',
  'for','from','into','onto','over','under','about','after','before','during','while','your','you','we',
  'i','me','my','our','us','is','are','was','were','be','been','being','to','of','in','on','at','it','its',
  'as','so','do','does','did','can','could','should','would','will','just','also','very','more','most','not'
]);

export function classifyIntent(message: string): ChatIntent {
  const text = message.trim().toLowerCase();

  if (REALTIME_PATTERNS.some(pattern => pattern.test(text))) {
    return 'realtime';
  }

  if (MODERATION_PATTERNS.some(pattern => pattern.test(text))) {
    return 'moderation';
  }

  if (HELP_PATTERNS.some(pattern => pattern.test(text))) {
    return 'help';
  }

  if (LEARNING_PATTERNS.some(pattern => pattern.test(text))) {
    return 'learning';
  }

  return 'casual';
}

export function getConfidenceLevel(message: string): ConfidenceLevel {
  const text = message.trim().toLowerCase();

  const ambiguousPatterns = [
    /\b(maybe|perhaps|not sure|i think|kind of|sort of|something like that)\b/i,
    /\b(what do you think|can you tell me more|what should i do|help me choose)\b/i,
    /\b(about|some|any|few|a bit|really)\b/i
  ];

  const highConfidencePatterns = [
    /\b(what is|who is|when is|where is|define|explain|how many|how much|what are)\b/i,
    /\b(rule|rules|ban|mute|warn|report)\b/i
  ];

  if (ambiguousPatterns.some(pattern => pattern.test(text))) return 'low';
  if (highConfidencePatterns.some(pattern => pattern.test(text))) return 'high';
  return 'medium';
}

export function getClarificationHint(intent: ChatIntent, confidence: ConfidenceLevel): string {
  if (confidence === 'low') {
    return 'If the question is ambiguous, ask one short clarifying follow-up before answering fully.';
  }

  if (intent === 'realtime') {
    return 'If the answer depends on live data, say you may need current information and ask for the exact time or source if needed.';
  }

  return 'Answer directly unless more context is clearly needed.';
}

export function extractQuotedContext(message: any): string {
  const quoted = message?.message?.extendedTextMessage?.contextInfo?.quotedMessage
    || message?.message?.viewOnceMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage
    || message?.message?.viewOnceMessageV2?.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  const text =
    quoted?.conversation ||
    quoted?.extendedTextMessage?.text ||
    quoted?.extendedTextMessage?.description ||
    quoted?.imageMessage?.caption ||
    quoted?.videoMessage?.caption ||
    quoted?.documentMessage?.caption ||
    '';

  return text.trim();
}

export function extractPreferences(message: string): Record<string, any> {
  const text = message.toLowerCase();
  const preferences: Record<string, any> = {};

  if (/\b(short|brief|concise|quick)\b/i.test(text)) preferences.length = 'short';
  if (/\b(detailed|long|full explanation|thorough)\b/i.test(text)) preferences.length = 'detailed';
  if (/\b(casual|funny|playful|jokes|chill)\b/i.test(text)) preferences.tone = 'casual';
  if (/\b(formal|professional|serious|strict)\b/i.test(text)) preferences.tone = 'formal';
  if (/\b(friendly|warm|supportive)\b/i.test(text)) preferences.tone = 'friendly';

  const topics = ['coding', 'music', 'sports', 'movies', 'gaming', 'tech', 'anime', 'news']
    .filter(topic => new RegExp(`\\b${topic}\\b`, 'i').test(text));
  if (topics.length) preferences.topics = topics;

  return preferences;
}

export function compressHistory(messages: string[], maxRecentTurns = 8): { summary: string; recent: string[] } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { summary: '', recent: [] };
  }

  const recent = messages.slice(-maxRecentTurns);
  const older = messages.slice(0, -maxRecentTurns);

  if (older.length === 0) {
    return { summary: '', recent };
  }

  const freq = new Map<string, number>();
  for (const entry of older) {
    const words = entry
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !STOP_WORDS.has(word));

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const topics = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);

  const summary = topics.length
    ? `Topic memory: earlier you discussed ${topics.join(', ')}.`
    : 'Topic memory: earlier conversation context is summarized briefly.';

  return { summary, recent };
}

function stripIdentityNoise(text: string): string {
  return text
    .replace(/^\s*(?:User|Bot)\s*\([^)]*\):\s*/i, '')
    .replace(/^\s*Bot:\s*/i, '')
    .replace(/^\s*User:\s*/i, '')
    .replace(/\bmy name is\s+[a-z0-9_ -]+/gi, '...')
    .replace(/\bi am\s+\d+\s+years old\b/gi, '...')
    .replace(/\bi live in\s+[a-z ,.-]+/gi, '...')
    .replace(/\bi am from\s+[a-z ,.-]+/gi, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeGroupHistory(messages: string[], maxRecentTurns = 4): string[] {
  const cleaned = messages
    .map(entry => stripIdentityNoise(entry))
    .filter(Boolean);

  if (cleaned.length === 0) {
    return ['Group summary: ongoing group discussion.'];
  }

  const recent = cleaned.slice(-maxRecentTurns);
  const older = cleaned.slice(0, -maxRecentTurns);
  const freq = new Map<string, number>();

  for (const entry of [...older, ...recent]) {
    const words = entry
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !STOP_WORDS.has(word));

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const topics = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);

  const summary = topics.length
    ? `Group summary: recent topics include ${topics.join(', ')}.`
    : 'Group summary: ongoing group discussion.';

  const lastTopic = recent.length
    ? `Last topic: ${recent[recent.length - 1].slice(0, 120)}.`
    : '';

  return [summary, lastTopic].filter(Boolean);
}

export function summarizeProfile(profile: Record<string, any>): string {
  const parts: string[] = [];
  if (profile.name) parts.push(`name is ${profile.name}`);
  if (profile.location) parts.push(`lives in ${profile.location}`);
  if (profile.age) parts.push(`is ${profile.age} years old`);

  const prefs = profile.preferences ?? {};
  if (prefs.tone) parts.push(`prefers a ${prefs.tone} tone`);
  if (prefs.length) parts.push(`prefers ${prefs.length} replies`);
  if (Array.isArray(prefs.topics) && prefs.topics.length) parts.push(`likes ${prefs.topics.join(', ')}`);

  return parts.length ? `User memory: ${parts.join('; ')}.` : 'User memory: none yet.';
}

export function getIntentInstruction(intent: ChatIntent): string {
  switch (intent) {
    case 'help':       return 'Give brief, practical steps.';
    case 'moderation': return 'Be calm and policy-focused.';
    case 'learning':   return 'Explain simply with short examples.';
    case 'realtime':   return 'Give current facts; admit if unsure.';
    case 'casual':
    default:           return 'Keep it warm and natural.';
  }
}
