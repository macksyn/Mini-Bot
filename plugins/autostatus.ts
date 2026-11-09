import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;
const HAS_DB       = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const configPath = dataFile('autoStatus.json');

if (!HAS_DB && !fs.existsSync(configPath)) {
    if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify({
        enabled:    false,
        reactOn:    false,
        filterMode: 'none',
        filterList: []
    }, null, 2));
}

const channelInfo = {
    contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid:   '120363319098372999@newsletter',
            newsletterName:  'GlobalTechInc',
            serverMessageId: -1
        }
    }
};

// ── De-duplicate triggers ─────────────────────────────────────────────────────
// Both messages.upsert AND status.update fire for the same status in Baileys.
// Without dedup, every status is processed twice — and if one path bypasses
// the filter, the status gets viewed regardless. We track message IDs so only
// the first arrival is acted on.
const _processedStatusIds = new Map<string, number>();
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of _processedStatusIds) {
        if (now - ts > 5 * 60 * 1000) _processedStatusIds.delete(id);
    }
}, 60_000);

// ── LID pre-fetch ─────────────────────────────────────────────────────────────
// In newer WhatsApp, status senders arrive only as @lid JIDs — the contact store
// never contains the phone↔LID mapping. sock.onWhatsApp(phone) is the only
// reliable way to resolve phone → LID. We run it once per session for the whole
// filter list, and again whenever the list changes.
let _lidsFetched = false;

export function resetLidFetchFlag() { _lidsFetched = false; }

async function prefetchFilterLids(sock: any): Promise<void> {
    if (_lidsFetched) return;
    _lidsFetched = true;

    const cfg = await readConfig();
    if (!cfg.filterList.length || cfg.filterMode === 'none') return;

    console.log(`[autostatus] 🔍 Resolving LIDs for ${cfg.filterList.length} filter entries via signalRepository...`);
    await fetchAndStoreLids(sock, cfg.filterList);
}

async function fetchAndStoreLids(sock: any, phones: string[]): Promise<void> {
    const lidMapping = (sock as any)?.signalRepository?.lidMapping;
    if (!lidMapping) {
        console.log('[autostatus] ⚠️ signalRepository.lidMapping not available on sock');
        return;
    }

    for (const phone of phones) {
        const cleanPhone = cleanNumber(phone);
        if (!cleanPhone || cleanPhone.length < 7) continue;
        const phoneJid = `${cleanPhone}@s.whatsapp.net`;
        try {
            // getLIDsForPNs checks cache → DB → USync API (network) and STORES the result
            // persistently in auth.keys, so getPNForLID can reverse-look it up later.
            const result = await lidMapping.getLIDsForPNs([phoneJid]);
            if (Array.isArray(result) && result.length > 0 && result[0]?.lid) {
                const lidNum = (result[0].lid as string).split('@')[0].split(':')[0];
                if ((sock as any)?.store?.lidToPhone) {
                    (sock as any).store.lidToPhone[lidNum] = cleanPhone;
                }
                console.log(`[autostatus] ✅ LID resolved via signalRepository: ${cleanPhone} → ${lidNum}`);
            } else {
                console.log(`[autostatus] ℹ️ No LID returned for ${cleanPhone} (result: ${JSON.stringify(result)})`);
            }
        } catch (e: any) {
            console.log(`[autostatus] ⚠️ getLIDsForPNs(${cleanPhone}) failed: ${e.message}`);
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip everything from a raw JID/number, returning only digits. */
function cleanNumber(raw: string): string {
    if (!raw) return '';
    return raw
        .split('@')[0]   // drop @server suffix first
        .split(':')[0]   // drop :device suffix (e.g. :0, :13)
        .replace(/\D/g, '');
}

/**
 * Resolve a JID to a plain phone number string.
 *
 * Newer WhatsApp/Baileys versions send status events with @lid JIDs instead
 * of @s.whatsapp.net. We mirror the exact same lookup used in messageHandler.ts:
 *   1. Normalise the JID with sock.decodeJid (strips the :device suffix).
 *   2. Scan sock.store.contacts for an entry whose .lid field matches.
 *   3. If the matching key is a @s.whatsapp.net JID, extract the phone number.
 *
 * Returns an empty string when resolution fails so callers know the number is
 * unknown — returning raw LID digits would silently break filter comparisons.
 */
async function resolvePhoneNumber(rawJid: string, sock: any): Promise<string> {
    if (!rawJid) return '';

    // Already a normal phone JID — just extract digits
    if (rawJid.includes('@s.whatsapp.net')) {
        return cleanNumber(rawJid);
    }

    if (!rawJid.includes('@lid')) {
        return cleanNumber(rawJid);
    }

    const lidNumeric = rawJid.split('@')[0].split(':')[0];
    const normalizedLid: string = sock?.decodeJid ? sock.decodeJid(rawJid) : rawJid;

    // ── 1. Baileys' own signalRepository.lidMapping (most authoritative) ──────
    // Populated by getLIDsForPNs (USync API) which we call for every filter-list
    // entry. getPNForLID does cache → DB lookup and returns the phone JID.
    const lidMapping = (sock as any)?.signalRepository?.lidMapping;
    if (lidMapping) {
        try {
            const pnJid: string | null = await lidMapping.getPNForLID(rawJid);
            if (pnJid) {
                const phone = cleanNumber(pnJid);
                if (phone) {
                    if ((sock as any)?.store?.lidToPhone) (sock as any).store.lidToPhone[lidNumeric] = phone;
                    return phone;
                }
            }
        } catch (_) { /* ignore */ }
    }

    // ── 2. Fast path: lidToPhone map (populated from contacts/groups events) ──
    const lidToPhone: Record<string, string> = (sock as any)?.store?.lidToPhone || {};
    const fromMap = lidToPhone[lidNumeric] || lidToPhone[normalizedLid] || lidToPhone[rawJid];
    if (fromMap) return cleanNumber(fromMap);

    // ── 3. Scan contacts for one whose .lid field matches ────────────────────
    const contacts: Record<string, any> = (sock as any)?.store?.contacts || store?.contacts || {};
    const resolvedKey = Object.keys(contacts).find(k => {
        const lid = contacts[k]?.lid;
        if (!lid) return false;
        return lid === normalizedLid || lid === rawJid || lid.split(':')[0] === rawJid.split('@')[0];
    });
    if (resolvedKey?.includes('@s.whatsapp.net')) {
        if ((sock as any)?.store?.lidToPhone) (sock as any).store.lidToPhone[lidNumeric] = resolvedKey.split('@')[0];
        return cleanNumber(resolvedKey);
    }

    console.log(`[autostatus] ⚠️ Cannot resolve @lid → phone for: ${rawJid}`);
    return '';
}

/**
 * Extract the sender JID from whatever shape the Baileys status event arrives in.
 * Returns null if the event isn't a status broadcast we should act on.
 */
function extractSenderJid(status: any): string | null {
    // Shape 1: messages.upsert chatUpdate → { messages: [...], type: '...' }
    if (Array.isArray(status?.messages) && status.messages.length > 0) {
        const msg = status.messages[0];
        if (msg?.key?.remoteJid === 'status@broadcast') {
            return msg.key.participant || null;
        }
    }

    // Shape 2: status.update event → array of WAMessage directly
    if (Array.isArray(status) && status.length > 0) {
        const msg = status[0];
        if (msg?.key?.remoteJid === 'status@broadcast') {
            return msg.key.participant || null;
        }
    }

    // Shape 3: bare message key
    if (status?.key?.remoteJid === 'status@broadcast') {
        return status.key.participant || null;
    }

    // Shape 4: reaction event
    if (status?.reaction?.key?.remoteJid === 'status@broadcast') {
        return status.reaction.key.participant || null;
    }

    return null;
}

/** Extract the message ID for dedup. */
function extractStatusId(status: any): string | null {
    if (Array.isArray(status?.messages) && status.messages[0]?.key?.id) return status.messages[0].key.id;
    if (Array.isArray(status) && status[0]?.key?.id) return status[0].key.id;
    if (status?.key?.id) return status.key.id;
    if (status?.reaction?.key?.id) return status.reaction.key.id;
    return null;
}

/** Extract the actual message key for readMessages / react calls. */
function extractMessageKey(status: any): any | null {
    if (Array.isArray(status?.messages) && status.messages[0]?.key) return status.messages[0].key;
    if (Array.isArray(status) && status[0]?.key) return status[0].key;
    if (status?.key) return status.key;
    if (status?.reaction?.key) return status.reaction.key;
    return null;
}

// ── Config helpers ────────────────────────────────────────────────────────────

async function readConfig() {
    try {
        let raw: any = null;
        if (HAS_DB) {
            raw = await store.getSetting('global', 'autoStatus');
        } else {
            raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        // Always normalise — handles configs saved before filterMode/filterList existed
        return {
            enabled:    !!(raw?.enabled),
            reactOn:    !!(raw?.reactOn),
            filterMode: (raw?.filterMode as string) || 'none',
            filterList: Array.isArray(raw?.filterList) ? (raw.filterList as string[]) : []
        };
    } catch {
        return { enabled: false, reactOn: false, filterMode: 'none', filterList: [] as string[] };
    }
}

async function writeConfig(cfg: any) {
    try {
        if (HAS_DB) {
            await store.saveSetting('global', 'autoStatus', cfg);
        } else {
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        }
    } catch (error: any) {
        console.error('[autostatus] Error writing config:', error);
    }
}

// ── Filter logic ──────────────────────────────────────────────────────────────

/**
 * Decide whether the bot should view/react to this sender's status.
 *
 * filterMode = 'none'       → view everyone
 * filterMode = 'whitelist'  → view ONLY numbers in filterList
 * filterMode = 'blacklist'  → view everyone EXCEPT numbers in filterList
 *
 * If phoneNum is empty (unresolvable @lid):
 *   blacklist → allow  (unknown, safer to view)
 *   whitelist → deny   (unknown, not on whitelist)
 *
 * When the sender arrives as a @lid JID and the store lookup fails, we also
 * do a reverse lookup: for every phone number in the filter list we find their
 * contact entry and compare their stored LID against the sender's LID.
 */
async function shouldViewStatus(
    phoneNum: string,
    rawSenderJid?: string,
    sock?: any
): Promise<boolean> {
    const cfg = await readConfig();
    if (!cfg.enabled) return false;
    if (!cfg.filterMode || cfg.filterMode === 'none') return true;

    // ── Direct phone-number match ─────────────────────────────────────────────
    // resolvePhoneNumber now returns '' when it can't resolve — never LID digits —
    // so a non-empty phoneNum here is always a real phone number.
    if (phoneNum) {
        const inList = cfg.filterList.some(n => cleanNumber(n) === phoneNum);
        if (cfg.filterMode === 'whitelist') return inList;
        if (cfg.filterMode === 'blacklist') return !inList;
    }

    // ── Phone resolution failed — sender arrived as unresolvable @lid ─────────
    // Safe defaults: blacklist → allow (unknown contact, safer to view);
    //                whitelist → deny  (unknown contact, not on the list).
    console.log(`[autostatus] ⚠️ Filter applied with unresolved sender: ${rawSenderJid}`);
    return cfg.filterMode === 'blacklist';
}

// ── Status reaction ───────────────────────────────────────────────────────────

async function reactToStatus(sock: any, key: any) {
    try {
        const cfg = await readConfig();
        if (!cfg.reactOn) return;

        await sock.relayMessage(
            'status@broadcast',
            {
                reactionMessage: {
                    key: {
                        remoteJid:   'status@broadcast',
                        id:          key.id,
                        participant: key.participant || key.remoteJid,
                        fromMe:      false
                    },
                    text: '💚'
                }
            },
            {
                messageId:     key.id,
                statusJidList: [key.remoteJid, key.participant || key.remoteJid]
            }
        );
        console.log('[autostatus] ✅ Reacted to status');
    } catch (error: any) {
        console.error('[autostatus] ❌ React error:', error.message);
    }
}

// ── Main status handler ───────────────────────────────────────────────────────

async function handleStatusUpdate(sock: any, status: any) {
    try {
        // 1. De-duplicate — both messages.upsert and status.update fire for the
        //    same status; we must only act on the first one that arrives.
        const msgId = extractStatusId(status);
        if (msgId) {
            if (_processedStatusIds.has(msgId)) return;
            _processedStatusIds.set(msgId, Date.now());
        }

        // 2. Extract sender JID
        const rawSenderJid = extractSenderJid(status);
        if (!rawSenderJid) return;

        // 3. Ensure filter list LIDs are pre-fetched (once per session)
        await prefetchFilterLids(sock);

        // 4. Resolve @lid to real phone number
        const phoneNum = await resolvePhoneNumber(rawSenderJid, sock);
        console.log(`[autostatus] 📲 Status from: ${phoneNum || rawSenderJid}`);

        // 5. Apply filter
        const allowed = await shouldViewStatus(phoneNum, rawSenderJid, sock);
        if (!allowed) {
            console.log(`[autostatus] ⏭️ Skipped (filtered): ${phoneNum || rawSenderJid}`);
            return;
        }

        // 5. View + react
        const key = extractMessageKey(status);
        if (!key) return;

        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            await sock.readMessages([key]);
            console.log(`[autostatus] ✅ Viewed status from: ${phoneNum || rawSenderJid}`);
            await reactToStatus(sock, key);
        } catch (err: any) {
            if (err.message?.includes('rate-overlimit')) {
                await new Promise(r => setTimeout(r, 2000));
                await sock.readMessages([key]);
            } else {
                throw err;
            }
        }

    } catch (error: any) {
        console.error('[autostatus] ❌ handleStatusUpdate error:', error.message);
    }
}

// ── Command handler ───────────────────────────────────────────────────────────

export default {
    command: 'autostatus',
    aliases: ['autoview', 'statusview'],
    category: 'owner',
    description: 'Automatically view and react to WhatsApp statuses with optional filter',
    usage: '.autostatus <on|off|react on|react off|whitelist|blacklist|add|remove|list|reset>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: string[], context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;

        try {
            const cfg = await readConfig();

            // ── No args → show current settings ──────────────────────────────
            if (!args || args.length === 0) {
                const viewLabel  = cfg.enabled ? '✅ Enabled'  : '❌ Disabled';
                const reactLabel = cfg.reactOn  ? '✅ Enabled'  : '❌ Disabled';
                const modeLabel  =
                    cfg.filterMode === 'whitelist' ? `✅ Whitelist (${cfg.filterList.length} contacts)` :
                    cfg.filterMode === 'blacklist' ? `🚫 Blacklist (${cfg.filterList.length} contacts)` :
                    '🌐 None (view everyone)';

                return await sock.sendMessage(chatId, {
                    text:
                        `🔄 *Auto Status Settings*\n\n` +
                        `📱 *Auto View:*    ${viewLabel}\n` +
                        `💫 *Auto React:*   ${reactLabel}\n` +
                        `🎯 *Filter Mode:*  ${modeLabel}\n\n` +
                        `*── Toggle ──*\n` +
                        `• \`.autostatus on/off\`           — Enable/disable auto view\n` +
                        `• \`.autostatus react on/off\`     — Enable/disable reactions\n\n` +
                        `*── Filter Mode ──*\n` +
                        `• \`.autostatus whitelist\`         — View ONLY listed contacts\n` +
                        `• \`.autostatus blacklist\`         — Skip listed contacts\n` +
                        `• \`.autostatus reset\`             — Remove all filters\n\n` +
                        `*── Manage List ──*\n` +
                        `• \`.autostatus add 2348012345678\`    — Add number\n` +
                        `• \`.autostatus remove 2348012345678\` — Remove number\n` +
                        `• \`.autostatus list\`                 — Show filter list`,
                    ...channelInfo
                }, { quoted: message });
            }

            const cmd  = args[0].toLowerCase();
            const arg2 = args[1]?.toLowerCase();

            // ── on / off ──────────────────────────────────────────────────────
            if (cmd === 'on') {
                cfg.enabled = true;
                await writeConfig(cfg);
                return await sock.sendMessage(chatId, {
                    text: '✅ *Auto status view enabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            if (cmd === 'off') {
                cfg.enabled = false;
                await writeConfig(cfg);
                return await sock.sendMessage(chatId, {
                    text: '❌ *Auto status view disabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── react on / off ────────────────────────────────────────────────
            if (cmd === 'react') {
                if (!arg2 || !['on', 'off'].includes(arg2)) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Usage: `.autostatus react on` or `.autostatus react off`',
                        ...channelInfo
                    }, { quoted: message });
                }
                cfg.reactOn = arg2 === 'on';
                await writeConfig(cfg);
                return await sock.sendMessage(chatId, {
                    text: cfg.reactOn
                        ? '💫 *Status reactions enabled!* Bot will react with 💚'
                        : '❌ *Status reactions disabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── whitelist / blacklist ─────────────────────────────────────────
            if (cmd === 'whitelist' || cmd === 'blacklist') {
                cfg.filterMode = cmd;
                await writeConfig(cfg);
                const hint = cfg.filterList.length === 0
                    ? '\n\n💡 *Tip:* List is empty. Use `.autostatus add <number>` to populate it.'
                    : '';
                const modeText = cmd === 'whitelist'
                    ? `✅ *Whitelist mode ON*\nBot will view ONLY contacts in your list.${hint}`
                    : `🚫 *Blacklist mode ON*\nBot will skip contacts in your list.${hint}`;
                return await sock.sendMessage(chatId, { text: modeText, ...channelInfo }, { quoted: message });
            }

            // ── reset ─────────────────────────────────────────────────────────
            if (cmd === 'reset') {
                cfg.filterMode = 'none';
                cfg.filterList = [];
                await writeConfig(cfg);
                return await sock.sendMessage(chatId, {
                    text: '🌐 *Filter reset!* Bot will now view everyone\'s status.',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── add <number> ──────────────────────────────────────────────────
            if (cmd === 'add') {
                if (!args[1]) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Please provide a number.\nExample: `.autostatus add 2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }
                const num = cleanNumber(args[1]);
                if (num.length < 7) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Invalid format. Use international digits only, no + or spaces.\nExample: `2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }
                if (cfg.filterList.some(n => cleanNumber(n) === num)) {
                    return await sock.sendMessage(chatId, {
                        text: `⚠️ *${num}* is already in the list.`,
                        ...channelInfo
                    }, { quoted: message });
                }
                cfg.filterList.push(num);
                await writeConfig(cfg);
                resetLidFetchFlag();
                // Eagerly resolve the LID for this number so the filter works immediately
                fetchAndStoreLids(sock, [num]).catch(() => {});
                const modeHint = cfg.filterMode === 'none'
                    ? '\n\n💡 *Tip:* Set a mode: `.autostatus whitelist` or `.autostatus blacklist`'
                    : '';
                return await sock.sendMessage(chatId, {
                    text: `✅ *${num}* added. (${cfg.filterList.length} total)${modeHint}`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── remove <number> ───────────────────────────────────────────────
            if (cmd === 'remove') {
                if (!args[1]) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Please provide a number.\nExample: `.autostatus remove 2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }
                const num = cleanNumber(args[1]);
                const before = cfg.filterList.length;
                cfg.filterList = cfg.filterList.filter(n => cleanNumber(n) !== num);
                if (cfg.filterList.length === before) {
                    return await sock.sendMessage(chatId, {
                        text: `⚠️ *${num}* was not found in the list.`,
                        ...channelInfo
                    }, { quoted: message });
                }
                await writeConfig(cfg);
                return await sock.sendMessage(chatId, {
                    text: `✅ *${num}* removed. (${cfg.filterList.length} remaining)`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── list ──────────────────────────────────────────────────────────
            if (cmd === 'list') {
                if (cfg.filterList.length === 0) {
                    return await sock.sendMessage(chatId, {
                        text: `📋 *Filter list is empty.*\nMode: *${cfg.filterMode}*\n\nUse \`.autostatus add <number>\` to add contacts.`,
                        ...channelInfo
                    }, { quoted: message });
                }
                const modeLabel =
                    cfg.filterMode === 'whitelist' ? '✅ Whitelist — viewing ONLY these' :
                    cfg.filterMode === 'blacklist' ? '🚫 Blacklist — skipping these' :
                    '⚠️ No mode active (run `.autostatus whitelist` or `.autostatus blacklist`)';
                const numbered = cfg.filterList.map((n, i) => `${i + 1}. ${n}`).join('\n');
                return await sock.sendMessage(chatId, {
                    text: `📋 *Filter List* (${cfg.filterList.length})\nMode: ${modeLabel}\n\n${numbered}`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── unknown ───────────────────────────────────────────────────────
            await sock.sendMessage(chatId, {
                text: '❌ Unknown sub-command. Run `.autostatus` to see all options.',
                ...channelInfo
            }, { quoted: message });

        } catch (error: any) {
            console.error('[autostatus] Command error:', error);
            await sock.sendMessage(chatId, {
                text: `❌ *Error:* ${error.message}`,
                ...channelInfo
            }, { quoted: message });
        }
    },

    // Exported for messageHandler.ts
    handleStatusUpdate,
    shouldViewStatus,
    readConfig,
    writeConfig
};