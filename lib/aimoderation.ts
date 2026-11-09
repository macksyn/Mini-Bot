export interface ModerationResult {
    flagged: boolean;
    categories: string[];
    score: number;
    provider: string;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

// ── In-memory cache to avoid re-scanning identical messages ──────────────────
const cache = new Map<string, { result: ModerationResult; ts: number }>();
const CACHE_TTL   = 60_000;   // 1 minute
const CACHE_LIMIT = 500;

function getCached(text: string): ModerationResult | null {
    const entry = cache.get(text);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(text); return null; }
    return entry.result;
}

function setCache(text: string, result: ModerationResult): void {
    if (cache.size >= CACHE_LIMIT) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        cache.delete(oldest[0]);
    }
    cache.set(text, { result, ts: Date.now() });
}

// ── OpenAI Moderation API (free endpoint, requires OPENAI_API_KEY) ───────────
async function moderateWithOpenAI(text: string): Promise<ModerationResult> {
    const res = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ input: text }),
        signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) throw new Error(`OpenAI moderation error: ${res.status}`);

    const data: any = await res.json();
    const result = data.results[0];

    const flaggedCategories: string[] = Object.entries(result.categories as Record<string, boolean>)
        .filter(([, v]) => v)
        .map(([k]) => k);

    const maxScore = Math.max(
        ...Object.values(result.category_scores as Record<string, number>)
    );

    return {
        flagged: result.flagged,
        categories: flaggedCategories,
        score: maxScore,
        provider: 'openai'
    };
}

// ── Groq / Llama fallback (requires GROQ_API_KEY) ────────────────────────────
async function moderateWithGroq(text: string): Promise<ModerationResult> {
    const prompt =
        `You are a strict content moderation system for a WhatsApp group. ` +
        `Analyze the following message and return ONLY a JSON object — no explanation, no markdown.\n\n` +
        `JSON format: {"flagged": true|false, "categories": ["category1",...], "score": 0.0-1.0}\n\n` +
        `Categories to check: hate_speech, harassment, threats, sexual, violence, self_harm, spam, radicalization\n` +
        `Score: 0.0 = completely safe, 1.0 = extremely toxic. Only flag genuinely harmful content.\n\n` +
        `Message: "${text.replace(/"/g, "'").substring(0, 800)}"`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 120
        }),
        signal: AbortSignal.timeout(9000)
    });

    if (!res.ok) throw new Error(`Groq moderation error: ${res.status}`);

    const data: any = await res.json();
    const content: string = data.choices[0].message.content.trim();

    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('No JSON in Groq response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
        flagged:    !!parsed.flagged,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        score:      typeof parsed.score === 'number' ? parsed.score : (parsed.flagged ? 0.8 : 0.1),
        provider:   'groq'
    };
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function runModeration(text: string): Promise<ModerationResult> {
    const trimmed = text?.trim();
    if (!trimmed || trimmed.length < 4) {
        return { flagged: false, categories: [], score: 0, provider: 'skip' };
    }

    const normalized = trimmed.substring(0, 1000);
    const cached = getCached(normalized);
    if (cached) return cached;

    let result: ModerationResult = { flagged: false, categories: [], score: 0, provider: 'none' };

    if (OPENAI_API_KEY) {
        try {
            result = await moderateWithOpenAI(normalized);
        } catch {
            // fall through to Groq
            if (GROQ_API_KEY) {
                try { result = await moderateWithGroq(normalized); } catch { /* silent */ }
            }
        }
    } else if (GROQ_API_KEY) {
        try {
            result = await moderateWithGroq(normalized);
        } catch { /* silent — return safe default */ }
    }

    setCache(normalized, result);
    return result;
}

export function hasAIProvider(): boolean {
    return !!(OPENAI_API_KEY || GROQ_API_KEY);
}

export function getProviderName(): string {
    if (OPENAI_API_KEY) return '🟢 OpenAI Moderation API';
    if (GROQ_API_KEY)   return '🟡 Groq AI (Llama-3.1)';
    return '🔴 No AI key configured';
}
