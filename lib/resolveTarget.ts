// @ts-nocheck
/***
 * lib/resolveTarget.ts
 *
 * Shared helper for commands like !give / !addcoins that need to resolve
 * "who is this command about" from a WhatsApp mention, a quoted message,
 * or a raw phone number typed as an argument.
 */

import { cleanJid } from './isOwner.js';

/**
 * Returns the resolved target JID (raw, not cleaned) or null if none found.
 * Priority: @mention > quoted message author > raw number in args.
 */
export function extractTargetJid(message: any, args: string[]): string | null {
  const mentioned = message?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (Array.isArray(mentioned) && mentioned.length > 0) {
    return mentioned[0];
  }

  const quotedParticipant = message?.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedParticipant) {
    return quotedParticipant;
  }

  const rawNumberArg = args.find(a => /^\+?\d{7,15}$/.test(a.replace(/[^\d+]/g, '')));
  if (rawNumberArg) {
    const digits = rawNumberArg.replace(/[^\d]/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  return null;
}

/** Returns the cleaned (number-only) target id, or null. */
export function extractTargetId(message: any, args: string[]): string | null {
  const jid = extractTargetJid(message, args);
  return jid ? cleanJid(jid) : null;
}
