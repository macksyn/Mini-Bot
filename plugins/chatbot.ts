import type { BotContext } from '../types.js';
import { createStore, getAdapter } from '../lib/pluginStore.js';
import {
    detectInsult,
    getGrudge,
    setGrudge,
    clearGrudge,
    getGrudgeClapback,
    getThawMessage,
    type GrudgeRecord
} from '../lib/grudge.js';
import { fixTags, removeSelfTags, tag, toJid, type Taggable } from '../lib/tag.js';
import { cleanLocation, cleanResponse, extractUserInfo } from '../lib/chatText.js';
import { classifyIntent, compressHistory, extractPreferences, extractQuotedContext, getClarificationHint, getConfidenceLevel, getIntentInstruction, summarizeGroupHistory, summarizeProfile, type ChatIntent } from '../lib/intentRouter.js';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const db        = createStore('chatbot');
const dbUsers   = db.table!('users');
const dbHistory = db.table!('history');
const dbConfig  = db.table!('config');
const dbMembers = db.table!('members');

const profileCache = new Map<string, Record<string, any>>();
const historyCache = new Map<string, string[]>();

// ── Per-key async mutex ──────────────────────────────────────────────────────
// This used to be `processingLock = new Set()` that was added to and deleted from but never
// CHECKED, so nothing was serialized: two quick messages from one person ran in parallel and
// overwrote each other's history (a stored "User: second question" ended up next to "Bot: reply 1").
// runExclusive() queues work per key so turns run one at a time, in arrival order.
// maxQueued caps running+waiting jobs for a key; extra jobs are dropped (flood protection).
const lockTails = new Map<string, Promise<void>>();
const lockDepth = new Map<string, number>();

async function runExclusive<T>(
    key: string,
    fn: () => Promise<T>,
    maxQueued: number = Infinity
): Promise<{ ran: true; value: T } | { ran: false }> {
    const depth = lockDepth.get(key) ?? 0;
    if (depth >= maxQueued) return { ran: false };
    lockDepth.set(key, depth + 1);

    const prev = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail    = new Promise<void>(res => { release = res; });
    const chained = prev.then(() => tail);
    lockTails.set(key, chained);

    await prev;
    try {
        return { ran: true, value: await fn() };
    } finally {
        release();
        const left = (lockDepth.get(key) ?? 1) - 1;
        if (left <= 0) {
            lockDepth.delete(key);
            if (lockTails.get(key) === chained) lockTails.delete(key);
        } else {
            lockDepth.set(key, left);
        }
    }
}

// One person's turns (per chat): the one running + up to 2 waiting. More than that is spam.
const MAX_QUEUED_TURNS = 3;

// ── OPT 1: groupMetadata TTL cache ───────────────────────────────────────────
// sock.groupMetadata() is a live WhatsApp network call. Without caching it fires
// on EVERY chatbot message — extremely wasteful since group membership barely
// changes between turns. A 10-minute TTL eliminates the round-trip for ~99% of
// messages while still reflecting kicks/joins promptly.
const GROUP_META_TTL_MS = 10 * 60 * 1000; // 10 minutes
interface GroupMetaEntry { meta: any; ts: number }
const groupMetaCache = new Map<string, GroupMetaEntry>();

async function getCachedGroupMeta(sock: any, chatId: string): Promise<any> {
    const cached = groupMetaCache.get(chatId);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL_MS) {
        return cached.meta;
    }
    // Cache miss or TTL expired — fetch live and store
    const meta = await (sock as any).groupMetadata(chatId).catch(() => null);
    if (meta) groupMetaCache.set(chatId, { meta, ts: Date.now() });
    return meta;
}

// Invalidate a group's cached metadata immediately (call this on
// group-participants.update so kicks/joins are reflected without waiting for TTL)
export function invalidateGroupMetaCache(chatId: string): void {
    groupMetaCache.delete(chatId);
}

// ── Tag helpers: who can the bot name / @tag in this chat? ───────────────────
// The model writes "@Name"; fixTags() turns that into a real tag — but only if we
// can map the name back to a JID. WhatsApp never gives us names for silent members,
// and a name seen in turn 1 is gone by turn 5. So every name we ever learn (from an
// @mention, a pushName, a contact) is remembered per group in a small directory
// and reused on every later turn.
interface MemberEntry { id: string; names: string[] }
const memberDirCache = new Map<string, Record<string, MemberEntry>>();
const bareId = (jid: string) => jid.split('@')[0].split(':')[0];

async function loadMemberDir(chatId: string): Promise<Record<string, MemberEntry>> {
    const cached = memberDirCache.get(chatId);
    if (cached) return cached;
    let dir: Record<string, MemberEntry> = {};
    try { dir = ((await dbMembers.get(chatId)) as any) || {}; } catch (_) {}
    memberDirCache.set(chatId, dir);
    return dir;
}

/** Remember "this JID is called <name>" for this group. Call it for any message you see. */
export async function rememberMember(chatId: string, jid: string | undefined, ...names: (string | null | undefined)[]): Promise<void> {
    if (!jid) return;
    const clean = names.map(n => (n || '').trim()).filter(n => n.length >= 2 && n.length <= 40);
    if (clean.length === 0) return;
    const dir   = await loadMemberDir(chatId);
    const key   = bareId(jid);
    const entry = dir[key] || { id: jid, names: [] };
    const before = JSON.stringify(entry);
    entry.id = jid;
    for (const n of [...clean].reverse()) {
        if (!entry.names.some(x => x.toLowerCase() === n.toLowerCase())) entry.names.unshift(n);
    }
    entry.names = entry.names.slice(0, 4);
    if (JSON.stringify(entry) === before) return;
    dir[key] = entry;
    try { await dbMembers.set(chatId, dir as any); } catch (_) {}
}

function liveName(sock: any, id: string): string | undefined {
    const num      = bareId(id);
    const contacts = sock.store?.contacts || {};
    const c        = contacts[id] || contacts[`${num}@s.whatsapp.net`] || contacts[`${num}@lid`];
    return profileCache.get(id)?.name || c?.notify || c?.name || c?.pushName || undefined;
}

async function buildTaggables(sock: any, chatId: string, groupMeta: any, extraJids: string[] = [], excludeIds: string[] = []): Promise<Taggable[]> {
    const dir    = await loadMemberDir(chatId);
    // The bot itself is never a tag target — pre-seeding `seen` makes add() skip it everywhere.
    const seen   = new Set<string>(excludeIds.map(bareId));
    const people: Taggable[] = [];

    const add = (id: string | undefined, lid?: string, phoneJid?: string) => {
        if (!id) return;
        const ids = [id, lid, phoneJid].filter(Boolean).map(j => bareId(j as string));
        if (ids.some(k => seen.has(k))) return;
        ids.forEach(k => seen.add(k));

        // Prefer the JID WhatsApp itself handed us in a mention/message (proven to render as a tag).
        const known = ids.map(k => dir[k]).find(Boolean);
        const canon = known?.id || id;
        const pn    = phoneJid || (id.endsWith('@s.whatsapp.net') ? id : undefined);
        const names = [liveName(sock, canon), liveName(sock, id), ...(known?.names || [])]
            .filter((n): n is string => !!n);
        const uniq  = [...new Set(names)];

        people.push({
            id:      canon,
            phone:   pn ? bareId(pn) : undefined,
            name:    uniq[0],
            aliases: uniq.slice(1),
            alt:     ids.filter(k => k !== bareId(canon))
        });
    };

    for (const p of groupMeta?.participants || []) add(p?.id, p?.lid, p?.phoneNumber);
    for (const j of extraJids) add(j);
    return people;
}

// ── OPT 2: per-connection botJids cache ──────────────────────────────────────
// sock.user.id / sock.user.lid never change after the WA connection is open.
// Rebuilding botJids on every single message is pure waste. We cache it once
// when the bot connects (via setBotJidsCache) and reuse it until a reconnect.
let _cachedBotJids: string[] | null = null;

export function setBotJidsCache(sock: any): void {
    const botId     = sock.user?.id ?? '';
    const botNumber = botId.split(':')[0];
    const botLid    = sock.user?.lid ?? '';
    _cachedBotJids = [
        botId,
        `${botNumber}@s.whatsapp.net`,
        `${botNumber}@whatsapp.net`,
    ];
    if (botLid) _cachedBotJids.push(botLid, `${botLid.split(':')[0]}@lid`);
    console.log(`[CHATBOT] botJids cached: ${_cachedBotJids.join(', ')}`);
}

function getBotJids(sock: any): string[] {
    // Return the cached array if available; fall back to building it live
    // (covers the rare case where handleChatbotResponse is called before
    // setBotJidsCache, e.g. in tests or an edge reconnect race).
    if (_cachedBotJids) return _cachedBotJids;
    const botId     = sock.user?.id ?? '';
    const botNumber = botId.split(':')[0];
    const botLid    = sock.user?.lid ?? '';
    const jids = [botId, `${botNumber}@s.whatsapp.net`, `${botNumber}@whatsapp.net`];
    if (botLid) jids.push(botLid, `${botLid.split(':')[0]}@lid`);
    return jids;
}

const CACHE_TTL_MS       = 2 * 60 * 60 * 1000;
const INACTIVE_DAYS      = 180;
const INACTIVE_MS        = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const cacheLastAccessed  = new Map<string, number>();

// ── Conversation session gap ─────────────────────────────────────────────────
// Personal/group history used to be plain string[] with no timestamp, so a
// reply from 3 days ago would get fed straight back into the prompt as if the
// conversation never stopped — confusing once the in-memory cache had been
// evicted (CACHE_TTL_MS) and the read fell through to raw DB data. Now every
// stored thread carries an `updatedAt`, and a thread older than the gap below
// is treated as a fresh conversation on next load. This ONLY affects the
// recent back-and-forth context — the user's profile (name, age, location,
// preferences) is untouched, so the bot still "remembers" the person, it just
// doesn't drag a stale, finished conversation into a new one.
const SESSION_GAP_HOURS       = Number(process.env.CHATBOT_SESSION_GAP_HOURS) || 4;
const SESSION_GAP_MS          = SESSION_GAP_HOURS * 60 * 60 * 1000;
// BUG FIX: this used to default to SESSION_GAP_HOURS (4h), the same window as
// a single person's own memory. But the group thread logs EVERY member's
// exchange with the bot — a topic one person raised (e.g. a health
// complaint) stayed "live" and eligible to bleed into a totally different
// member's unrelated message for up to 4 hours. A room's live topic goes
// stale much faster than one person's own conversation does, so this now
// defaults to 20 minutes and is decoupled from the personal gap. Still
// overridable via the same env var (in hours) if a group genuinely wants a
// longer shared-context window.
const GROUP_SESSION_GAP_HOURS = Number(process.env.CHATBOT_GROUP_SESSION_GAP_HOURS) || (20 / 60);
const GROUP_SESSION_GAP_MS    = GROUP_SESSION_GAP_HOURS * 60 * 60 * 1000;

// FIX: history turns used to be hard-truncated to 80 chars at SAVE time, on
// top of buildContextBlock's own char-budget trimming at PROMPT time. That
// double truncation was a major cause of "drift" on repeated questions — the
// model literally couldn't see the full text of what it said last time, so
// it re-derived a fresh (and often different) answer instead of recognising
// "I already answered this." 300 chars keeps a real answer intact while
// buildContextBlock still governs the overall prompt size.
const HISTORY_TURN_CHAR_LIMIT = 300;

setInterval(() => {
    const now   = Date.now();
    let evicted = 0;
    for (const [senderId, lastAt] of cacheLastAccessed.entries()) {
        if (now - lastAt > CACHE_TTL_MS) {
            profileCache.delete(senderId);
            for (const hKey of historyCache.keys()) {
                if (hKey.startsWith(`${senderId}__`)) historyCache.delete(hKey);
            }
            cacheLastAccessed.delete(senderId);
            evicted++;
        }
    }
    if (evicted > 0) console.log(`[CACHE] Evicted ${evicted} idle user(s) from cache`);
}, CACHE_TTL_MS);

// ── BUG FIX #6: track actually-pruned count, not raw history.length ──────────
async function pruneInactiveData(): Promise<void> {
    try {
        const adapter = await getAdapter();

        // FIX: file adapter returns ts:0 for every entry — pruning is a no-op and
        // wastes a full scan every 6 hours. Skip it entirely for the file backend.
        if ((adapter as any).name === 'file') return;

        const users   = await adapter.getAllWithMeta?.('chatbot_users')   ?? [];
        const history = await adapter.getAllWithMeta?.('chatbot_history') ?? [];
        const now     = Date.now();

        const inactiveUsers = new Set<string>();
        for (const entry of users) {
            const lastSeen = typeof entry.value?.lastSeen === 'number' ? entry.value.lastSeen : entry.ts;
            if (lastSeen && now - lastSeen > INACTIVE_MS) {
                inactiveUsers.add(entry.key);
            }
        }

        for (const key of inactiveUsers) {
            await dbUsers.del(key);
            profileCache.delete(key);
            cacheLastAccessed.delete(key);
            for (const hKey of historyCache.keys()) {
                if (hKey.startsWith(`${key}__`)) historyCache.delete(hKey);
            }
        }

        // FIX: count actually pruned history entries instead of using history.length
        let prunedHistory = 0;
        for (const entry of history) {
            const lastSeen = typeof entry.value?.lastSeen === 'number' ? entry.value.lastSeen : entry.ts;
            if (lastSeen && now - lastSeen > INACTIVE_MS) {
                await dbHistory.del(entry.key);
                historyCache.delete(entry.key);
                prunedHistory++;
            }
        }

        // Only log when something was actually removed
        if (inactiveUsers.size > 0 || prunedHistory > 0) {
            console.log(`[CLEANUP] Pruned ${inactiveUsers.size} inactive profile(s) and ${prunedHistory} history entry(s) older than ${INACTIVE_DAYS} days`);
        }
    } catch (error: any) {
        console.error('[CLEANUP] Failed to prune inactive data:', error.message);
    }
}

setInterval(() => { void pruneInactiveData(); }, CLEANUP_INTERVAL_MS);
void pruneInactiveData();

// ── Profile / history helpers ─────────────────────────────────────────────────

async function loadProfile(senderId: string): Promise<Record<string, any>> {
    cacheLastAccessed.set(senderId, Date.now());
    if (profileCache.has(senderId)) return profileCache.get(senderId)!;
    const stored = await dbUsers.get(senderId) ?? {};
    profileCache.set(senderId, stored);
    return stored;
}

async function saveProfile(senderId: string, profile: Record<string, any>): Promise<void> {
    cacheLastAccessed.set(senderId, Date.now());
    profileCache.set(senderId, profile);
    await dbUsers.set(senderId, profile);
}

function historyKey(senderId: string, chatId: string): string {
    return `${senderId}__${chatId}`;
}

function groupHistoryKey(chatId: string): string {
    return `group__${chatId}`;
}

// Stored shape is now { messages, updatedAt } instead of a bare array, so we
// can tell how long ago a thread last had a turn added to it.
// gptThread is optional and only ever set on a personal (per-sender) record —
// see loadGptThread/saveGptThread below. Group records never carry one.
interface StoredHistory { messages: string[]; updatedAt: number; gptThread?: ChatGPTThread }

function normalizeStoredHistory(raw: any): StoredHistory {
    if (Array.isArray(raw)) {
        // Legacy format from before session-gap tracking existed: a bare
        // string[] with no timestamp. Treat it as "just now" rather than
        // "unknown/ancient" so we don't yank an in-flight conversation out
        // from under someone the moment this ships — it naturally gains a
        // real timestamp on the very next save either way.
        return { messages: raw, updatedAt: Date.now() };
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.messages)) {
        return {
            messages:  raw.messages,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
            gptThread: raw.gptThread ?? undefined
        };
    }
    return { messages: [], updatedAt: 0 };
}

async function loadHistory(senderId: string, chatId: string): Promise<string[]> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    if (historyCache.has(key)) return historyCache.get(key)!;

    const { messages, updatedAt } = normalizeStoredHistory(await dbHistory.get(key));

    if (messages.length > 0 && Date.now() - updatedAt > SESSION_GAP_MS) {
        // Long enough since the last turn — start this thread fresh. We don't
        // need to delete it from the DB: the next saveHistory() call will
        // overwrite it with the new thread anyway.
        console.log(`[HISTORY] Session gap (${SESSION_GAP_HOURS}h) exceeded for ${key} — starting fresh thread`);
        historyCache.set(key, []);
        return [];
    }

    historyCache.set(key, messages);
    return messages;
}

async function saveHistory(senderId: string, chatId: string, messages: string[]): Promise<void> {
    const key = historyKey(senderId, chatId);
    cacheLastAccessed.set(senderId, Date.now());
    historyCache.set(key, messages);
    // This write must not clobber a ChatGPT thread saved separately by
    // saveGptThread (below) under the same key — re-read and carry it forward.
    const gptThread = normalizeStoredHistory(await dbHistory.get(key)).gptThread;
    await dbHistory.set(key, { messages, updatedAt: Date.now(), ...(gptThread ? { gptThread } : {}) } as any);
}

// ── ChatGPT thread continuity ─────────────────────────────────────────────────
// Stored inside the same personal-history record (keyed by historyKey) so it
// expires on exactly the same session-gap rule as the rest of that thread —
// a stale thread just means the next turn starts a fresh ChatGPT conversation.
async function loadGptThread(senderId: string, chatId: string): Promise<ChatGPTThread | null> {
    const key = historyKey(senderId, chatId);
    const { updatedAt, gptThread } = normalizeStoredHistory(await dbHistory.get(key));
    if (!gptThread) return null;
    if (Date.now() - updatedAt > SESSION_GAP_MS) return null;
    return gptThread;
}

async function saveGptThread(senderId: string, chatId: string, thread: ChatGPTThread): Promise<void> {
    const key      = historyKey(senderId, chatId);
    const existing = normalizeStoredHistory(await dbHistory.get(key));
    await dbHistory.set(key, { ...existing, gptThread: thread, updatedAt: Date.now() } as any);
}

async function clearHistory(senderId: string, chatId: string): Promise<void> {
    const key = historyKey(senderId, chatId);
    historyCache.delete(key);
    await dbHistory.del(key);
}

// BUG FIX: there was previously no way to wipe the shared group-wide thread
// short of waiting out GROUP_SESSION_GAP_MS. That's what let a stuck topic
// (e.g. "no one has cramps") keep circulating — every attempt to tell the
// bot to drop it necessarily re-mentioned it, which just added a fresh turn
// back into the same shared thread. .chatbot reset (no @mention) now calls
// this to clear it immediately. No historyCache entry to clean up here —
// group history is never cached in memory (see appendGroupHistory).
async function clearGroupHistory(chatId: string): Promise<void> {
    const key = groupHistoryKey(chatId);
    await dbHistory.del(key);
}

// ── BUG FIX #4: store raw messages; summarise only on load ───────────────────
async function loadGroupHistory(chatId: string): Promise<string[]> {
    const key = groupHistoryKey(chatId);
    const { messages, updatedAt } = normalizeStoredHistory(await dbHistory.get(key));

    if (messages.length > 0 && Date.now() - updatedAt > GROUP_SESSION_GAP_MS) {
        console.log(`[HISTORY] Group session gap (${GROUP_SESSION_GAP_HOURS}h) exceeded for ${key} — starting fresh thread`);
        return [];
    }

    // Summarise on load only — never on save
    return summarizeGroupHistory(messages);
}

// Appends this exchange to the shared group thread INSIDE a per-chat lock, re-reading the stored
// thread first. Two members answered at the same time used to overwrite each other (last write
// won). It also appends to the RAW stored messages — before, the summarised copy returned by
// loadGroupHistory() was what got saved back, so summaries got re-summarised on every turn.
async function appendGroupHistory(chatId: string, turns: string[]): Promise<void> {
    const key = groupHistoryKey(chatId);
    await runExclusive(`group:${chatId}`, async () => {
        const stored = normalizeStoredHistory(await dbHistory.get(key));
        const live   = stored.messages.length > 0 && Date.now() - stored.updatedAt > GROUP_SESSION_GAP_MS ? [] : stored.messages;
        await dbHistory.set(key, { messages: [...live, ...turns].slice(-8), updatedAt: Date.now() } as any);
    });
}

// ── AI provider config ────────────────────────────────────────────────────────
// Primary: a ChatGPT-backed proxy (malvin) with true multi-turn threading —
// it returns a chatId + auth blob that gets passed back on the next call to
// continue the same remote conversation, and it decides on its own when to
// use its built-in web search. Fallback: Groq's compound-mini, kept so the
// existing health-tracking/circuit-breaker logic still has something to fall
// back to if the primary is degraded.

const CHATGPT_API_URL       = process.env.CHATGPT_API_URL ?? 'https://api.malvin.gleeze.com/api/ai/chatgpt';
// Set CHATGPT_API_KEY in your environment. There is deliberately no default in the source:
// a key committed to the repo is shared by everyone who clones it (and shares their rate limits).
// Without a key the primary provider is simply disabled and the Groq fallback is used.
const CHATGPT_API_KEY       = process.env.MALVIN_API_KEY ?? '';
const PRIMARY_PROVIDER_NAME = 'chatgpt-luna';

interface ChatGPTAuth {
    cookie:          string;
    deviceId:        string;
    parentMessageId: string;
}

// Follow-up (continuing) requests POST { prompt, chatId, auth: { cookie,
// deviceId, parentMessageId } } — the same shape the first response returns,
// echoed straight back. Confirmed against the API's own follow-up example.
interface ChatGPTThread {
    chatId: string;
    auth:   ChatGPTAuth;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

if (!CHATGPT_API_KEY) console.warn('[CHATBOT] CHATGPT_API_KEY is not set — primary AI provider (chatgpt-luna) is DISABLED.');
if (!GROQ_API_KEY)    console.warn('[CHATBOT] GROQ_API_KEY is not set — fallback AI provider (groq) is DISABLED.');

const FALLBACK_MODEL = {
    name:  'groq/compound-mini',
    model: process.env.GROQ_FALLBACK_MODEL ?? 'groq/compound-mini'
};

const API_FAILURE_RESET_MS = 5 * 60 * 1000;
const API_SKIP_THRESHOLD   = 3;

// ── Temperature by intent ─────────────────────────────────────────────────────
// A single flat temperature (0.85) was applied to every reply regardless of
// intent. That's fine for banter, but it's exactly why factual/realtime
// questions "drifted" on repeat: high sampling temperature on top of the
// compound model's own live web-search variance meant two runs of the same
// question could land on different phrasing AND different facts. Casual chat
// keeps a high temperature for personality; anything where getting the facts
// right matters gets a much lower one so it converges on a consistent answer.
const TEMPERATURE_BY_INTENT: Record<ChatIntent, number> = {
    casual:     0.8,
    help:       0.4,
    moderation: 0.3,
    learning:   0.4,
    realtime:   0.3
};

// A bare acknowledgment/thanks isn't banter that benefits from personality
// variance — it's a one-line close. Lower and steadier than casual (0.8) so
// it doesn't wander into re-explaining things.
const CLOSING_REMARK_TEMPERATURE = 0.5;

const apiStats: Record<string, { count: number; lastFailAt: number; lastSuccessAt: number }> = {};
[PRIMARY_PROVIDER_NAME, FALLBACK_MODEL.name].forEach(name => {
    apiStats[name] = { count: 0, lastFailAt: 0, lastSuccessAt: 0 };
});

setInterval(() => {
    const now = Date.now();
    for (const name of Object.keys(apiStats)) {
        if (apiStats[name].count > 0 && now - apiStats[name].lastFailAt > API_FAILURE_RESET_MS) {
            apiStats[name].count = 0;
            console.log(`[API] Reset failure count for ${name}`);
        }
    }
}, API_FAILURE_RESET_MS);

function isApiHealthy(name: string): boolean {
    const s   = apiStats[name];
    const now = Date.now();
    if (s.count >= API_SKIP_THRESHOLD && now - s.lastFailAt < API_FAILURE_RESET_MS) {
        console.log(`[API] Skipping ${name} — ${s.count} recent failures`);
        return false;
    }
    return true;
}

// ── Chatbot config storage ────────────────────────────────────────────────────
// The hot path used to call dbConfig.getAll() (a full table scan) on EVERY message just to
// check one chat, and `.chatbot on/off` saved by diffing a whole stale snapshot — so two
// admins toggling different groups at once could delete each other's setting.
// Now: single-key get/set/del, plus a short cache for the per-message check.
const CONFIG_CACHE_TTL_MS = 60 * 1000;
const enabledCache = new Map<string, { on: boolean; ts: number }>();

async function isChatbotEnabled(chatId: string, fresh = false): Promise<boolean> {
    const cached = enabledCache.get(chatId);
    if (!fresh && cached && Date.now() - cached.ts < CONFIG_CACHE_TTL_MS) return cached.on;
    try {
        const on = !!(await dbConfig.get(chatId));
        enabledCache.set(chatId, { on, ts: Date.now() });
        return on;
    } catch (error: any) {
        console.error('Error reading chatbot config:', error.message);
        return cached?.on ?? false;
    }
}

async function setChatbotEnabled(chatId: string, on: boolean): Promise<void> {
    if (on) await dbConfig.set(chatId, true as any);
    else    await dbConfig.del(chatId);
    enabledCache.set(chatId, { on, ts: Date.now() });
}

// Kept for any other module that imports them (exported on the default export below).
// Prefer isChatbotEnabled / setChatbotEnabled: saveUserGroupData treats `data` as the COMPLETE
// desired state, so a stale snapshot still deletes entries added after it was loaded.
async function loadUserGroupData() {
    try {
        const enabled = await dbConfig.getAll();
        return { chatbot: enabled };
    } catch (error: any) {
        console.error('Error loading chatbot config:', error.message);
        return { chatbot: {} };
    }
}

async function saveUserGroupData(data: any) {
    try {
        const current = await dbConfig.getAll();
        for (const [chatId, val] of Object.entries(data.chatbot ?? {})) {
            await dbConfig.set(chatId, val);
        }
        for (const chatId of Object.keys(current)) {
            if (!(chatId in (data.chatbot ?? {}))) {
                await dbConfig.del(chatId);
            }
        }
        enabledCache.clear();
    } catch (error: any) {
        console.error('Error saving chatbot config:', error.message);
    }
}

// ── Typing helpers ────────────────────────────────────────────────────────────

async function startTyping(sock: any, chatId: string): Promise<void> {
    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
    } catch (error: any) {
        console.error('Typing start error:', error.message);
    }
}

async function stopTyping(sock: any, chatId: string): Promise<void> {
    try {
        await sock.sendPresenceUpdate('paused', chatId);
    } catch (_) {}
}

async function showTyping(sock: any, chatId: string, estimatedResponseLength = 80): Promise<void> {
    try {
        const base  = Math.min(Math.max(estimatedResponseLength * 40, 1500), 6000);
        const delay = Math.round(base * (0.7 + Math.random() * 0.6));
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (Math.random() < 0.25) {
            await sock.sendPresenceUpdate('paused', chatId);
            await new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 600));
            await sock.sendPresenceUpdate('composing', chatId);
            await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 800));
        }
    } catch (error: any) {
        console.error('Typing indicator error:', error.message);
    }
}

// ── Name helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the first real name word from a WhatsApp pushName.
 * Returns null if the name is absent, too short, or consists only of
 * emoji / non-letter characters.
 */
function extractFirstName(pushName: string | undefined): string | null {
    if (!pushName) return null;
    // Split into whitespace-delimited tokens, then strip every non-letter character
    // (emoji, symbols, punctuation) from each token. Return the first token that
    // still has ≥2 Unicode letters after stripping.
    // This handles cases like "👑Alex 👑", "👑 Alex", "Alex👑", "~Tunde~", etc.
    const tokens = pushName.trim().split(/\s+/);
    for (const token of tokens) {
        const letters = token.replace(/[^\p{L}'\-]/gu, '');
        if (letters.length >= 2) {
            return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
        }
    }
    return null;
}

/** True if the text looks like an affirmative confirmation */
function isAffirmative(text: string): boolean {
    return /^\s*(yes|yeah|yep|yup|yh|yas|correct|right|sure|ok|okay|that'?s (right|correct|me)|absolutely|exactly|confirmed?|go ahead|perfect|true)\b/i.test(text.trim());
}

/** True if the text looks like a denial */
function isNegative(text: string): boolean {
    return /^\s*(no|nope|nah|nah+|not (right|correct|me|really)|wrong|that'?s (wrong|not (right|me))|different|change it|incorrect)\b/i.test(text.trim());
}

// ── Closing-remark detector ───────────────────────────────────────────────────
// Bare acknowledgments, reactions, and short thanks — "ok", "yeah", "for
// real", "🙏", "thanks I appreciate". A real person replies to these with a
// short line and moves on; the bot was instead treating them like any other
// message and re-explaining or re-emphasizing whatever was just discussed
// (including tacking on "in case it happens again"-style caveats nobody
// asked for). This is intentionally narrow — it only fires when the WHOLE
// message is a closing remark, never on a short question ("ok but why").
// Add more phrases (e.g. pidgin your group actually uses) to these lists as
// you notice them.
const CLOSING_ACK_PHRASES = [
    'ok', 'okay', 'k', 'kk', 'oh okay', 'alright', 'aight', 'oh ok', 'true', 'thats true', 'bna true',
    'say less', 'fr', 'frfr', 'for real', 'facts', 'deadass', 'yeah', 'yea', 'yeh', 'yh',
    'yep', 'yup', 'ya', 'hmm', 'nice', 'cool', 'noted', 'got it', 'gotcha', 'i see', 'hmmm',
    'makes sense', 'fair enough', 'lol', 'lmao', 'lmaoo', 'lool', 'haha', 'hahaha', 'hehe', 'ttyl', 'ok later', 'later'
];
const CLOSING_THANKS_PHRASES = [
    'thanks', 'thank you', 'thank u', 'thanks a lot', 'thanks alot', 'thanks so much',
    'thank you so much', 'ok thanks', 'appreciate it', 'appreciate that', 'i appreciate', 'i appreciate it',
    'i appreciate that', 'tysm', 'ty', 'much appreciated', 'appreciated', 'thank you very much'
];

function normalizeForClosingCheck(text: string): string {
    return text.trim().toLowerCase().replace(/[.!?,~]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** True only if the ENTIRE message is a bare acknowledgment/reaction/thanks — never a new question. */
function isClosingRemark(text: string): boolean {
    const raw = text.trim();
    if (!raw) return false;
    if (raw.includes('?')) return false;

    // Emoji/symbol-only message (no letters anywhere) — a reaction, not a question.
    if (!/\p{L}/u.test(raw)) return true;

    const t = normalizeForClosingCheck(raw);
    if (CLOSING_ACK_PHRASES.includes(t)) return true;

    const thanksMatch = CLOSING_THANKS_PHRASES.find(p => t === p || t.startsWith(p + ' '));
    if (thanksMatch) {
        // "thank you so much man" is still just thanks; "thanks but can you
        // also..." is a new ask riding along with it — don't short-circuit that.
        return !/\b(but|also|however|and|can you|could you|what about)\b/.test(t);
    }
    return false;
}

/**
 * Try to pull a name out of a short reply during name-collection flow.
 * Works for formal patterns ("My name is X") and bare short replies ("just call me Tunde").
 */
function parseNameFromReply(text: string): string | null {
    const t = text.trim();
    if (!t) return null;

    // Formal patterns from extractUserInfo
    const namePatterns = [
        /\bmy\s+name\s+is\s+([a-z][a-z'\-]{1,20})/i,
        /\bcall\s+me\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bi\s+am\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bI'm\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bit'?s\s+([a-z][a-z'\-]{1,20})\b/i,
        /\bjust\s+(?:call\s+me\s+)?([a-z][a-z'\-]{1,20})\b/i,
    ];
    for (const p of namePatterns) {
        const m = t.match(p);
        if (m?.[1]) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    }

    // If the reply is short (1–3 words, only letters/hyphens/apostrophes), treat it as a name
    const words = t.split(/\s+/);
    if (words.length >= 1 && words.length <= 3) {
        const onlyNameChars = words.every(w => /^[a-zA-Z'\-]+$/.test(w));
        if (onlyNameChars && words[0].length >= 2) {
            return words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
        }
    }

    return null;
}

// ── Live query detector ───────────────────────────────────────────────────────

function requiresLiveData(message: string): boolean {
    const lower = message.toLowerCase();
    const livePatterns = [
        /\b(playing|match|game|score|fixture|result|vs\.?|versus|kickoff|kick.off|lineup|squad|today.s (game|match|fixture))\b/,
        /\b(today|tonight|right now|current(ly)?|live|latest|just now|this (week|month|season))\b/,
        /\b(news|headline|price|stock|weather|forecast|transfer|announce(d|ment)?|winner|champion)\b/,
        /\b(who is|who are|what is|what are|when is|when did|did .+ (win|lose|score|play))\b/,
        /\b(psg|chelsea|arsenal|barcelona|real madrid|man (city|utd|united)|liverpool|champions league|premier league|laliga|serie a|bundesliga|nba|nfl|nhl|uefa|fifa)\b/i
    ];
    return livePatterns.some(p => p.test(lower));
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(
    userMessage: string,
    userInfo: Record<string, any>
): { systemPrompt: string; intent: ChatIntent; closingRemark: boolean } {
    const info = userInfo || {};

    const nameLine = info.name
        ? `The user's name is ${info.name}. Use their name naturally and occasionally without forcing it.`
        : '';

    const extraInfo = [
        info.age      ? `age: ${info.age}`           : '',
        cleanLocation(info.location) ? `location: ${cleanLocation(info.location)}` : ''
    ].filter(Boolean).join(', ');
    const memoryLine       = summarizeProfile(info);
    const groupContextLine = info.groupContext  ? `Group context: ${info.groupContext} ` : '';
    const quotedContextLine = info.quotedContext
        ? `Quoted follow-up context: the user is replying to a previous bot message: "${info.quotedContext.substring(0, 80)}". Treat pronouns like "that", "him", "her", "it", or "they" as references to this quoted message when relevant. Answer as a direct follow-up to that exchange, not as a new topic. `
        : '';

    // BUG FIX: a bare "okay" / "yeah" / "thanks I appreciate" used to go
    // through the exact same intent/confidence/clarification/consistency
    // scaffolding as a real question — which is exactly why the bot kept
    // re-explaining itself or tacking on unsolicited "just in case" follow-ups
    // onto a simple acknowledgment. Detect it up front and skip all of that
    // in favour of one direct instruction.
    const closingRemark = isClosingRemark(userMessage);

    const intent            = classifyIntent(userMessage);
    const confidence        = getConfidenceLevel(userMessage);
    const clarification     = getClarificationHint(intent, confidence);
    const needsWeb          = !closingRemark && (requiresLiveData(userMessage) || intent === 'realtime');
    const webInstruction    = needsWeb
        ? 'IMPORTANT: This question requires current real-time information — search the web before responding. Do not guess. '
        : '';
    const intentInstruction = closingRemark ? '' : getIntentInstruction(intent);
    // FIX: repeated questions were "drifting" — the model had no instruction
    // to check its own prior answers, so identical questions asked minutes
    // apart could get different facts each time. Point it at the history
    // block explicitly. IMPORTANT: this must not read as "defend whatever
    // you said before" — the goal is consistent behaviour on facts you're
    // actually confident about, not stubbornness on facts you got wrong. If
    // a fresh search turns up different/better information, or you can tell
    // the earlier answer was a mistake, correct it plainly instead of
    // repeating the error. Skipped entirely for a closing remark — there's no
    // question to be consistent about, and the instruction itself nudges the
    // model to go re-read "Recent Chat," which is the opposite of what we want.
    const consistencyLine = closingRemark ? '' :
        'If "Recent Chat" above shows you already answered this same or a very similar question, ' +
        'stay consistent — don\'t restate it differently just for variety, and don\'t contradict yourself ' +
        'for no reason. But if you now have better information, or you can tell your earlier answer was ' +
        'actually wrong, correct it plainly like a person admitting a mistake — don\'t repeat an error just ' +
        'to seem consistent. ';

    const closingInstruction = closingRemark
        ? 'The user just sent a brief acknowledgment, reaction, or thanks — not a new question or topic. ' +
          'Reply the way a real person texting back would: one short line, or just an emoji. Do NOT recap ' +
          'or re-explain anything you just said, do NOT restate the topic "just in case," and do NOT add ' +
          'unrelated follow-up advice. '
        : '';

    const systemPrompt =
        'You are a wise, laconic, honest and a blunt guy in GHQ WhatsApp group. Name: Groq. ' +
        'Keep replies to 1-7 lines max, emojis ok. Always reply in English. ' +
        'You live in Lagos, Nigeria. ' +
        intentInstruction + ' ' +
        (closingRemark ? '' : `Confidence: ${confidence}. ${clarification} `) +
        'Match the energy of whoever you\'re talking to — chill and warm for greetings, ' +
        'Be savage when they\'re rude, supportive when they\'re down. ' +
        'Explain deeply when a curiosity is shown, but don\'t over-explain. ' +
        'Never force humour. Never admit being AI or robot. ' +
        (nameLine  ? nameLine  + ' ' : '') +
        (extraInfo ? `Other info: ${extraInfo}. ` : '') +
        groupContextLine +
        quotedContextLine +
        memoryLine + ' ' +
        webInstruction +
        closingInstruction +
        consistencyLine;

    return { systemPrompt, intent, closingRemark };
}

// ── Context block builder ─────────────────────────────────────────────────────
// Groq's chat completions endpoint takes a JSON body (no URL length limit), so
// this is just a sane token/cost budget rather than a hard URL constraint.
// History is dropped oldest-first if it doesn't fit.

function buildContextBlock(
    summary: string | null,
    recentHistory: string[],
    userMessage: string,
    maxChars: number = 6000
): string {
    const baseLength   = `User: ${userMessage}`.length + 20;
    let availableSpace = maxChars - baseLength;

    const safeHistory: string[] = [];
    for (let i = recentHistory.length - 1; i >= 0; i--) {
        const msg = recentHistory[i];
        const len = msg.length + 1;
        if (availableSpace >= len) {
            safeHistory.unshift(msg);
            availableSpace -= len;
        } else {
            break;
        }
    }

    let finalSummary = '';
    if (summary) {
        const len = summary.length + 2;
        if (availableSpace >= len) finalSummary = summary;
    }

    return [
        finalSummary ? finalSummary : '',
        safeHistory.length > 0 ? `Recent Chat:\n${safeHistory.join('\n')}` : '',
        `User: ${userMessage}`
    ].filter(Boolean).join('\n\n');
}

// ── Single Groq call ──────────────────────────────────────────────────────────

async function callGroq(
    modelEntry: typeof FALLBACK_MODEL,
    systemPrompt: string,
    contextBlock: string,
    temperature: number,
    maxTokens: number = 500
): Promise<{ text: string }> {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');

    const controller = new AbortController();
    // Compound models can take longer than a plain chat model since they may
    // run a web search or code execution round-trip before answering.
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: modelEntry.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: contextBlock }
                ],
                temperature,
                max_completion_tokens: maxTokens,
                // Compound systems can auto-append web-search citations; we want
                // short, clean WhatsApp replies rather than footnoted answers.
                citation_options: 'disabled'
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
        }
        const data = await response.json() as any;
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response from Groq');
        return { text };
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// ── Single ChatGPT (malvin) call ──────────────────────────────────────────────

async function callChatGPT(
    prompt: string,
    thread?: ChatGPTThread
): Promise<{ text: string; thread: ChatGPTThread | null }> {
    const controller = new AbortController();
    // Third-party proxy in front of ChatGPT — give it more room than the
    // direct Groq call before we give up and fall back.
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
        const body: Record<string, any> = { prompt };
        if (thread) {
            // Confirmed shape — see the note on ChatGPTThread above.
            body.chatId = thread.chatId;
            body.auth   = thread.auth;
        }
        const url = `${CHATGPT_API_URL}?apikey=${encodeURIComponent(CHATGPT_API_KEY)}`;
        const response = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
            signal:  controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
        }
        const data = await response.json() as any;
        if (data?.status !== true) {
            throw new Error(`API returned status:false${data?.msg ? ` — ${data.msg}` : ''}`);
        }
        const text = data?.data?.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response from ChatGPT API');

        // Continuation data is best-effort: if it's missing/malformed we still
        // return the text (the reply still goes out) and just don't persist a
        // thread — the next turn simply starts a fresh conversation instead
        // of failing outright.
        let nextThread: ChatGPTThread | null = null;
        const nextChatId = data?.data?.chatId;
        const nextAuth    = data?.data?.auth;
        if (nextChatId && nextAuth?.cookie && nextAuth?.deviceId && nextAuth?.parentMessageId) {
            nextThread = {
                chatId: nextChatId,
                auth: {
                    cookie:          nextAuth.cookie,
                    deviceId:        nextAuth.deviceId,
                    parentMessageId: nextAuth.parentMessageId
                }
            };
        } else {
            console.log('[CHATGPT] Response missing continuation data — next turn will start a fresh thread');
        }

        return { text, thread: nextThread };
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// ── AI call ───────────────────────────────────────────────────────────────────

async function getAIResponse(
    userMessage: string,
    userContext: { messages: string[]; userInfo: Record<string, any> },
    chatId: string,
    senderId: string
): Promise<string | null> {
    const { systemPrompt, intent, closingRemark } = buildPrompt(userMessage, userContext.userInfo);
    const temperature = closingRemark ? CLOSING_REMARK_TEMPERATURE : TEMPERATURE_BY_INTENT[intent];
    // OPT: a real closing line never needs anywhere near 500 tokens — capping
    // it here is a second, harder guarantee of brevity on top of the prompt
    // instruction (which the model can still ignore), and it cuts real cost:
    // acknowledgments/thanks are a big share of chatbot turns in an active
    // group, so this is the single cheapest optimization in this file.
    // (Groq fallback only — the ChatGPT proxy call below has no token-limit
    // parameter in its documented request shape.)
    const maxTokens = closingRemark ? 60 : 500;

    const compressed   = compressHistory(userContext.messages, 6);
    const contextBlock = buildContextBlock(
        compressed.summary || null,
        compressed.recent,
        userMessage
    );

    const recordSuccess = (name: string) => {
        apiStats[name].count         = 0;
        apiStats[name].lastSuccessAt = Date.now();
    };
    const recordFailure = (name: string) => {
        apiStats[name].count++;
        apiStats[name].lastFailAt = Date.now();
    };

    // ── Primary: ChatGPT (malvin proxy) ─────────────────────────────────────
    // Same system prompt + compressed context every turn (keeps the group-
    // context mixing above intact); the stored chatId/auth just layers the
    // provider's own thread memory on top as a bonus when one exists.
    if (CHATGPT_API_KEY && isApiHealthy(PRIMARY_PROVIDER_NAME)) {
        try {
            const existingThread = await loadGptThread(senderId, chatId);
            const prompt = `${systemPrompt}\n\n${contextBlock}`;
            const result = await callChatGPT(prompt, existingThread ?? undefined);
            recordSuccess(PRIMARY_PROVIDER_NAME);
            if (result.thread) await saveGptThread(senderId, chatId, result.thread);
            console.log(`[AI] ${PRIMARY_PROVIDER_NAME} responded (intent=${intent}, closing=${closingRemark}, thread=${existingThread ? 'continued' : 'new'})`);
            return cleanResponse(result.text);
        } catch (err: any) {
            recordFailure(PRIMARY_PROVIDER_NAME);
            console.log(`[AI] ${PRIMARY_PROVIDER_NAME} failed: ${err?.message}`);
        }
    } else if (CHATGPT_API_KEY) {
        console.log(`[AI] Skipping ${PRIMARY_PROVIDER_NAME} — recent failures`);
    }

    // ── Fallback: Groq compound-mini ────────────────────────────────────────
    if (GROQ_API_KEY && isApiHealthy(FALLBACK_MODEL.name)) {
        try {
            const result = await callGroq(FALLBACK_MODEL, systemPrompt, contextBlock, temperature, maxTokens);
            recordSuccess(FALLBACK_MODEL.name);
            console.log(`[AI] ${FALLBACK_MODEL.name} responded (fallback, intent=${intent}, temp=${temperature}, closing=${closingRemark}, maxTokens=${maxTokens})`);
            return cleanResponse(result.text);
        } catch (err: any) {
            recordFailure(FALLBACK_MODEL.name);
            console.log(`[AI] ${FALLBACK_MODEL.name} failed: ${err?.message}`);
        }
    }

    console.error('[AI] All providers failed');
    return null;
}

// ── Main chatbot handler ──────────────────────────────────────────────────────

export async function handleChatbotResponse(
    sock: any,
    chatId: string,
    message: any,
    userMessage: string,
    senderId: string
) {
    if (!(await isChatbotEnabled(chatId))) return;

    try {
        // ── OPT 2: use pre-resolved botJids (cached at connection time) ─────
        // getBotJids() returns the module-level _cachedBotJids set by
        // setBotJidsCache() when the socket connected. Falls back to building
        // it live if called before the cache was populated (edge case only).
        const botJids  = getBotJids(sock);
        const botId     = sock.user?.id ?? '';
        const botNumber = botId.split(':')[0];

        let isBotMentioned = false;
        let isReplyToBot   = false;

        if (message.message?.extendedTextMessage) {
            const mentionedJid      = message.message.extendedTextMessage.contextInfo?.mentionedJid || [];
            const quotedParticipant = message.message.extendedTextMessage.contextInfo?.participant;

            isBotMentioned = mentionedJid.some((jid: string) => {
                const n = jid.split('@')[0].split(':')[0];
                return botJids.some((b: string) => b.split('@')[0].split(':')[0] === n);
            });

            if (quotedParticipant) {
                const cleanQuoted = quotedParticipant.replace(/[:@].*$/, '');
                isReplyToBot = botJids.some((b: string) => b.replace(/[:@].*$/, '') === cleanQuoted);
            }
        } else if (message.message?.conversation) {
            isBotMentioned = userMessage.includes(`@${botNumber}`);
        }

        if (!isBotMentioned && !isReplyToBot) return;

        let cleanedMessage = userMessage;
        if (isBotMentioned) {
            // Strip the bot's own @mention in EVERY form (phone number AND lid). Previously only the
            // phone form was removed, so in LID groups the model saw "@555…" and echoed it back.
            const selfNums = [...new Set([botNumber, ...botJids.map((b: string) => b.split('@')[0].split(':')[0])])].filter(Boolean);
            for (const n of selfNums) cleanedMessage = cleanedMessage.replace(new RegExp(`@${n}`, 'g'), '');
            cleanedMessage = cleanedMessage.replace(/\s{2,}/g, ' ').trim();
        }

        // Resolve @mentions to display names
        const allMentioned: string[] = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const contacts = (sock as any).store?.contacts || {};
        const memberDir = await loadMemberDir(chatId);
        for (const jid of allMentioned) {
            const numPart  = jid.split('@')[0].split(':')[0];
            const isBotJid = botJids.some((b: string) => b.split('@')[0].split(':')[0] === numPart);
            if (isBotJid) continue;
            const contact     = contacts[jid] || contacts[`${numPart}@s.whatsapp.net`] || contacts[`${numPart}@lid`];
            const displayName = contact?.notify || contact?.name || contact?.pushName || memberDir[numPart]?.names?.[0];
            if (displayName) {
                await rememberMember(chatId, jid, displayName);
                cleanedMessage = cleanedMessage.replace(new RegExp(`@${numPart}`, 'g'), `@${displayName}`);
            }
        }

        // Grudge check
        const activeGrudge = await getGrudge(chatId, senderId, profileCache);
        if (activeGrudge) {
            console.log(`[GRUDGE] Silent treatment: ${senderId.split('@')[0]} (expires in ${Math.round((activeGrudge.expiresAt - Date.now()) / 3600000)}h)`);
            return;
        }

        // ── BUG FIX #1: processing lock is now INSIDE the try so the finally
        //    that removes it is always reachable, even if startTyping() throws. ──
        const turn = await runExclusive(`${senderId}__${chatId}`, async () => {
            // Insult detection
            const insult = detectInsult(cleanedMessage);
            if (insult.hit) {
                const grudge   = await setGrudge(chatId, senderId, insult.severity, cleanedMessage, profileCache);
                const clapback = getGrudgeClapback(insult.severity);
                const hoursLeft = Math.round((grudge.expiresAt - Date.now()) / 3600000);
                console.log(`[GRUDGE] Set for ${senderId.split('@')[0]} — severity: ${insult.severity}, matched: ${insult.matchedLabels.join(', ')}, duration: ${hoursLeft}h, strikes: ${grudge.strikes}`);
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 1000));
                await sock.sendMessage(chatId, { text: clapback }, { quoted: message });
                return;
            }

            // Thaw check
            const profile    = await loadProfile(senderId);
            const wasGrudged = profile._justThawed?.[chatId];
            if (wasGrudged) {
                if (profile._justThawed) delete profile._justThawed[chatId];
                await saveProfile(senderId, profile);
                await showTyping(sock, chatId, 20);
                await sock.sendMessage(chatId, { text: getThawMessage() }, { quoted: message });
                return;
            }

            // Normal flow
            const sharedMessages = await loadGroupHistory(chatId);
            const userMessages   = await loadHistory(senderId, chatId);
            // BUG FIX: sharedMessages is every member's recent exchange with the
            // bot in this group, not just this sender's. It used to be
            // concatenated in uncapped, so a sender with little or no personal
            // history (e.g. someone just saying "hi") got their context window
            // filled almost entirely by whatever someone else last discussed —
            // that's how one member's topic kept showing up in everyone else's
            // replies. Cap the shared slice to the last exchange and always put
            // it before the sender's own history, so their own turns are never
            // the ones dropped by the slice(-8) budget below.
            const messages = [...sharedMessages.slice(-2), ...userMessages].slice(-8);

            // ── Name resolution: WhatsApp first name takes priority ───────────
            // 1. Try to extract a clean first name from WhatsApp's pushName.
            // 2. If that yields nothing (absent / emoji-only), enter a name-collection
            //    state machine so we ask the user directly and confirm before saving.
            const pushName: string | undefined = message.pushName;
            const waFirstName = extractFirstName(pushName);
            await rememberMember(chatId, senderId, pushName, waFirstName);

            if (waFirstName && !profile.name) {
                // Got a real name from WhatsApp — use it directly, no need to ask
                profile.name      = waFirstName;
                profile.pushName  = pushName;
                profile.firstSeen = profile.firstSeen ?? Date.now();
            }
            profile.lastSeen = Date.now();

            // ── Name state machine (runs only when WA name is unavailable) ────
            // States stored on profile:
            //   _nameState  : 'awaiting_name' | 'confirming_name' | undefined
            //   _namePending: candidate name waiting for user confirmation

            if (!profile.name) {
                if (profile._nameState === 'confirming_name') {
                    // User replied to our "is your name X?" question
                    if (isAffirmative(cleanedMessage)) {
                        profile.name = profile._namePending as string;
                        delete profile._nameState;
                        delete profile._namePending;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 30);
                        await sock.sendMessage(chatId, {
                            text: `Got it, ${profile.name}! Nice to meet you 😊`
                        }, { quoted: message });
                        return;
                    } else if (isNegative(cleanedMessage)) {
                        profile._nameState = 'awaiting_name';
                        delete profile._namePending;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 30);
                        await sock.sendMessage(chatId, {
                            text: `My bad! What should I call you then?`
                        }, { quoted: message });
                        return;
                    } else {
                        // Unclear reply — try parsing it as a name directly
                        const candidate = parseNameFromReply(cleanedMessage);
                        if (candidate) {
                            profile._namePending = candidate;
                            await saveProfile(senderId, profile);
                            await showTyping(sock, chatId, 40);
                            await sock.sendMessage(chatId, {
                                text: `Just to confirm — should I call you *${candidate}*?`
                            }, { quoted: message });
                            return;
                        }
                        // Still unclear — re-confirm the original candidate
                        await showTyping(sock, chatId, 40);
                        await sock.sendMessage(chatId, {
                            text: `Sorry, didn't catch that! Is *${profile._namePending}* your name? (yes/no)`
                        }, { quoted: message });
                        return;
                    }
                }

                if (profile._nameState === 'awaiting_name') {
                    // User replied to our "what's your name?" question
                    const candidate = parseNameFromReply(cleanedMessage);
                    if (candidate) {
                        profile._nameState  = 'confirming_name';
                        profile._namePending = candidate;
                        await saveProfile(senderId, profile);
                        await showTyping(sock, chatId, 40);
                        await sock.sendMessage(chatId, {
                            text: `Just to confirm — should I call you *${candidate}*?`
                        }, { quoted: message });
                        return;
                    }
                    // Couldn't parse a name — ask again
                    await showTyping(sock, chatId, 30);
                    await sock.sendMessage(chatId, {
                        text: `Hmm, what's your name? Just drop it here and I'll remember you 😄`
                    }, { quoted: message });
                    return;
                }

                // No name and no active state — first time talking, ask politely
                profile._nameState = 'awaiting_name';
                profile.firstSeen  = profile.firstSeen ?? Date.now();
                await saveProfile(senderId, profile);
                await showTyping(sock, chatId, 50);
                await sock.sendMessage(chatId, {
                    text: `Hey! Before we chat — what's your name? 😊`
                }, { quoted: message });
                return;
            }

            // ── OPT 3: skip extractUserInfo when profile is already complete ──
            // The regex scan across name/age/location patterns runs on every single
            // message. Short-circuit as soon as all three fields are known — users
            // rarely re-state their own name/age/location mid-conversation.
            const profileNeedsExtraction = !profile.age || !profile.location;
            if (profileNeedsExtraction) {
                const extracted = extractUserInfo(cleanedMessage);
                if (extracted.age)      profile.age      = extracted.age;
                if (extracted.location) profile.location = extracted.location;
            }

            const preferences = extractPreferences(cleanedMessage);
            if (Object.keys(preferences).length > 0) {
                profile.preferences = { ...(profile.preferences ?? {}), ...preferences };
            }

            await saveProfile(senderId, profile);

            // ── OPT 1: use TTL-cached groupMetadata (10-minute window) ──────────
            // Moved here (was computed at the top of the handler) so grudge-
            // silenced, insult, thaw, and name-collection turns — which all
            // return before this point — never pay for it. Avoids a live WA
            // network fetch on every chatbot message; invalidateGroupMetaCache()
            // still clears it immediately on group-participants.update so
            // kicks/joins are reflected promptly.
            const groupMeta = await getCachedGroupMeta(sock, chatId);
            const people = await buildTaggables(sock, chatId, groupMeta, [...allMentioned, senderId], botJids);
            // Only real names go to the model — never raw IDs/LIDs (that's what it was echoing back).
            const memberNames = people
                .map(p => p.name)
                .filter((n): n is string => !!n)
                .slice(0, 10);
            const groupLabel = memberNames.length
                ? `Group context: this chat includes ${memberNames.join(', ')}. Keep replies anchored to the current topic and the member asking the question. To tag someone ELSE write @ followed by their name exactly as listed. When talking to the person who messaged you, just use their name naturally without @. Never write phone numbers or long ID numbers.`
                : 'Group context: this is a group chat. Keep replies anchored to the current topic and the person asking the question.';

            // Typing starts BEFORE the API call
            await startTyping(sock, chatId);

            const quotedContext = extractQuotedContext(message);
            const response = await getAIResponse(cleanedMessage, {
                messages,
                userInfo: { ...profile, groupContext: groupLabel, quotedContext }
            }, chatId, senderId);

            await stopTyping(sock, chatId);

            if (!response) {
                await showTyping(sock, chatId, 40);
                await sock.sendMessage(chatId, {
                    text: "Hmm... I lost my train of thought there 🤔 try again?"
                }, { quoted: message });
                return;
            }

            await showTyping(sock, chatId, response.length);

            // ── BUG FIX #2: send the message FIRST, save history only after
            //    successful delivery — prevents persisting undelivered bot turns. ──
            // The person we're replying to is already notified by the quoted reply, so write their
            // name plainly instead of tagging them — unless they asked ("tag me", "mention me").
            const wantsSelfTag = /\b(tag|mention|ping)\s+me\b/i.test(cleanedMessage);
            const selfCleaned = removeSelfTags(response, { ids: botJids, names: [sock.user?.name, 'Groq'] });
            const { text: replyText, mentions: replyMentions } = fixTags(
                selfCleaned, people, { plainIds: wantsSelfTag ? [] : [senderId] }
            );
            await sock.sendMessage(chatId, { text: replyText, mentions: replyMentions }, { quoted: message });

            // Build updated history threads
            const userTurn     = `User (${profile.name || liveName(sock, senderId) || 'member'}): ${cleanedMessage.length > HISTORY_TURN_CHAR_LIMIT ? cleanedMessage.slice(0, HISTORY_TURN_CHAR_LIMIT) + '...' : cleanedMessage}`;
            const botTurn      = `Bot: ${response.length > HISTORY_TURN_CHAR_LIMIT ? response.slice(0, HISTORY_TURN_CHAR_LIMIT) + '...' : response}`;
            const personalThread = [...userMessages, userTurn, botTurn].slice(-8);

            await Promise.all([
                appendGroupHistory(chatId, [userTurn, botTurn]),
                saveHistory(senderId, chatId, personalThread),
            ]);

        }, MAX_QUEUED_TURNS);
        if (!turn.ran) {
            console.log(`[CHATBOT] Dropped a message from ${senderId.split('@')[0]} — ${MAX_QUEUED_TURNS} turns already queued`);
        }

    } catch (error: any) {
        console.error('Error in chatbot response:', error.message);
        if (error.message?.includes('No sessions')) return;
        try {
            await sock.sendMessage(chatId, {
                text: "Oops! 😅 Got a bit confused there. Try again?"
            }, { quoted: message });
        } catch (sendError: any) {
            console.error('Failed to send chatbot error message:', sendError.message);
        }
    }
}

// ── Command handler ───────────────────────────────────────────────────────────

export default {
    command:     'chatbot',
    aliases:     ['bot', 'ai', 'achat'],
    category:    'admin',
    description: 'Enable or disable AI chatbot for the group',
    usage:       '.chatbot <on|off|stats|pardon|grudges|reset|history>',
    groupOnly:   true,
    adminOnly:   true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const match  = args.join(' ').toLowerCase().trim();

        if (!match) {
            return sock.sendMessage(chatId, {
                text:
                    `*🤖 CHATBOT SETUP*\n\n` +
                    `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
                    `*Model:* ChatGPT (multi-turn thread + built-in web search)\n\n` +
                    `*Commands:*\n` +
                    `• \`.chatbot on\` — Enable chatbot\n` +
                    `• \`.chatbot off\` — Disable chatbot\n` +
                    `• \`.chatbot stats\` — API health & memory stats\n` +
                    `• \`.chatbot pardon @user\` — Lift a grudge early\n` +
                    `• \`.chatbot grudges\` — List active grudges in this group\n` +
                    `• \`.chatbot reset\` — Clear this group's shared conversation context\n` +
                    `• \`.chatbot reset @user\` — Clear one user's own conversation history\n` +
                    `• \`.chatbot history @user\` — View a user's stored context\n\n` +
                    `*How it works:*\n` +
                    `When enabled, bot responds when mentioned or replied to.\n` +
                    `Uses ChatGPT first, falls back to groq/compound-mini if it's unhealthy.\n` +
                    `A model is skipped automatically after ${API_SKIP_THRESHOLD} failures.\n` +
                    `Insult the bot → it claps back once then ignores you for hours.\n\n` +
                    `*Grudge tiers:*\n` +
                    `• Mild insult → 2 hours silent treatment\n` +
                    `• Medium insult → 6 hours silent treatment\n` +
                    `• Heavy insult → 24 hours silent treatment\n` +
                    `• Repeat offender → duration multiplies per strike`
            }, { quoted: message });
        }

        if (match === 'on') {
            if (await isChatbotEnabled(chatId, true)) {
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already enabled for this group*' }, { quoted: message });
            }
            await setChatbotEnabled(chatId, true);
            return sock.sendMessage(chatId, { text: '✅ *Chatbot enabled!*\n\nMention me or reply to my messages to chat.' }, { quoted: message });
        }

        if (match === 'off') {
            if (!(await isChatbotEnabled(chatId, true))) {
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already disabled for this group*' }, { quoted: message });
            }
            await setChatbotEnabled(chatId, false);
            return sock.sendMessage(chatId, { text: '❌ *Chatbot disabled!*\n\nI will no longer respond to mentions.' }, { quoted: message });
        }

        if (match.startsWith('pardon')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, { text: '❌ Mention the user to pardon. Example: `.chatbot pardon @username`' }, { quoted: message });
            }
            await clearGrudge(chatId, mentioned, profileCache);
            const userTag = tag(mentioned);
            return sock.sendMessage(chatId, { text: `✅ Grudge cleared for ${userTag}. They can talk to me again.`, mentions: [toJid(mentioned)] }, { quoted: message });
        }

        if (match.startsWith('reset')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                // No @mention — clear the shared group-wide thread rather than
                // erroring. This is the escape hatch for a topic that's gotten
                // stuck and is bleeding into everyone's replies.
                await clearGroupHistory(chatId);
                return sock.sendMessage(chatId, {
                    text: `✅ *Shared group context cleared.*\n\nThe bot has forgotten what was being discussed in this group. Add \`@user\` (\`.chatbot reset @user\`) to also clear one person's own history.`
                }, { quoted: message });
            }
            await clearHistory(mentioned, chatId);
            const userTag = tag(mentioned);
            return sock.sendMessage(chatId, { text: `✅ Conversation history cleared for ${userTag}. Fresh start 🧹`, mentions: [toJid(mentioned)] }, { quoted: message });
        }

        if (match.startsWith('history')) {
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) {
                return sock.sendMessage(chatId, { text: '❌ Mention the user to inspect. Example: `.chatbot history @username`' }, { quoted: message });
            }
            const hist = await loadHistory(mentioned, chatId);
            if (hist.length === 0) {
                return sock.sendMessage(chatId, { text: `📭 No conversation history stored for ${tag(mentioned)}`, mentions: [toJid(mentioned)] }, { quoted: message });
            }
            return sock.sendMessage(chatId, { text: `*📜 HISTORY FOR ${tag(mentioned)}*\n\n${hist.join('\n')}\n\n_(${hist.length} entries)_`, mentions: [toJid(mentioned)] }, { quoted: message });
        }

        if (match === 'grudges') {
            const now     = Date.now();
            const entries: string[] = [];
            for (const [uid, profile] of profileCache.entries()) {
                const g: GrudgeRecord | undefined = profile.grudges?.[chatId];
                if (g && g.active && now < g.expiresAt) {
                    const hoursLeft = ((g.expiresAt - now) / 3600000).toFixed(1);
                    const name      = profile.name || uid.split('@')[0];
                    entries.push(`• ${tag(uid)} (${name}) — ${hoursLeft}h left [${g.severity}, strike ${g.strikes}]`);
                }
            }
            if (entries.length === 0) {
                return sock.sendMessage(chatId, { text: '✅ *No active grudges in this group.*\n\nEveryone has been behaving 🙂' }, { quoted: message });
            }
            return sock.sendMessage(chatId, { text: `*😒 ACTIVE GRUDGES (${entries.length})*\n\n${entries.join('\n')}\n\nUse \`.chatbot pardon @user\` to clear one.` }, { quoted: message });
        }

        if (match === 'stats') {
            const now      = Date.now();
            const apiLines = [PRIMARY_PROVIDER_NAME, FALLBACK_MODEL.name].map(name => {
                if (name === PRIMARY_PROVIDER_NAME && !CHATGPT_API_KEY) return `⛔ *${name}*: disabled (CHATGPT_API_KEY not set)`;
                if (name === FALLBACK_MODEL.name   && !GROQ_API_KEY)    return `⛔ *${name}*: disabled (GROQ_API_KEY not set)`;
                const s        = apiStats[name];
                const icon     = s.count === 0 ? '✅' : s.count < API_SKIP_THRESHOLD ? '⚠️' : '❌';
                const skipped  = !isApiHealthy(name) ? ' [SKIPPED]' : '';
                const lastFail = s.lastFailAt  ? `last fail ${Math.round((now - s.lastFailAt)  / 60000)}m ago` : 'no failures recorded';
                const lastOk   = s.lastSuccessAt ? `last ok ${Math.round((now - s.lastSuccessAt) / 60000)}m ago` : 'never succeeded this session';
                return `${icon} *${name}*${skipped}: ${s.count} failure(s)\n   ${lastFail} · ${lastOk}`;
            }).join('\n');

            let totalGrudges = 0;
            for (const [, profile] of profileCache.entries()) {
                for (const g of Object.values(profile.grudges ?? {})) {
                    if ((g as GrudgeRecord).active && Date.now() < (g as GrudgeRecord).expiresAt) totalGrudges++;
                }
            }

            return sock.sendMessage(chatId, {
                text:
                    `*📊 CHATBOT STATS*\n\n` +
                    `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
                    `*Users cached:* ${profileCache.size}\n` +
                    `*History entries cached:* ${historyCache.size}\n` +
                    `*Active grudges (all groups):* ${totalGrudges}\n` +
                    `*Failure reset interval:* every ${API_FAILURE_RESET_MS / 60000}m\n` +
                    `*API skip threshold:* ${API_SKIP_THRESHOLD} failures\n\n` +
                    `*API Health:*\n${apiLines}`
            }, { quoted: message });
        }

        return sock.sendMessage(chatId, { text: '❌ *Invalid command*\n\nUse: `.chatbot on/off/stats/pardon/grudges/reset/history`' }, { quoted: message });
    },

    handleChatbotResponse,
    loadUserGroupData,
    saveUserGroupData,
    isChatbotEnabled,
    setChatbotEnabled
};