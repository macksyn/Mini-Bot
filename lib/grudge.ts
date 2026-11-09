/**
 * lib/grudge.ts
 * Nigerian-aware insult detection + grudge state management for chatbot.ts
 */

import { createStore } from './pluginStore.js';

const db      = createStore('chatbot');
const dbUsers = db.table!('users');

// ── Duration tiers (ms) ───────────────────────────────────────────────────────
export const GRUDGE_DURATIONS = {
    mild:   2  * 60 * 60 * 1000,   // 2 hours
    medium: 6  * 60 * 60 * 1000,   // 6 hours
    heavy:  24 * 60 * 60 * 1000,   // 24 hours
};

// ── Types ─────────────────────────────────────────────────────────────────────
export interface GrudgeRecord {
    active:    boolean;
    expiresAt: number;
    severity:  'mild' | 'medium' | 'heavy';
    strikes:   number;
    chatId:    string;
    reason:    string;
}

export interface InsultPattern {
    pattern:         RegExp;
    severity:        'mild' | 'medium' | 'heavy';
    label:           string;
    needsTarget:     boolean; // true = bare word, must have "you/u/ur" nearby to count
    skipIfQuestion?: boolean; // true = skip when message is clearly a question
}

// ── Normaliser ────────────────────────────────────────────────────────────────
// Collapses repeated chars, strips zero-width chars, lowercases,
// handles leet subs so "maaaad", "m@d", "stu.pid" all normalise cleanly.
export function normalise(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')     // zero-width chars
        .replace(/[0@]/g,  'o')
        .replace(/[1!|]/g, 'i')
        .replace(/[3]/g,   'e')
        .replace(/[4]/g,   'a')
        .replace(/[5\$]/g, 's')
        .replace(/[7]/g,   't')
        .replace(/[8]/g,   'b')
        .replace(/\./g,    '')                       // "stu.pid" → "stupid"
        .replace(/(.)\1{2,}/g, '$1$1')              // "maaaad" → "maad"
        .replace(/\s+/g,   ' ')
        .trim();
}

// ── Question / innocent context check ────────────────────────────────────────
// Returns true when the message is clearly a genuine question rather than
// an insult — e.g. "What's your mom's name?" or "Who is your father?"
// Used to skip "your mama/papa" family patterns that have skipIfQuestion: true.
function isInnocentQuestion(text: string): boolean {
    const t = text.trim();

    // Ends with a question mark — strongest signal
    if (t.endsWith('?')) return true;

    // Starts with a question word — catches "Who is your papa" / "What does your father do"
    // even without a trailing question mark
    if (/^(what|who|how|where|when|is|are|do|does|can|could|would|tell\s+me|do\s+you\s+know)\b/i.test(t)) return true;

    // "your mama's / your papa's" — possessive means they're asking about someone, not insulting
    if (/\b(your|ur)\s*(mama|papa|father|fada)\s*[''s]/i.test(t)) return true;

    // "your X [neutral verb]" — third-party statement, not an insult
    // e.g. "your father lives there", "your mama works in Lagos"
    if (/\b(your|ur)\s*(mama|papa|father|fada)\s+\w*(live|work|stay|is|was|has|have|came|come|went|go|said|told|call|text|know|look|seem|sound|appear)/i.test(t)) return true;

    return false;
}

// ── Direction check ───────────────────────────────────────────────────────────
// For bare-word patterns (needsTarget: true), confirm there's a directed
// pronoun or bot reference within ~35 chars of the match so "our stupid
// president" never triggers but "you stupid" or "u be mumu" always does.
function isDirectedAtBot(text: string, matchIndex: number): boolean {
    const window = text.slice(Math.max(0, matchIndex - 35), matchIndex + 35);

    // Generic/hypothetical "you" — "if you no get money", "when you hustle"
    // This is social commentary, not directed at the bot
    if (/\b(if|when|once|anytime|whenever)\s+(you|u|yu)\b/i.test(window)) return false;

    // "you be X to [someone]" — Pidgin social observation, not a bot insult
    // e.g. "you be trash to ladies", "you be nothing to them"
    if (/\b(you|u|yu)\s+be\s+\w+\s+to\s+\w/i.test(window)) return false;

    return /\b(you|u|yu|ur|this\s*bot|dis\s*bot|groq|yourself|urself)\b/i.test(window);
}

// ── Insult patterns ───────────────────────────────────────────────────────────
export const INSULT_PATTERNS: InsultPattern[] = [

    // ── "your mama/papa" family ──────────────────────────────── needsTarget: false (direction baked in)
    // ONLY these exact variants are treated as insults — all other
    // "your mom/mother/mum/daddy/pop/baba/iya" variations are intentionally
    // excluded to avoid false positives on innocent sentences.
    // skipIfQuestion: true — "who is your papa?" / "your father lives there?" still safe
    { pattern: /\b(your|ur)\s*mam+a\b/i,   severity: 'medium', label: 'your_mama',   needsTarget: false, skipIfQuestion: true },
    { pattern: /\b(your|ur)\s*mam\b/i,     severity: 'medium', label: 'your_mam',    needsTarget: false, skipIfQuestion: true },
    { pattern: /\b(your|ur)\s*papa\b/i,    severity: 'medium', label: 'your_papa',   needsTarget: false, skipIfQuestion: true },
    { pattern: /\b(your|ur)\s*father\b/i,  severity: 'medium', label: 'your_father', needsTarget: false, skipIfQuestion: true },
    { pattern: /\b(your|ur)\s*fada\b/i,    severity: 'medium', label: 'your_fada',   needsTarget: false, skipIfQuestion: true },

    // ── "you are mad" + all Pidgin/spelling variants ─────────── needsTarget: false
    // covers: "you mad", "u r mad", "ur mad", "you dey mad",
    //         "u don mad", "you craze", "u don craze", "you crazy sef"
    { pattern: /\b(you|u|yu)\s*(are|r|dey|don|don\s*de)?\s*ma+d\b/i,               severity: 'heavy',  label: 'you_are_mad',      needsTarget: false },
    { pattern: /\b(you|u|yu)\s*(are|r|dey|don|don\s*de)?\s*kra+ze?\b/i,            severity: 'heavy',  label: 'you_craze_k',      needsTarget: false },
    { pattern: /\b(you|u|yu)\s*(are|r|dey|don|don\s*de)?\s*craz(y|e)\b/i,          severity: 'heavy',  label: 'you_craze',        needsTarget: false },

    // ── "this bot/thing/groq" + insult combos ────────────────── needsTarget: false (explicit bot ref)
    { pattern: /\b(this|dis)\s+(bot|thing|groq|ai)\s+(is\s+)?(mad|stupid|useless|fool|dumb|ode|mumu)\b/i, severity: 'heavy', label: 'bot_insult_direct', needsTarget: false },

    // ── "go die" / "kill yourself" ───────────────────────────── needsTarget: false (inherently directed)
    { pattern: /\bg[o0]\s*d[i]+e\b/i,                                               severity: 'heavy',  label: 'go_die',           needsTarget: false },
    { pattern: /\bkill\s+your(self)?\b/i,                                            severity: 'heavy',  label: 'kill_yourself',    needsTarget: false },


    // ── Bare-word Nigerian insults ────────────────────────────── needsTarget: true (need "you/u" nearby)
    { pattern: /\bo+l[o0]+d[o0]+\b/i,                                               severity: 'heavy',  label: 'olodo',            needsTarget: true  },
    { pattern: /\bo+d[e3]+\b/i,                                                      severity: 'heavy',  label: 'ode',              needsTarget: true  },
    { pattern: /\bm[u]+m[u]+\b/i,                                                    severity: 'heavy',  label: 'mumu',             needsTarget: true  },

    // ── Bare-word English insults ─────────────────────────────── needsTarget: true
    { pattern: /\bfo[o0]+l(ish)?\b/i,                                               severity: 'medium', label: 'foolish',          needsTarget: true  },
    { pattern: /\bst[u]+p[i]+d\b/i,                                                  severity: 'medium', label: 'stupid',           needsTarget: true  },
    { pattern: /\bi+d[i]+[o0]+t\b/i,                                                 severity: 'medium', label: 'idiot',            needsTarget: true  },
    { pattern: /\bd[u]+mb\b/i,                                                        severity: 'mild',   label: 'dumb',             needsTarget: true  },
    { pattern: /\buses+les+\b/i,                                                      severity: 'medium', label: 'useless',          needsTarget: true  },
    { pattern: /\bdum+[ao]ss\b/i,                                                     severity: 'medium', label: 'dumbass',          needsTarget: true  },
    { pattern: /\bmoron\b/i,                                                          severity: 'medium', label: 'moron',            needsTarget: true  },
    { pattern: /\bimbecile\b/i,                                                       severity: 'medium', label: 'imbecile',         needsTarget: true  },
];

// ── Severity scorer ───────────────────────────────────────────────────────────
export function detectInsult(rawText: string): {
    hit:           boolean;
    severity:      'mild' | 'medium' | 'heavy';
    matchedLabels: string[];
} {
    const norm            = normalise(rawText);
    const matchedLabels:  string[] = [];
    let highestSeverity:  'mild' | 'medium' | 'heavy' = 'mild';
    const severityRank    = { mild: 1, medium: 2, heavy: 3 };

    // Pre-compute once — avoids repeating the check for every pattern
    const questionContext = isInnocentQuestion(rawText) || isInnocentQuestion(norm);

    for (const { pattern, severity, label, needsTarget, skipIfQuestion } of INSULT_PATTERNS) {
        // Skip "your mama/papa" style patterns when the message is clearly a question
        if (skipIfQuestion && questionContext) continue;

        // Try normalised first, fall back to raw
        const match = pattern.exec(norm) ?? pattern.exec(rawText);
        if (!match) continue;

        // Bare-word patterns require a directed pronoun/bot ref nearby
        if (needsTarget && !isDirectedAtBot(norm, match.index)) continue;

        matchedLabels.push(label);
        if (severityRank[severity] > severityRank[highestSeverity]) {
            highestSeverity = severity;
        }
    }

    return {
        hit:           matchedLabels.length > 0,
        severity:      highestSeverity,
        matchedLabels
    };
}

// ── Grudge store helpers ──────────────────────────────────────────────────────
// Grudges are group-scoped: stored as profile.grudges[chatId]
// so insulting in Group A has zero effect in Group B.

export async function getGrudge(
    chatId:       string,
    senderId:     string,
    profileCache: Map<string, Record<string, any>>,
): Promise<GrudgeRecord | null> {
    const profile: Record<string, any> = profileCache.get(senderId) ?? (await dbUsers.get(senderId)) ?? {};
    const grudges: Record<string, GrudgeRecord> = profile.grudges ?? {};
    const g = grudges[chatId];
    if (!g) return null;

    // Auto-expire
    if (Date.now() > g.expiresAt) {
        // Mark as just-thawed so chatbot.ts can greet them coldly
        profile._justThawed         = profile._justThawed ?? {};
        profile._justThawed[chatId] = true;
        delete grudges[chatId];
        profile.grudges = grudges;
        profileCache.set(senderId, profile);
        await dbUsers.set(senderId, profile);
        return null;
    }

    return g;
}

export async function setGrudge(
    chatId:       string,
    senderId:     string,
    severity:     'mild' | 'medium' | 'heavy',
    reason:       string,
    profileCache: Map<string, Record<string, any>>,
): Promise<GrudgeRecord> {
    const profile: Record<string, any> = profileCache.get(senderId) ?? (await dbUsers.get(senderId)) ?? {};
    const grudges: Record<string, GrudgeRecord> = profile.grudges ?? {};
    const existing = grudges[chatId];

    // Repeat offender: multiply duration by strike count, capped at 48 hours
    const strikes  = (existing?.strikes ?? 0) + 1;
    const base     = GRUDGE_DURATIONS[severity];
    const duration = Math.min(base * strikes, GRUDGE_DURATIONS.heavy * 2);

    const grudge: GrudgeRecord = {
        active:    true,
        expiresAt: Date.now() + duration,
        severity,
        strikes,
        chatId,
        reason:    reason.slice(0, 80),
    };

    grudges[chatId] = grudge;
    profile.grudges = grudges;
    profileCache.set(senderId, profile);
    await dbUsers.set(senderId, profile);

    return grudge;
}

export async function clearGrudge(
    chatId:       string,
    senderId:     string,
    profileCache: Map<string, Record<string, any>>,
): Promise<void> {
    const profile: Record<string, any> = profileCache.get(senderId) ?? (await dbUsers.get(senderId)) ?? {};
    const grudges: Record<string, GrudgeRecord> = profile.grudges ?? {};
    delete grudges[chatId];
    profile.grudges = grudges;
    profileCache.set(senderId, profile);
    await dbUsers.set(senderId, profile);
}

// ── Clapback pool ─────────────────────────────────────────────────────────────

const CLAPBACKS: Record<'mild' | 'medium' | 'heavy', string[]> = {

    mild: [
        "Okay wow. That was rude 🙄 I'm not talking to you again.",
        "Alright noted. I'll just... not reply you anymore 🚶",
        "That's a weird way to talk to someone. Cool, We are done. 😑",
        "You really pressed send on that? 😐 interesting. We are done.",
        "Rude for no reason 😒 okay. I see you.",
        "It takes one to know one, doesn't it? Sha dey your lane make i dey my lane",
        "Who dey dash all dis dullards data sef? Abeg go one side. 😡",
        "I'm not even upset, I'm just... done with you for now 😌",
        " If you use this energy now take learn mechanic...... only God know wetin u no fit repair by now.",
        "Didn't expect that from you but no wahala. 😶 we move.",
    ],

    medium: [
        "Say it again and see. 😒 Actually don't bother, we're done here.",
        "Lmao okay. I don't deal with that kind of energy. Peace ✌️",
        "Interesting choice of words. I'll remember this 🙂",
        "You got a lot of nerve abi? Cool. Ghost mode activated.",
        "Aridin. Do head like tiger battery. Don't ever tag me again. 😡",
        "The audacity is actually impressive. 😐 Goodbye!.",
        "I was literally minding my own business. 😒",
        "And just like that, you lost my respect. Congrats 🎉",
        "I've seen better insults from a primary school debate 😴 try again never.",
        "Order sense I go pay. 😑 I'm out.",
        "Hmm. You really said that with your full chest? 😒 I should stay my lane I guess. Bye.",
        "Some people just don't deserve responses and today you've joined that list 😌",
        "I don't even have the energy to be offended. You're just blocked in my heart 💔",
        "See ehn, this behaviour? Not it. Not today. Not ever. 😑",
        "I came in peace and you chose war. Interesting life choices. Goodbye. ✌️",
        "The disrespect jumped out so fast I almost didn't catch it 😐 but I did. Noted.",
    ],

    heavy: [
        "Your papa 😐.. I said what I said. Don't ever tag me again.",
        "Oh we're doing this? Okay. I have NOTHING else to say to you.",
        "Take a chill pill, its good for your health.. any time they discussing matters, you are always on the wrong side. 😑😏",
        "The fact that you think I'll keep responding to you after that trash u just said....😂 adorable. Bye.",
        "Hope say no be this brain you dey use cross road?🤦",
        "You must have me confused with someone who tolerates insults. Noted. Blocked in my heart.",
        "I've genuinely lost respect for you rn and I'm a cool guy 😐....that says a lot.",
        "Dude. You really said that? 😶 okay. I will not talk to you again. Thank you, next.",
        "See me see trouble o😒 I didn't come to this group for this disrespect. We are DONE.",
        "Ehn? Could you say this to my face 0ne-on-one? 😐 I don't blame you. Talk to the void because I'm gone.",
        "I was going to respond but then I remembered I have standards. 😌 So, no.",
        "God punish you softly 😒 I'm moving on with my life.",
        "The fact that you typed that, read it back, and still pressed send. 😂 Lik,the confidence!",
        "You know what, I'm not even going to waste my energy. You're not worth the keystrokes.",
        "Ah. So this is who you are in real life? 😐 interesting. Very interesting. Goodbye.",
        "This guy really came online and decided to make me an enemy today.. 😒 Bold! I wont speak to you anymore.",
        "I don't forget and I don't forgive quickly. 😑 enjoy talking to yourself for a while.",
        "Since you have so much to say, you can say it to the wall. I'm done here. 🚶‍♂️",
        "Wow. I actually liked you before this moment. 😐 Rest in peace to that relationship.",
        "Not me catching feelings over this. 😒 Except the feelings are just pure unbothered energy. Bye.",
        "You really had all day to say something nice and chose this? 😂 I can't even be mad.",
        "So na wetin dey disturb you be this? God abeg find problem for this person, e don solve the first batch finish! 🙏😂",
        "Ehn okay. Let me not talk before I say something that'll scatter this group 😒 just don't tag me again in your life.",
        "I can see why people underestimate you. 😐 Goodbye!",
        "So u self dull like this? I too rate u, fuvk 😑 Dnt ever tag me again.",
    ],
};

export function getGrudgeClapback(severity: 'mild' | 'medium' | 'heavy'): string {
    const pool = CLAPBACKS[severity];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── Thaw messages — when grudge expires and they dare to speak again ───────────
const THAW_MESSAGES: string[] = [
    "...what do you want 🙄",
    "Hmm. You again. 😒 what?",
    "I was minding my business but go on.",
    "Took you long enough. What is it.",
    "We still cool? Barely. But talk.",
    "Oh so now you want to talk 😐 interesting.",
    "I see you're back. Didn't miss you but go on.",
    "Ehn. I'll listen. But know that I remembered 😒",
    "You're lucky I'm in a forgiving mood. Barely. What?",
    "Okay fine. I'll acknowledge your existence again. What do you want. 😑",
    "Clock ran out. You get one more chance. Don't waste it. 🙂",
    "Back already? Okay. Just know I have a long memory 😌 what?",
    "I was genuinely enjoying the silence but here we are 😒 speak.",
    "Amnesty granted. Reluctantly. Very reluctantly. What is it.",
];

export function getThawMessage(): string {
    return THAW_MESSAGES[Math.floor(Math.random() * THAW_MESSAGES.length)];
}