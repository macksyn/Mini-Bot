// @ts-nocheck
/***
 * lib/buttonSession.ts
 *
 * Drop-in replacement for lib/menuSession.ts's promptMenu(), built on
 * gifted-btns instead of "type a number and reply". Same function name,
 * same call signature, same MenuResult shape — so any plugin currently
 * doing:
 *
 *   import { promptMenu } from '../lib/menuSession.js';
 *
 * can switch to:
 *
 *   import { promptMenu } from '../lib/buttonSession.js';
 *
 * with no other changes, and switch back just as easily if a given menu
 * doesn't render well as buttons. Keep menuSession.ts around — this is
 * not a replacement for it project-wide, it's an alternative per plugin
 * (or even per-menu) until buttons are proven reliable everywhere you'd
 * want them.
 *
 * Also exports promptAmount() — a free-text sibling to promptMenu() for
 * when you need a typed number back (a stake, a quantity) rather than a
 * tap. Same pending-prompt/listener machinery, just resolved off the
 * reply's text instead of a button id. See its own doc comment below.
 *
 * ── What's confirmed vs experimental (as of the on-device test today) ──
 *
 * CONFIRMED (real device, real tap, real round-trip):
 *   - gifted-btns' sendButtons() with quick_reply buttons renders and
 *     taps come back as a `templateButtonReplyMessage`.
 *   - Tested with exactly 3 buttons, no cancel button added on top.
 *   - Global Trader's menus (buttonSession-based, several with 8–10
 *     options — well past the quick_reply ceiling) have been in daily
 *     use for months with no reported issues, which confirms the
 *     single_select (list) path below end-to-end: it renders AND a tap
 *     on it resolves the prompt correctly. Downgrading the note below
 *     from "not yet confirmed" to "confirmed via Global Trader" —
 *     leaving the original caveat in place for the specific shape
 *     assumptions, since nobody's pointed at the exact log line yet.
 *
 * CONFIRMED VIA GLOBAL TRADER, SHAPE DETAILS STILL UNVERIFIED FROM A RAW LOG:
 *   - single_select (list) rendering via sendInteractiveMessage works in
 *     practice for menus well beyond 3 options.
 *   - The incoming shape for a single_select tap — presumed to be
 *     `message.listResponseMessage.singleSelectReply.selectedRowId`
 *     based on standard Baileys message types, and functioning correctly
 *     given Global Trader's menus resolve taps reliably — but if you
 *     ever add a new response shape branch, this is the one to check
 *     against a real captured payload first.
 *
 * NEW, NOT YET TESTED ON A REAL DEVICE:
 *   - promptAmount()'s free-text reply path. It reuses the same
 *     contextInfo.stanzaId matching as everything else here, which is
 *     solid, but the text-extraction branch (extractReplyText below) is
 *     new code. If a reply to an amount prompt never resolves, check the
 *     console.warn this listener prints for the raw message shape.
 *
 * ── iOS routing (added after on-device testing) ─────────────────────
 * iPhone WhatsApp does not render single_select (list) messages sent this
 * way — the message never shows up. Quick-reply buttons DO render and
 * round-trip on iOS, including 10 at once (confirmed with
 * plugins/testbuttons.ts: an iPhone user tapped Option 10 of 10). So for
 * menus too big for the 3-button path, promptMenu() checks the invoking
 * message's id:
 *   - looks like iPhone  -> ONE quick_reply message with every option plus
 *                        Cancel. No paging. (iPhone id = 20 uppercase-hex
 *                        chars, any prefix — covers WhatsApp Business too.)
 *   - anything else      -> the single_select dropdown, exactly as before.
 * Same opt_N ids and MenuResult either way. Detection is a message-id
 * heuristic (see prefersButtons), not a guarantee; setIosMode(userId, ...)
 * overrides it per user.
 * UNCONFIRMED: iOS rendering of MORE than 10 buttons in one message. If a
 * menu with 11+ options ever looks wrong on an iPhone, `.testbtn 11` /
 * `.testbtn 15` shows where it stops.
 *
 * ── Design notes carried over from menuSession.ts ───────────────────
 * - One listener per sock (WeakSet-guarded), shared across all plugins
 *   using this module.
 * - Pending prompts keyed by the sent message's own id. Matched to a
 *   reply via contextInfo.stanzaId, same as menuSession — WhatsApp
 *   button/list replies carry contextInfo just like quoted text replies.
 * - A reply only resolves the prompt if it's actually a response to
 *   that exact message. Anything else is ignored, not consumed.
 * - Cancel is automatic for promptMenu: a "❌ Cancel" option is appended
 *   for you: as a quick_reply button in the small-menu case, as an extra
 *   row in the single_select case. Don't add your own cancel entry in
 *   `options`. promptAmount has no buttons to append one to — typing
 *   "cancel" is the escape hatch there instead (see below).
 * - Default TTL is 3 minutes, same as menuSession. Override with ttlMs.
 * - Unrecognized/malformed taps get logged in full (not just a type
 *   name) so a future mismatch can be diagnosed from one log line
 *   instead of another multi-round guessing loop.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { sendButtons, sendInteractiveMessage } = require('gifted-btns');
// gifted-btns v1.0.2 confirmed CJS-only — see plugins/testbuttons.ts for
// how this was verified (require('gifted-btns') dump, no dependencies,
// {valid,errors,warnings} validator shape, etc.)

import { cleanJid } from './isOwner.js';

export interface MenuOption {
  label: string;
  value: string;
  description?: string; // only shown in the single_select (list) path — quick_reply buttons have no room for it
}

export interface MenuPromptConfig {
  title?: string;
  subtitle?: string;
  text: string;
  options: MenuOption[];
  footer?: string;
  ttlMs?: number;
  cancelLabel?: string;
  extra?: Record<string, any>; // NOTE: unlike menuSession, this is not currently merged into the send payload — see promptMenu() below
}

export interface MenuResult {
  value: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface AmountPromptConfig {
  title?: string;
  subtitle?: string;
  text: string;
  footer?: string;
  ttlMs?: number;
  min?: number;
  max?: number;
  /** How many bad-input retries before giving up. Default 3 total attempts. */
  maxAttempts?: number;
}

export interface AmountResult {
  value: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

const DEFAULT_TTL_MS = 3 * 60_000;

// Confirmed ceiling for the quick_reply path: proven at exactly 3 buttons
// today. Cancel counts toward this total, so options.length must be <= 2
// to stay on the confirmed path once cancel is added.
const QUICK_REPLY_MAX_TOTAL_BUTTONS = 3;

interface PendingOptionsPrompt {
  kind: 'options';
  chatId: string;
  userId: string;
  options: MenuOption[];
  resolve: (result: MenuResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTextPrompt {
  kind: 'text';
  chatId: string;
  userId: string;
  resolve: (text: string | null, cancelled: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

type PendingPrompt = PendingOptionsPrompt | PendingTextPrompt;

const pending = new Map<string, PendingPrompt>(); // keyed by the sent message's own id
const registeredSocks = new WeakSet<any>();

// ── Device routing ──────────────────────────────────────────────────
// iPhone WhatsApp drops single_select messages, so iOS users get every option
// as a quick_reply button in a single message instead (10 buttons confirmed
// on a real iPhone).

// Users who ALWAYS get buttons, whatever their message ids look like. Add a
// user's id here when the id heuristic misses them (iPhone user sees no menu).
// Use the exact id printed in the "[buttonSession] menu for ..." log line.
// Survives restarts; setIosMode() below only lasts until the bot restarts.
const FORCE_BUTTONS_USERS: string[] = ['189004465090656'
  // '2348024169809',
];

const iosOverrides = new Map<string, boolean>(
  FORCE_BUTTONS_USERS.map((id) => [id, true] as [string, boolean])
); // userId -> forced on/off

/** Manual override per user: true = always buttons, false = always dropdown, null = auto-detect. */
export function setIosMode(userId: string, on: boolean | null): void {
  if (on === null) iosOverrides.delete(userId);
  else iosOverrides.set(userId, on);
}

/**
 * Decides dropdown vs buttons for this user. The dropdown (single_select) is
 * the default; quick_reply buttons are used only for iPhone senders, whose
 * WhatsApp never renders the dropdown.
 *
 * iPhone = message id of exactly 20 uppercase-hex characters. Older iOS ids
 * start with "3A"; a WhatsApp Business iPhone user's id was
 * 2A9E09B317B7E0E2F721, so the prefix is NOT pinned — only length + hex.
 * (Android ids are 32 chars; Web/bot ids are 22 and start with 3EB0.)
 *
 * It's a heuristic: an iPhone user whose id doesn't fit gets the dropdown and
 * sees nothing. setIosMode(userId, true) forces buttons for that person.
 */
function prefersButtons(message: any, userId: string): boolean {
  const forced = iosOverrides.get(userId);
  if (forced !== undefined) return forced;

  const id: string = message?.key?.id || '';
  return /^[0-9A-F]{20}$/.test(id);
}

function getContextInfo(msg: any): any {
  const m = msg.message;
  if (!m) return null;
  return (
    m.templateButtonReplyMessage?.contextInfo ||   // CONFIRMED shape for quick_reply taps (tested today)
    m.buttonsResponseMessage?.contextInfo ||        // legacy buttonsMessage shape, not yet seen on this bot
    m.listResponseMessage?.contextInfo ||           // single_select shape — confirmed working via Global Trader
    m.interactiveResponseMessage?.contextInfo ||    // native_flow generic shape, UNCONFIRMED on this bot
    m.extendedTextMessage?.contextInfo ||           // plain-text replies — used by promptMenu's text fallback AND promptAmount
    null
  );
}

/**
 * Pulls the selected option's id (the string we encoded as opt_N or
 * "cancel") out of whichever response shape actually arrived.
 * Returns null if the shape isn't recognized — caller should log the
 * raw message in that case rather than silently drop it.
 */
function extractSelectedId(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;

  // CONFIRMED today: quick_reply tap -> templateButtonReplyMessage.selectedId
  if (m.templateButtonReplyMessage?.selectedId) {
    return m.templateButtonReplyMessage.selectedId;
  }

  // Standard Baileys shape for buttonsMessage taps — not yet seen on this
  // bot, included defensively in case a future WhatsApp/Baileys update
  // changes which shape gets used for the same quick_reply buttons.
  if (m.buttonsResponseMessage?.selectedButtonId) {
    return m.buttonsResponseMessage.selectedButtonId;
  }

  // Standard Baileys shape for a list/single_select tap — confirmed
  // working in practice via Global Trader's multi-option menus.
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // UNCONFIRMED: generic native_flow response — paramsJson is a JSON
  // string, typically { id: '...' } for quick_reply-shaped responses
  // coming back through this wrapper.
  const nativeFlowParams = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeFlowParams) {
    try {
      const parsed = JSON.parse(nativeFlowParams);
      if (parsed?.id) return parsed.id;
    } catch {
      // fall through to null
    }
  }

  return null;
}

/** Plain reply text for a promptAmount() prompt — a quoted reply arrives as extendedTextMessage.text. */
function extractReplyText(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  return m.extendedTextMessage?.text ?? m.conversation ?? null;
}

function registerListener(sock: any) {
  if (registeredSocks.has(sock)) return;
  registeredSocks.add(sock);

  sock.ev.on('messages.upsert', async (upsert: any) => {
    try {
      const msg = upsert.messages?.[0];
      if (!msg || msg.key?.fromMe) return;

      const contextInfo = getContextInfo(msg);
      const quotedId = contextInfo?.stanzaId;
      if (!quotedId) return;

      const prompt = pending.get(quotedId);
      if (!prompt) return;

      const senderId = cleanJid(msg.key.participant || msg.key.remoteJid);
      if (senderId !== prompt.userId) return; // right menu, wrong person — ignore, don't consume

      if (prompt.kind === 'text') {
        const raw = extractReplyText(msg);
        if (raw === null) {
          console.warn(
            '[buttonSession] promptAmount got a reply with no readable text — raw message:',
            JSON.stringify(msg.message, null, 2)
          );
          return; // don't consume — let it time out or let a valid reply come in
        }
        clearTimeout(prompt.timer);
        pending.delete(quotedId);
        const trimmed = raw.trim();
        if (trimmed.toLowerCase() === 'cancel') {
          prompt.resolve(null, true);
        } else {
          prompt.resolve(trimmed, false);
        }
        return;
      }

      const selectedId = extractSelectedId(msg);

      if (!selectedId) {
        // Quoted/replied to our menu, but in a shape we don't recognize.
        // Log the raw payload so a future fix here is a one-line lookup,
        // not another multi-message guessing session.
        console.warn(
          '[buttonSession] unrecognized response shape for a pending prompt — raw message:',
          JSON.stringify(msg.message, null, 2)
        );
        return; // don't consume — let it time out or let a valid reply come in
      }

      if (selectedId === 'cancel') {
        clearTimeout(prompt.timer);
        pending.delete(quotedId);
        prompt.resolve({ value: null, timedOut: false, cancelled: true });
        return;
      }

      const match = selectedId.match(/^opt_(\d+)$/);
      const idx = match ? parseInt(match[1], 10) : NaN;

      if (isNaN(idx) || idx < 0 || idx >= prompt.options.length) {
        console.warn(`[buttonSession] got selectedId "${selectedId}" that doesn't match any known option — ignoring.`);
        return;
      }

      clearTimeout(prompt.timer);
      pending.delete(quotedId);
      prompt.resolve({ value: prompt.options[idx].value, timedOut: false, cancelled: false });
    } catch (err) {
      console.error('[buttonSession] listener error:', err);
    }
  });
}

export async function promptMenu(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  config: MenuPromptConfig
): Promise<MenuResult> {
  registerListener(sock);

  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const cancelLabel = config.cancelLabel || '❌ Cancel';
  const minutes = Math.round(ttlMs / 60_000);
  const footer = config.footer || `Expires in ${minutes} min${minutes === 1 ? '' : 's'}`;

  const bodyLines: string[] = [];
  if (config.title) bodyLines.push(`*${config.title}*`);
  if (config.subtitle) bodyLines.push(`_${config.subtitle}_`);
  bodyLines.push(config.text);
  const bodyText = bodyLines.join('\n');

  const totalWithCancel = config.options.length + 1;
  const useQuickReply = totalWithCancel <= QUICK_REPLY_MAX_TOTAL_BUTTONS;

  const iosMode = !useQuickReply && prefersButtons(message, userId);
  if (!useQuickReply) {
    console.log(
      `[buttonSession] menu for ${userId} · msg id ${message?.key?.id} -> ${iosMode ? 'buttons' : 'dropdown'}`
    );
  }
  let sent: any;

  if (useQuickReply) {
    // CONFIRMED PATH — same shape proven in plugins/testbuttons.ts.
    const buttons = config.options.map((o, i) => ({ id: `opt_${i}`, text: o.label }));
    buttons.push({ id: 'cancel', text: cancelLabel });

    sent = await sendButtons(sock, chatId, {
      text: bodyText,
      footer,
      buttons,
    }, { quoted: message });
  } else if (iosMode) {
    // iOS path — single_select never renders on iPhone, so send every option
    // as a quick_reply button in one message (shape confirmed on iOS). Ids
    // stay opt_N, so tap handling below is identical to every other path.
    const buttons = config.options.map((o, i) => ({ id: `opt_${i}`, text: o.label }));
    buttons.push({ id: 'cancel', text: cancelLabel });

    // Quick-reply buttons have no room for descriptions, so list them in the body.
    const described = config.options.filter((o) => o.description);
    const iosBody = described.length
      ? `${bodyText}\n\n${described.map((o) => `• ${o.label} — ${o.description}`).join('\n')}`
      : bodyText;

    sent = await sendButtons(sock, chatId, {
      text: iosBody,
      footer,
      buttons,
    }, { quoted: message });
  } else {
    // Beyond-3-option path — confirmed working end-to-end via Global
    // Trader's menus (see header notes). If a prompt using this path
    // ever stops resolving, check the console.warn log this listener
    // prints for the actual raw shape before assuming the path itself broke.
    const rows = config.options.map((o, i) => ({
      id: `opt_${i}`,
      title: o.label,
      description: o.description,
    }));
    rows.push({ id: 'cancel', title: cancelLabel });

    sent = await sendInteractiveMessage(sock, chatId, {
      text: bodyText,
      footer,
      interactiveButtons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: config.title || 'Choose an option',
            sections: [{ title: 'Options', rows }],
          }),
        },
      ],
    }, { quoted: message });
  }

  const promptMessageId = sent?.key?.id;

  return new Promise<MenuResult>((resolve) => {
    if (!promptMessageId) {
      // Couldn't get a message id back — nothing to key a reply to, fail closed.
      resolve({ value: null, timedOut: true, cancelled: false });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(promptMessageId);
      resolve({ value: null, timedOut: true, cancelled: false });
    }, ttlMs);
    pending.set(promptMessageId, { kind: 'options', chatId, userId, options: config.options, resolve, timer });
  });
}

/**
 * promptAmount() — free-text sibling to promptMenu(), for when you need a
 * typed number back (a stake, a quantity) rather than a tap. No buttons;
 * just sends a plain quoted text message and waits for a reply.
 *
 * - Reply "cancel" (any case) to abort — that's the only escape hatch,
 *   since there's no button to tap here.
 * - A non-numeric or out-of-[min,max]-range reply gets one re-prompt
 *   (up to maxAttempts total) before giving up; a final bad attempt
 *   resolves the same as a timeout, so callers only need to branch on
 *   `timedOut`/`cancelled`, not track attempt counts themselves.
 * - Each attempt sends a fresh message and re-registers the pending
 *   prompt against that new message's id — same contextInfo.stanzaId
 *   matching as everything else in this file, just replied to with text
 *   instead of a tap.
 */
export async function promptAmount(
  sock: any,
  message: any,
  chatId: string,
  userId: string,
  config: AmountPromptConfig
): Promise<AmountResult> {
  registerListener(sock);

  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const minutes = Math.round(ttlMs / 60_000);
  const rangeHint =
    config.min !== undefined && config.max !== undefined
      ? ` (${config.min}–${config.max})`
      : '';
  const footer =
    config.footer || `Reply with a number${rangeHint}, or "cancel" · expires in ${minutes} min${minutes === 1 ? '' : 's'}`;

  const bodyLines: string[] = [];
  if (config.title) bodyLines.push(`*${config.title}*`);
  if (config.subtitle) bodyLines.push(`_${config.subtitle}_`);
  bodyLines.push(config.text);
  let bodyText = bodyLines.join('\n');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sent = await sock.sendMessage(chatId, { text: `${bodyText}\n\n_${footer}_` }, { quoted: message });
    const promptMessageId = sent?.key?.id;

    if (!promptMessageId) {
      // Couldn't get a message id back — nothing to key a reply to, fail closed.
      return { value: null, timedOut: true, cancelled: false };
    }

    const { text, cancelled, timedOut } = await new Promise<{ text: string | null; cancelled: boolean; timedOut: boolean }>(
      (resolve) => {
        const timer = setTimeout(() => {
          pending.delete(promptMessageId);
          resolve({ text: null, cancelled: false, timedOut: true });
        }, ttlMs);
        pending.set(promptMessageId, {
          kind: 'text',
          chatId,
          userId,
          resolve: (resolvedText, wasCancelled) => resolve({ text: resolvedText, cancelled: wasCancelled, timedOut: false }),
          timer,
        });
      }
    );

    if (timedOut) return { value: null, timedOut: true, cancelled: false };
    if (cancelled) return { value: null, timedOut: false, cancelled: true };

    const parsed = Number(text);
    const valid =
      Number.isFinite(parsed) &&
      (config.min === undefined || parsed >= config.min) &&
      (config.max === undefined || parsed <= config.max);

    if (valid) return { value: parsed, timedOut: false, cancelled: false };

    if (attempt < maxAttempts) {
      bodyText = `⚠️ "${text}" isn't a valid number${rangeHint}. Try again, or reply "cancel".`;
    }
  }

  return { value: null, timedOut: true, cancelled: false };
}
