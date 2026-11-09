// Shared participant-resolution and group-metadata helpers used by
// welcome.ts, goodbye.ts, and any other plugin that needs them.

// ── Group metadata cache ──────────────────────────────────────────────────────

const GROUP_META_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface GroupMetaEntry { meta: any; ts: number }
const groupMetaCache = new Map<string, GroupMetaEntry>();

/**
 * Return group metadata, using a 10-minute in-memory cache to avoid
 * hammering the WhatsApp network on every join/leave event.
 */
export async function getCachedGroupMeta(sock: any, chatId: string): Promise<any> {
    const cached = groupMetaCache.get(chatId);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL_MS) return cached.meta;
    const meta = await (sock as any).groupMetadata(chatId).catch(() => null);
    if (meta) groupMetaCache.set(chatId, { meta, ts: Date.now() });
    return meta;
}

/** Drop a group's cached metadata immediately (e.g. after a join/leave). */
export function evictGroupMetaCache(chatId: string): void {
    groupMetaCache.delete(chatId);
}

// ── Participant resolution ─────────────────────────────────────────────────────

export interface ResolvedParticipant {
    /** The real @s.whatsapp.net JID (LID resolved when possible). */
    jid: string;
    /** Human display name from contacts store, or phone number as fallback. */
    name: string;
    /** Bare phone number extracted from the JID — use this for @-mention text. */
    phoneNumber: string;
}

/**
 * Resolve a raw participant value (string JID or object with `.id`) to a
 * real JID, display name, and phone number.
 *
 * WhatsApp @-mentions only render as tappable links when the message text
 * contains `@phoneNumber` (not `@displayName`).  Always use `phoneNumber`
 * for the visible `@` text and pass `jid` in the `mentions` array.
 */
export function resolveParticipant(raw: any, sock: any): ResolvedParticipant {
    const jidStr: string =
        typeof raw === 'string' ? raw : (raw?.id ?? String(raw));

    // Step 1: if it's a @lid, try to find the real @s.whatsapp.net JID
    let realJid = jidStr;
    if (jidStr.includes('@lid') && sock?.store?.contacts) {
        const contacts: Record<string, any> = sock.store.contacts;
        const lidNumeric = jidStr.split('@')[0].split(':')[0];

        const resolved = Object.keys(contacts).find(k => {
            if (!k.includes('@s.whatsapp.net')) return false;
            const c = contacts[k];
            const cLid: string = c?.lid ?? '';
            return (
                cLid === jidStr ||
                cLid.split('@')[0].split(':')[0] === lidNumeric
            );
        });

        if (resolved) realJid = resolved;
    }

    // Step 2: look up a human name from the contacts store
    const contacts: Record<string, any> = sock?.store?.contacts ?? {};
    const entry = contacts[realJid] ?? contacts[jidStr] ?? {};
    const name: string =
        entry.notify      ||
        entry.name        ||
        entry.verifiedName ||
        realJid.split('@')[0].split(':')[0]; // phone number as last resort

    const phoneNumber = realJid.split('@')[0].split(':')[0];

    return { jid: realJid, name, phoneNumber };
}
