import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';

/**
 * plugins/autorob.ts  (runs on your PERSONAL bot, not the Groq bot)
 *
 * Watches the group for the Groq bot's transaction confirmations. When one shows that a
 * watched member just got coins into their wallet (transfer received, bank withdrawal, ...),
 * it sends "<prefix>rob @them" as a real message, so the Groq bot runs its normal rob command
 * for you. Nothing here touches the economy directly.
 *
 * Hook it up by calling handleAutoRobDetection(sock, chatId, message) from the same place
 * handleMentionDetection is called.
 *
 * Commands (owner only):
 *   .autorob on | off
 *   .autorob status
 *   .autorob bot [number]       add the Groq bot's id (or reply to one of its messages)
 *   .autorob target [number]    add the person to watch (or reply to one of their messages)
 *   .autorob remove <number>    remove one target (or reply to their message)
 *   .autorob remove bot <number> remove one Groq bot id
 *   .autorob clear bot|target   remove everything in that list
 *   .autorob here | anywhere    only act in this group / in any group
 *   .autorob prefix <p>         the Groq bot's command prefix (default ".")
 *   .autorob cooldown <sec>     minimum gap between auto-robs (default 20)
 *   .autorob cap <n>            max auto-robs per hour (default 15)
 *   .autorob debug on | off     log what the plugin sees from the Groq bot
 */

const HAS_DB = !!(process.env.MONGO_URL || process.env.POSTGRES_URL || process.env.MYSQL_URL || process.env.DB_URL);
const stateFilePath = dataFile('autorob.json');

interface AutoRobState {
    enabled: boolean;
    botIds: string[];     // Groq bot's id(s): phone number and/or @lid user part
    targetIds: string[];  // watched member's id(s): phone number and/or @lid user part
    prefix: string;
    groupId: string;      // '' = any group
    cooldownSec: number;
    maxPerHour: number;
    debug: boolean;
}

const DEFAULTS: AutoRobState = {
    enabled: false,
    botIds: [],
    targetIds: [],
    prefix: process.env.GROQ_BOT_PREFIX || '.',
    groupId: '',
    cooldownSec: 20,
    maxPerHour: 20,
    debug: false,
};

/**
 * Which confirmations count as "coins just landed in their wallet".
 *   via 'mention' = the watched person is tagged in the confirmation (they are the recipient)
 *   via 'sender'  = the confirmation quotes the watched person's own command message
 * A transfer confirmation quotes the SENDER, so it deliberately uses 'mention' only: if the
 * watched person is the one giving coins away, their wallet just got lighter.
 * Add more rules here once you see the exact wording (slot wins, exchanges, ...).
 */
const RULES: { name: string; re: RegExp; via: Array<'mention' | 'sender'> }[] = [
    { name: 'transfer received', re: /TRANSFER SUCCESSFUL/i, via: ['mention'] },
    { name: 'bank withdrawal', re: /\bWithdrew\b/i, via: ['sender'] },
    // { name: 'slot win', re: /YOUR_SLOT_WIN_WORDING/i, via: ['sender'] },
];

// Never react to the Groq bot's own rob replies (stops any feedback loop).
const IGNORE = /ROBBERY|BUSTED|took the hit|\brob\b/i;

// ── State (cached so a busy group doesn't hit the DB on every message) ──────

let cache: { at: number; state: AutoRobState } | null = null;
const CACHE_MS = 5000;

async function loadState(): Promise<AutoRobState> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.state;
    let raw: any = null;
    try {
        if (HAS_DB) raw = await store.getSetting('global', 'autorob');
        else raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    } catch { /* first run */ }
    const state: AutoRobState = { ...DEFAULTS, ...(raw || {}) };
    cache = { at: Date.now(), state };
    return state;
}

async function saveState(state: AutoRobState) {
    cache = { at: Date.now(), state };
    if (HAS_DB) {
        await store.saveSetting('global', 'autorob', state);
    } else {
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const userPart = (jid: any): string => String(jid || '').split('@')[0].split(':')[0];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function unwrap(m: any): any {
    let cur = m || {};
    for (let i = 0; i < 4; i++) {
        const inner = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message ||
            cur.viewOnceMessageV2?.message || cur.documentWithCaptionMessage?.message;
        if (!inner) break;
        cur = inner;
    }
    return cur;
}

function textOf(msg: any): string {
    return String(
        msg.conversation || msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption || msg.videoMessage?.caption || ''
    );
}

/** Every contextInfo on the message, whatever its type (text, image, button reply...). */
function contextsOf(msg: any): any[] {
    return Object.values(msg).filter((v: any) => v && typeof v === 'object' && (v as any).contextInfo).map((v: any) => v.contextInfo);
}

const seen = new Set<string>();
const fired: number[] = [];
let lastFire = 0;

// ── Detection (call this for every incoming message) ────────────────────────

export async function handleAutoRobDetection(sock: any, chatId: any, message: any) {
    try {
        if (message?.key?.fromMe) return;
        if (!chatId?.endsWith('@g.us')) return;

        const state = await loadState();
        if (!state.enabled || !state.botIds.length || !state.targetIds.length) return;
        if (state.groupId && state.groupId !== chatId) return;

        const sender = userPart(message.key?.participant);
        if (!state.botIds.includes(sender)) return;

        const msgId = message.key?.id;
        if (msgId) {
            if (seen.has(msgId)) return;
            seen.add(msgId);
            if (seen.size > 300) seen.delete(seen.values().next().value as string);
        }

        const msg = unwrap(message.message);
        const text = textOf(msg);
        if (!text || IGNORE.test(text)) return;

        const contexts = contextsOf(msg);
        const mentioned: string[] = contexts.flatMap(c => Array.isArray(c.mentionedJid) ? c.mentionedJid : []);
        const quotedFrom: string = contexts.map(c => c.participant).find(Boolean) || '';

        if (state.debug) {
            console.log('[autorob] groq msg:', JSON.stringify({ text: text.slice(0, 80), mentioned, quotedFrom }));
        }

        const rule = RULES.find(r => r.re.test(text));
        if (!rule) return;

        const targets = new Set(state.targetIds);
        let hit = '';
        if (rule.via.includes('mention')) hit = mentioned.find(j => targets.has(userPart(j))) || '';
        if (!hit && rule.via.includes('sender') && quotedFrom && targets.has(userPart(quotedFrom))) hit = quotedFrom;
        if (!hit) return;

        // Safety rails: minimum gap + hourly cap, so a burst of confirmations can't drain your bail coins.
        const now = Date.now();
        if (now - lastFire < state.cooldownSec * 1000) return;
        while (fired.length && now - fired[0] > 3600_000) fired.shift();
        if (fired.length >= state.maxPerHour) return;
        lastFire = now;
        fired.push(now);

        await sleep(700 + Math.random() * 700);
        await sock.sendMessage(chatId, {
            text: `${state.prefix}rob @${userPart(hit)}`,
            mentions: [hit],
        });
        console.log(`[autorob] fired on ${userPart(hit)} (${rule.name})`);
    } catch (err: any) {
        console.error('handleAutoRobDetection error:', err);
    }
}

// ── Command ─────────────────────────────────────────────────────────────────

function idsFromInput(message: any, args: string[]): string[] {
    const ids = new Set<string>();
    const quoted = message.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) ids.add(userPart(quoted));
    for (const a of args) {
        const digits = a.replace(/[^\d]/g, '');
        if (digits.length >= 7) ids.add(digits);
    }
    return [...ids];
}

async function command(sock: any, message: any, args: string[], context: BotContext) {
    const chatId = (context as any).chatId || message.key.remoteJid;
    const say = (text: string) => sock.sendMessage(chatId, { text }, { quoted: message });
    const state = await loadState();
    const sub = (args[0] || 'status').toLowerCase();
    const rest = args.slice(1);

    if (sub === 'on' || sub === 'off') {
        if (sub === 'on' && (!state.botIds.length || !state.targetIds.length)) {
            return say(`❌ Set both first:\n• *.autorob bot* (reply to a Groq bot message)\n• *.autorob target* (reply to the person's message, or give their number)`);
        }
        state.enabled = sub === 'on';
        await saveState(state);
        return say(`✅ Auto-rob *${state.enabled ? 'ON' : 'OFF'}*`);
    }

    if (sub === 'bot' || sub === 'target') {
        const ids = idsFromInput(message, rest);
        if (!ids.length) return say(`❌ Reply to one of their messages, or give a number: *.autorob ${sub} 234xxxxxxxxxx*`);
        const key = sub === 'bot' ? 'botIds' : 'targetIds';
        state[key] = [...new Set([...state[key], ...ids])];
        await saveState(state);
        return say(`✅ ${sub === 'bot' ? 'Groq bot' : 'Target'} ids: ${state[key].join(', ')}\n_Add the number and the reply-captured id; WhatsApp may show either._`);
    }

    if (sub === 'clear') {
        const which = (rest[0] || '').toLowerCase();
        if (which !== 'bot' && which !== 'target') return say('❌ Usage: *.autorob clear bot|target*');
        state[which === 'bot' ? 'botIds' : 'targetIds'] = [];
        state.enabled = false;
        await saveState(state);
        return say(`✅ Cleared ${which}. Auto-rob switched *OFF*.`);
    }

    if (sub === 'remove') {
        const which = (rest[0] || '').toLowerCase();
        const kind = which === 'bot' ? 'botIds' : 'targetIds';
        const ids = idsFromInput(message, which === 'bot' || which === 'target' ? rest.slice(1) : rest);
        if (!ids.length) return say(`❌ Usage: *.autorob remove 234xxxxxxxxxx* (or reply to their message)\nFor the Groq bot: *.autorob remove bot <number>*`);
        const before = state[kind].length;
        state[kind] = state[kind].filter(id => !ids.includes(id));
        if (state[kind].length === before) {
            return say(`❌ Not in the list. Current ${kind === 'botIds' ? 'bot ids' : 'targets'}: ${state[kind].join(', ') || '—'}`);
        }
        if (!state.botIds.length || !state.targetIds.length) state.enabled = false;
        await saveState(state);
        return say(`✅ Removed. ${kind === 'botIds' ? 'Bot ids' : 'Targets'} now: ${state[kind].join(', ') || '—'}${state.enabled ? '' : '\n_Auto-rob is OFF until both lists have an id._'}`);
    }

    if (sub === 'here' || sub === 'anywhere') {
        state.groupId = sub === 'here' ? chatId : '';
        await saveState(state);
        return say(sub === 'here' ? '✅ Only acting in this group.' : '✅ Acting in any group the Groq bot is in.');
    }

    if (sub === 'prefix') {
        if (!rest[0]) return say('❌ Usage: *.autorob prefix <p>*');
        state.prefix = rest[0];
        await saveState(state);
        return say(`✅ Groq bot prefix: *${state.prefix}*`);
    }

    if (sub === 'cooldown' || sub === 'cap') {
        const n = parseInt(rest[0], 10);
        if (!Number.isFinite(n) || n < 1) return say(`❌ Usage: *.autorob ${sub} <number>*`);
        if (sub === 'cooldown') state.cooldownSec = n; else state.maxPerHour = n;
        await saveState(state);
        return say(`✅ ${sub === 'cooldown' ? `Cooldown: ${n}s` : `Max per hour: ${n}`}`);
    }

    if (sub === 'debug') {
        state.debug = (rest[0] || '').toLowerCase() === 'on';
        await saveState(state);
        return say(`✅ Debug logging *${state.debug ? 'ON' : 'OFF'}*`);
    }

    return say(
        `🎯 *AUTO-ROB*\n\n` +
        `Status: *${state.enabled ? 'ON' : 'OFF'}*\n` +
        `Groq bot ids: ${state.botIds.join(', ') || '—'}\n` +
        `Targets: ${state.targetIds.join(', ') || '—'}\n` +
        `Prefix: *${state.prefix}*  ·  Group: ${state.groupId || 'any'}\n` +
        `Cooldown: ${state.cooldownSec}s  ·  Cap: ${state.maxPerHour}/hr  ·  Debug: ${state.debug ? 'on' : 'off'}\n\n` +
        `Triggers: ${RULES.map(r => r.name).join(', ')}`
    );
}

export default {
    command: 'autorob',
    aliases: ['autorobber'],
    category: 'owner',
    description: 'Auto-rob a watched member right after the Groq bot confirms they received coins',
    usage: '.autorob on|off | bot | target | status',
    ownerOnly: true,

    handler: command,
    handleAutoRobDetection,
};
