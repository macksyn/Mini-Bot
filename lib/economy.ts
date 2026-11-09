// @ts-nocheck
/***
 * lib/economy.ts
 *
 * Core Groq-Economy module — coins (everyday currency) and Groq Coins
 * (scarce currency, cashable out for real airtime/cash once a threshold
 * is hit). Mirrors the Taka coins/Groq Coins model.
 *
 * Nothing in here talks to WhatsApp directly — plugins call these
 * functions and handle the messaging themselves. That keeps this file
 * testable and reusable across commands.
 *
 * Storage: uses your existing pluginStore (Mongo/Postgres/MySQL/SQLite/
 * file, whichever your env vars point to) under the 'economy' namespace,
 * split into tables: wallets, activity, withdrawals, settings.
 */

import moment from 'moment-timezone';
import { createStore } from './pluginStore.js';
import config from '../config.js';
import { getMonthlyLeaderboard, isGroupEnabled } from './activitytracker.js';
import { getJackpotPool, deductFromJackpot, settleWin, recordHouseActivity, contributeToJackpot } from './slotMachine.js';
import { cleanJid } from './isOwner.js';

const root       = createStore('economy');
const wallets     = root.table('wallets');
const withdrawals = root.table('withdrawals');
const settingsTbl = root.table('settings');
const processed   = root.table('processed');
const feePool     = root.table('feePool'); // accumulated fees from peer-to-peer exchanges
const transactionsTbl = root.table('transactions'); // per-user ledger, keyed by userId -> array
const exchangeDebtsTbl = root.table('exchangeDebts'); // per-user pending reciprocal !exchange debts, keyed by debtorId -> array
// ---- NEW: exchange history for rolling requirement ----
const exchangeHistoryTbl = root.table('exchangeHistory'); // userId -> number[] (timestamps)

const TZ = config.timeZone || 'Africa/Lagos';

// ── Settings ─────────────────────────────────────────────────────────────────

interface EconomySettings {
  coinsPerGroqCoin:        number;   // how many coins convert into 1 Groq Coin
  groqCoinWithdrawThreshold: number; // min Groq Coins balance required to request withdrawal
  workMin:             number;
  workMax:             number;
  workCooldownMs:      number;
  mineCooldownMs:      number; // cooldown between !mine attempts (default 24h — see doMine()'s same-day vs. exact-countdown messaging)
  mineMin:             number; // min total coins minted per successful !mine (before the split)
  mineMax:             number; // max total coins minted per successful !mine (before the split)
  mineMinerCutPercent: number; // % (0-100) of each mint that goes to the miner; the rest is credited to the jackpot pool
  top3Rewards:         [number, number, number]; // daily coins for whoever holds rank 1st/2nd/3rd on the monthly activity leaderboard, paid every day they hold that spot
  exchangeFeePercent:  number; // % cut taken from the Groq Coins side of a peer-to-peer !exchange, routed to the fee pool
  exchangeAllowedAmounts: number[]; // whitelist of coin amounts !exchange will accept — keeps amounts predictable and easy to type
  fineAmount:          number; // coins docked for bad-word/spam triggers (used by other plugins if wired up)
  economyGroupId:      string | null; // the ONE group JID (e.g. '1203xxxx@g.us') this economy is scoped to. null = unrestricted (any chat)
}

const DEFAULT_SETTINGS: EconomySettings = {
  coinsPerGroqCoin: Number(process.env.ECONOMY_COINS_PER_GROQCOIN) || 1,
  groqCoinWithdrawThreshold: Number(process.env.ECONOMY_GROQCOIN_WITHDRAW_THRESHOLD) || 50,
  workMin: Number(process.env.ECONOMY_WORK_MIN) || 50,
  workMax: Number(process.env.ECONOMY_WORK_MAX) || 300,
  workCooldownMs: Number(process.env.ECONOMY_WORK_COOLDOWN_MS) || 60 * 60 * 1000, // 1hr
  mineCooldownMs: Number(process.env.ECONOMY_MINE_COOLDOWN_MS) || 24 * 60 * 60 * 1000, // 24hr
  mineMin: Number(process.env.ECONOMY_MINE_MIN) || 2,
  mineMax: Number(process.env.ECONOMY_MINE_MAX) || 50,
  mineMinerCutPercent: Number(process.env.ECONOMY_MINE_MINER_CUT_PERCENT) || 50, // 50/50 split by default
  top3Rewards: [300, 200, 100],
  exchangeFeePercent: Number(process.env.ECONOMY_EXCHANGE_FEE_PERCENT) || 15,
  exchangeAllowedAmounts: [10, 20, 50, 100],
  fineAmount: Number(process.env.ECONOMY_FINE_AMOUNT) || 20,
  economyGroupId: process.env.ECONOMY_GROUP_ID || null,
};

export async function getSettings(): Promise<EconomySettings> {
  const stored = await settingsTbl.get('global');
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function updateSettings(patch: Partial<EconomySettings>): Promise<EconomySettings> {
  await settingsTbl.patch('global', patch);
  return getSettings();
}

// ── Designated-group guard ───────────────────────────────────────────────────
// If economyGroupId is set, every user-facing economy command only works in
// that one group. Unset (null) means unrestricted — useful before you've
// picked a group, but you'll almost always want this set.

export async function isEconomyChat(chatId: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.economyGroupId) return true;
  return chatId === settings.economyGroupId;
}

/**
 * Wraps a plugin handler so it silently no-ops (with a friendly message) in
 * any chat other than the designated economy group. Use for every
 * user-facing economy command; skip it for owner-only admin/withdrawal
 * review commands, which should still work from a DM.
 */
export function withEconomyGuard(handler: (sock: any, message: any, args: string[], context: any) => Promise<any>) {
  return async (sock: any, message: any, args: string[], context: any) => {
    const { chatId, channelInfo, senderId } = context;
    if (!await isEconomyChat(chatId)) {
      return sock.sendMessage(chatId, {
        text: `❌ The coins & Groq Coins economy only works in the designated group.`,
        ...channelInfo
      }, { quoted: message });
    }
    // Fire-and-forget: keep the wallet's name/phone/jid fresh from this live
    // message without delaying the actual command response. IMPORTANT: pass
    // the raw senderId (domain intact) as the 4th arg — cleanJid(senderId) is
    // still the wallet's storage key, but resolvePhone()'s @lid-unwrap logic
    // and the wallet's persisted .jid both need the un-stripped JID to work.
    if (senderId) void syncIdentity(cleanJid(senderId), sock, message?.pushName, senderId);
    return handler(sock, message, args, context);
  };
}

// ── Wallet primitives ────────────────────────────────────────────────────────

export interface Wallet {
  coins: number;
  groqCoins: number;
  dailyStreak: number;
  lastDailyDate: string | null;   // 'YYYY-MM-DD' in TZ
  lastWorkTs: number;
  lastMineTs: number;
  lifetimeCoinsEarned: number;
  lifetimeGroqCoinsEarned: number;
  exchangeCount: number;
  // Timestamp of the moment this member's LIFETIME exchangeCount first
  // crossed the Level 2 threshold (LEVEL_DEFS[1].threshold). Used to give
  // freshly-promoted members a one-time ROLLING_WINDOW_DAYS grace period
  // before the rolling-volume maintenance check (see getLevelInfo) can
  // demote them — without this anchor, the rolling check has no way to
  // distinguish "just promoted 3 days ago, hasn't had a full week yet" from
  // "been Level 2+ for months and let their volume lapse", and ends up
  // demoting brand-new Level 2 members almost immediately. Set once, never
  // cleared by later demotions (see addExchange).
  level2SinceTs: number | null;
  createdAt: number;
  name: string | null;    // best-known display first name (WhatsApp pushName/contact), for recognition
  phone: string | null;   // best-known phone number, resolved from @lid where needed
  jid: string | null;     // raw JID as last seen, domain intact (e.g. '123@lid' or '234@s.whatsapp.net').
                          // The wallet key itself (userId) has the domain stripped by cleanJid(), so this
                          // is the ONLY place that survives to build a mention that WhatsApp will actually
                          // render — never reconstruct a mention JID by guessing the domain.
  identitySyncedAt: number | null;
}

const EMPTY_WALLET: Wallet = {
  coins: 0,
  groqCoins: 0,
  dailyStreak: 0,
  lastDailyDate: null,
  lastWorkTs: 0,
  lastMineTs: 0,
  lifetimeCoinsEarned: 0,
  lifetimeGroqCoinsEarned: 0,
  exchangeCount: 0,
  level2SinceTs: null,
  createdAt: Date.now(),
  name: null,
  phone: null,
  jid: null,
  identitySyncedAt: null,
};

export async function getWallet(userId: string): Promise<Wallet> {
  const w = await wallets.get(userId);
  return w ? { ...EMPTY_WALLET, ...w } : { ...EMPTY_WALLET };
}

async function saveWallet(userId: string, wallet: Wallet): Promise<Wallet> {
  await wallets.set(userId, wallet);
  return wallet;
}

/**
 * Atomically read-modify-write a wallet via the store's own locked
 * mutate() (same lock patch() uses, keyed by physical table + key).
 *
 * IMPORTANT: raw getWallet()+saveWallet() — i.e. wallets.get()+wallets.set()
 * — are each individually a round trip to the adapter with NO lock between
 * them. wallets.patch() (used by syncIdentity) IS lock-protected, but that
 * lock only serializes patch()/mutate() calls against each other — it does
 * NOT block a concurrent, unlocked get()+set() pair from interleaving in
 * between a patch()'s own locked read and write. That's exactly how a
 * transfer's debit could vanish: syncIdentity reads a wallet, deductCoins
 * (built on raw get()+set()) reads the same wallet, deducts, and writes —
 * then syncIdentity finishes merging onto its now-stale snapshot and writes
 * it back, silently reverting the deduction. Anything that mutates a
 * wallet's fields must go through this (or wallets.patch()) instead of
 * getWallet()+saveWallet(), so it shares the one lock everything else uses.
 */
async function mutateWallet(
  userId: string,
  mutator: (wallet: Wallet) => Wallet | void
): Promise<Wallet> {
  return wallets.mutate(userId, (current: Wallet | null) => {
    const wallet = current ? { ...EMPTY_WALLET, ...current } : { ...EMPTY_WALLET };
    return mutator(wallet) || wallet;
  });
}

// ── Identity recognition (name + phone) ──────────────────────────────────────
// Every economy wallet is keyed by a normalized JID, which on its own is
// unrecognizable (raw digits, or a @lid identifier that isn't even a real
// phone number). To make wallets easy to recognize in admin tooling and
// leaderboards, we opportunistically resolve and persist a real name +
// phone number onto the wallet record — same approach used by
// plugins/birthday.ts (phone from @lid) and plugins/chatbot.ts (first name
// from pushName).

/** Extract the first real name word from a WhatsApp pushName/contact name. */
function extractFirstName(pushName: string | undefined | null): string | null {
  if (!pushName) return null;
  const tokens = pushName.trim().split(/\s+/);
  for (const token of tokens) {
    const letters = token.replace(/[^\p{L}'\-]/gu, '');
    if (letters.length >= 2) {
      return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
    }
  }
  return null;
}

/** Resolve a real phone number for a userId, unwrapping @lid identifiers when possible. */
async function resolvePhone(userId: string, sock: any): Promise<string | null> {
  const raw = userId.split('@')[0].split(':')[0];
  if (!userId.includes('@lid')) return raw || null;
  if (!sock) return null;

  // 1. Check store contacts
  const stored = sock.store?.contacts?.[userId]?.phone;
  if (stored) return stored;

  // 2. Check runtime lidToPhone map (populated from group events)
  const fromMap = sock.store?.lidToPhone?.[raw];
  if (fromMap) return fromMap;

  // 3. Ask Baileys signal repository directly — works without cached mapping
  try {
    const lidMapping = sock?.signalRepository?.lidMapping;
    const pnJid: string | null = lidMapping ? await lidMapping.getPNForLID(userId) : null;
    if (pnJid) {
      const phone = pnJid.split('@')[0].split(':')[0];
      if (sock.store?.lidToPhone) sock.store.lidToPhone[raw] = phone;
      return phone;
    }
  } catch (_) {}

  return null;
}

/** Resolve a display first name, preferring a fresh pushName over a cached contact entry. */
function resolveName(userId: string, sock: any, pushNameHint?: string | null): string | null {
  const fromHint = extractFirstName(pushNameHint);
  if (fromHint) return fromHint;

  const contact = sock?.store?.contacts?.[userId];
  const notify = contact?.notify || contact?.name || contact?.pushName;
  return extractFirstName(notify);
}

/**
 * Opportunistically fill in / refresh a wallet's name + phone so it's
 * recognizable in admin tooling and leaderboards. Cheap, non-blocking,
 * safe to call on every economy command — only writes when something
 * actually changed. Never throws.
 */
export async function syncIdentity(userId: string, sock: any, pushName?: string | null, rawJid?: string | null): Promise<void> {
  if (!userId || !sock) return;
  try {
    // Resolve against the raw JID (domain intact) when we have it — userId
    // has already had its domain stripped by cleanJid() and can never match
    // sock.store.contacts keys or trigger the @lid-unwrap branch otherwise.
    // Falls back to userId for callers that don't have the raw JID handy
    // (e.g. syncing a transfer recipient we've only ever seen as a cleaned id).
    const jidForResolution = rawJid || userId;
    const [phone, name] = [await resolvePhone(jidForResolution, sock), resolveName(jidForResolution, sock, pushName)];

    // NOTE: previously used wallets.patch() directly. Switched to
    // mutateWallet() so the "did anything actually change" comparison reads
    // the wallet under the SAME lock it writes back under — patch() reads
    // outside a lock-held snapshot boundary relative to mutate()-based
    // callers is fine (they share the lock), but computing the diff here
    // via a stale getWallet() and patching separately reopened the exact
    // stale-read/write race this function is trying to avoid causing.
    await mutateWallet(userId, (wallet) => {
      let changed = false;
      if (phone && phone !== wallet.phone) { wallet.phone = phone; changed = true; }
      if (name && name !== wallet.name) { wallet.name = name; changed = true; }
      if (rawJid && rawJid !== wallet.jid) { wallet.jid = rawJid; changed = true; }
      if (changed) wallet.identitySyncedAt = Date.now();
    });
  } catch (_) {
    // Best-effort — identity recognition should never break an economy command.
  }
}

export function todayStr(ts: number = Date.now()): string {
  return moment(ts).tz(TZ).format('YYYY-MM-DD');
}

// ── Transaction ledger ────────────────────────────────────────────────────────
// Every coin/Groq Coin movement gets an entry here so balances are auditable
// after the fact ("I never got that transfer!"). Logged automatically inside
// addCoins/deductCoins/addGroqCoins/deductGroqCoins — callers just pass a
// `meta` describing WHY the money moved; if they don't, it still gets logged
// under a generic type rather than silently skipped.

export type TransactionType =
  | 'attendance' | 'work' | 'mine' | 'top3'
  | 'transfer_out' | 'transfer_in'
  | 'exchange_out' | 'exchange_in'
  | 'convert' | 'sportybet'
  | 'slots' | 'coinflip' | 'dice'
  | 'bank_deposit' | 'bank_withdraw' | 'bank_refund'
  | 'admin_credit' | 'admin_debit' | 'admin_reset'
  | 'withdrawal_hold' | 'withdrawal_refund'
  | 'shop' | 'shop_refund'
  | 'rob_bail' | 'rob_loss' | 'rob_win' | 'rob_refund'
  | 'other';

export interface Transaction {
  id: string;
  type: TransactionType;
  currency: 'coins' | 'groqCoins';
  amount: number;       // signed: positive = credit, negative = debit
  balanceAfter: number;
  counterpartyId: string | null; // other user involved (transfer/exchange partner, admin who acted), if any
  note: string | null;
  timestamp: number;
}

export interface TransactionMeta {
  type?: TransactionType;
  counterpartyId?: string | null;
  note?: string | null;
}

const MAX_TRANSACTIONS_PER_USER = 200;

// ── Garnishment hook ─────────────────────────────────────────────────────────
// Lets another module (e.g. lib/loans.ts) intercept a share of every future
// coin credit and divert it elsewhere (e.g. toward a defaulted loan balance)
// before it lands in the wallet. Implemented as a registration hook rather
// than a direct import here to avoid a circular dependency, since the
// registering module already imports from this file. Only one handler is
// supported at a time — a later call replaces an earlier one.

export type GarnishmentHandler = (
  userId: string,
  amount: number,
  meta: TransactionMeta
) => Promise<{ garnished: number; remaining: number }>;

let garnishmentHandler: GarnishmentHandler | null = null;

export function registerGarnishmentHandler(handler: GarnishmentHandler): void {
  garnishmentHandler = handler;
}

/** Runs a positive coin credit past the registered garnishment handler (if any) and returns the amount that should actually land in the wallet. */
async function applyGarnishment(userId: string, amount: number, meta: TransactionMeta): Promise<number> {
  if (!garnishmentHandler || amount <= 0) return amount;
  try {
    const { remaining } = await garnishmentHandler(userId, amount, meta);
    return remaining;
  } catch (_) {
    // Garnishment is best-effort — never let a hook failure block the underlying credit.
    return amount;
  }
}

async function logTransaction(
  userId: string,
  entry: { currency: 'coins' | 'groqCoins'; amount: number; balanceAfter: number } & TransactionMeta
): Promise<void> {
  if (!entry.amount) return; // no-op movements aren't worth a ledger line
  try {
    const record: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: entry.type || 'other',
      currency: entry.currency,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      counterpartyId: entry.counterpartyId || null,
      note: entry.note || null,
      timestamp: Date.now(),
    };
    const existing: Transaction[] = (await transactionsTbl.get(userId)) || [];
    existing.unshift(record);
    if (existing.length > MAX_TRANSACTIONS_PER_USER) existing.length = MAX_TRANSACTIONS_PER_USER;
    await transactionsTbl.set(userId, existing);
  } catch (_) {
    // Ledger writes are best-effort — never let logging break the underlying economy action.
  }
}

/** Most recent transactions for a user, newest first. */
export async function getTransactions(userId: string, limit = 20): Promise<Transaction[]> {
  const existing: Transaction[] = (await transactionsTbl.get(userId)) || [];
  return existing.slice(0, Math.max(1, Math.min(limit, MAX_TRANSACTIONS_PER_USER)));
}

export async function addCoins(userId: string, amount: number, meta: TransactionMeta = {}): Promise<Wallet> {
  const creditAmount = await applyGarnishment(userId, amount, meta);
  const saved = await mutateWallet(userId, (wallet) => {
    wallet.coins += creditAmount;
    if (creditAmount > 0) wallet.lifetimeCoinsEarned += creditAmount;
  });
  await logTransaction(userId, { currency: 'coins', amount: creditAmount, balanceAfter: saved.coins, type: meta.type || 'admin_credit', ...meta });
  return saved;
}

export async function addGroqCoins(userId: string, amount: number, meta: TransactionMeta = {}): Promise<Wallet> {
  const saved = await mutateWallet(userId, (wallet) => {
    wallet.groqCoins += amount;
    if (amount > 0) wallet.lifetimeGroqCoinsEarned += amount;
  });
  await logTransaction(userId, { currency: 'groqCoins', amount, balanceAfter: saved.groqCoins, type: meta.type || 'admin_credit', ...meta });
  return saved;
}

export async function deductCoins(userId: string, amount: number, meta: TransactionMeta = {}): Promise<{ success: boolean; wallet: Wallet }> {
  let insufficientFunds = false;
  const saved = await mutateWallet(userId, (wallet) => {
    if (wallet.coins < amount) { insufficientFunds = true; return; }
    wallet.coins -= amount;
  });
  if (insufficientFunds) return { success: false, wallet: saved };
  await logTransaction(userId, { currency: 'coins', amount: -amount, balanceAfter: saved.coins, type: meta.type || 'admin_debit', ...meta });
  return { success: true, wallet: saved };
}

export async function deductGroqCoins(userId: string, amount: number, meta: TransactionMeta = {}): Promise<{ success: boolean; wallet: Wallet }> {
  let insufficientFunds = false;
  const saved = await mutateWallet(userId, (wallet) => {
    if (wallet.groqCoins < amount) { insufficientFunds = true; return; }
    wallet.groqCoins -= amount;
  });
  if (insufficientFunds) return { success: false, wallet: saved };
  await logTransaction(userId, { currency: 'groqCoins', amount: -amount, balanceAfter: saved.groqCoins, type: meta.type || 'admin_debit', ...meta });
  return { success: true, wallet: saved };
}

// ── Exchange History (rolling 7‑day requirement) ──────────────────────────

const EXCHANGE_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // keep 30 days
const ROLLING_WINDOW_DAYS = 7;
// This is a Groq-Coin VOLUME threshold, not a transaction count: a Level 2+
// member keeps their level as long as they've moved at least this many GC
// (summed across all their exchanges) within the trailing window. Because
// the window is rolling, this also naturally gives a grace period — a
// member's most recent qualifying exchange keeps them active for up to
// ROLLING_WINDOW_DAYS after it, and they only fall out once that activity
// ages out of the window with nothing to replace it.
const MIN_ROLLING_EXCHANGES_FOR_LEVEL_2 = 100;

interface ExchangeHistoryEntry {
  ts: number;
  amount: number; // Groq Coins moved in this exchange
}

/**
 * Get the raw exchange history (timestamp + GC amount) for a user.
 * Tolerates old-format entries (plain timestamp numbers, from before amount
 * tracking was added) by treating them as amount=1 so historical data isn't
 * discarded, just weighted the old (count-based) way until it ages out.
 */
export async function getExchangeHistory(userId: string): Promise<ExchangeHistoryEntry[]> {
  const raw = (await exchangeHistoryTbl.get(userId)) || [];
  return raw.map((entry: number | ExchangeHistoryEntry) =>
    typeof entry === 'number' ? { ts: entry, amount: 1 } : entry
  );
}

/**
 * Record a new exchange (timestamp + GC amount moved) and prune old entries
 * (>30 days).
 */
export async function recordExchange(userId: string, amount: number = 1): Promise<void> {
  const history = await getExchangeHistory(userId);
  history.push({ ts: Date.now(), amount });
  // Prune entries older than 30 days to keep storage small
  const cutoff = Date.now() - EXCHANGE_HISTORY_MAX_AGE_MS;
  const filtered = history.filter(e => e.ts > cutoff);
  await exchangeHistoryTbl.set(userId, filtered);
}

/**
 * Get the total Groq Coin volume exchanged in the last `days` days.
 */
export async function getRollingExchangeCount(
  userId: string,
  days: number = ROLLING_WINDOW_DAYS
): Promise<number> {
  const history = await getExchangeHistory(userId);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return history.filter(e => e.ts > cutoff).reduce((sum, e) => sum + e.amount, 0);
}

// ── Level definitions ──────────────────────────────────────────────────────

const LEVEL_DEFS = [
  { name: 'Novice', nextName: 'Active', threshold: 0 },
  { name: 'Active', nextName: 'Pro', threshold: 25 },
  { name: 'Pro', nextName: 'Elite', threshold: 50 },
  { name: 'Elite', nextName: 'Legend', threshold: 100 },
  { name: 'Legend', nextName: null, threshold: 200 },
] as const;

// Single source of truth for "what lifetime exchangeCount makes someone
// Level 2" — used both by getLevelInfo() and by addExchange() (to anchor
// level2SinceTs the moment this is first crossed).
const LEVEL_2_THRESHOLD = LEVEL_DEFS[1].threshold;

function createProgressBar(percent: number, size = 10): string {
  const filled = Math.round((percent / 100) * size);
  const safeFilled = Math.max(0, Math.min(size, filled));
  return `${'█'.repeat(safeFilled)}${'░'.repeat(size - safeFilled)}`;
}

/**
 * Compute level info with rolling requirement:
 * - If lifetime level >= 2 but rollingCount (Groq Coins exchanged in the
 *   trailing ROLLING_WINDOW_DAYS, NOT a transaction count) is below
 *   MIN_ROLLING_EXCHANGES_FOR_LEVEL_2, effective level is forced to 1 (Novice)
 *   — UNLESS the member is still within their one-time grace period (see
 *   `level2SinceTs` below), in which case they keep their lifetime level
 *   regardless of rolling volume.
 * - `level2SinceTs` is the timestamp (Wallet.level2SinceTs) of the moment
 *   this member's lifetime count first crossed the Level 2 threshold. For
 *   the first ROLLING_WINDOW_DAYS after that moment, the rolling-volume
 *   check is skipped entirely — a brand-new Level 2 member simply hasn't
 *   had a full window yet to accumulate MIN_ROLLING_EXCHANGES_FOR_LEVEL_2,
 *   so judging them against it immediately would demote them within days
 *   instead of after the intended week. Once the grace period elapses, the
 *   ordinary rolling check applies going forward, indefinitely — this is a
 *   one-time onboarding allowance, not a recurring grace on every dip.
 * - If `level2SinceTs` is not provided (null/undefined — e.g. an older
 *   wallet from before this field existed), no grace period is applied,
 *   matching the previous (pre-fix) behavior for that member until their
 *   next `addExchange()` call backfills it.
 * - The `isActive` flag indicates whether the user meets the rolling requirement
 *   (useful for displaying warnings).
 */
/**
 * INTERNAL — pure level math. Do not call this directly outside this file.
 * Every caller needs exchangeCount + rollingCount + level2SinceTs together to
 * get a correct answer, and it's easy to forget one (that's exactly how the
 * loans.ts bug happened — it passed exchangeCount alone, silently defaulting
 * rollingCount to 0 and level2SinceTs to null, which permanently demoted
 * every Level 2+ member back to Level 1 in that one call site).
 *
 * Use getPlayerLevel(userId) instead — it gathers all three inputs itself
 * from the single source of truth (the wallet + rolling exchange history),
 * so it's impossible to call incorrectly.
 */
function getLevelInfo(
  exchangeCount: number,
  rollingCount: number = 0,
  level2SinceTs: number | null = null
): {
  levelNumber: number;
  levelName: string;
  nextLevelName: string | null;
  progressPercent: number;
  current: number;
  next: number;
  bar: string;
  isActive: boolean;
  rollingRequired: number;
  rollingCount: number;
  exchangesNeededToMaintain: number;
  inGracePeriod: boolean;
  graceDaysLeft: number;
} {
  const safeCount = Math.max(0, Math.floor(exchangeCount || 0));
  const safeRolling = Math.max(0, Math.floor(rollingCount || 0));

  // Find base level from lifetime count
  let levelIndex = LEVEL_DEFS.length - 1;
  while (levelIndex > 0 && safeCount < LEVEL_DEFS[levelIndex].threshold) {
    levelIndex -= 1;
  }

  const baseLevelNumber = levelIndex + 1;

  // Apply rolling requirement for level 2+, respecting the one-time grace
  // period anchored to level2SinceTs.
  const minRolling = MIN_ROLLING_EXCHANGES_FOR_LEVEL_2;
  const graceWindowMs = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const graceElapsedMs = level2SinceTs != null ? Date.now() - level2SinceTs : Infinity;
  const inGracePeriod = baseLevelNumber >= 2 && graceElapsedMs < graceWindowMs;
  const graceDaysLeft = inGracePeriod
    ? Math.max(0, Math.ceil((graceWindowMs - graceElapsedMs) / (24 * 60 * 60 * 1000)))
    : 0;

  let effectiveIndex = levelIndex;
  if (baseLevelNumber >= 2 && safeRolling < minRolling && !inGracePeriod) {
    effectiveIndex = 0; // demote to level 1 (Novice)
  }

  const currentLevel = LEVEL_DEFS[effectiveIndex];
  const nextLevel = LEVEL_DEFS[effectiveIndex + 1] || null;
  const rangeStart = currentLevel.threshold;
  const rangeEnd = nextLevel ? nextLevel.threshold : rangeStart + 25;
  const totalForLevel = Math.max(1, rangeEnd - rangeStart);
  const progressPercent = nextLevel
    ? Math.min(100, Math.max(0, Math.round(((safeCount - rangeStart) / totalForLevel) * 100)))
    : 100;

  // Compute how many more exchanges needed to meet the rolling requirement
  const exchangesNeededToMaintain = Math.max(0, minRolling - safeRolling);

  return {
    levelNumber: effectiveIndex + 1,
    levelName: currentLevel.name,
    nextLevelName: currentLevel.nextName,
    progressPercent,
    current: safeCount,
    next: nextLevel ? nextLevel.threshold : safeCount,
    bar: createProgressBar(progressPercent),
    isActive: effectiveIndex >= 1 && (safeRolling >= minRolling || inGracePeriod),
    rollingRequired: minRolling,
    rollingCount: safeRolling,
    exchangesNeededToMaintain,
    inGracePeriod,
    graceDaysLeft,
  };
}

/**
 * The single public entry point for "what level is this player right now."
 * Gathers exchangeCount + rollingCount + level2SinceTs itself — from the
 * wallet and rolling exchange history, the same source of truth every
 * caller was previously expected to assemble on its own — so any plugin
 * that needs a player's level just calls this and gets a correct answer,
 * with no way to accidentally omit an input.
 *
 * Nothing is persisted here; the level is always computed fresh from
 * source data, so it can never go stale (e.g. a Level 2 member whose
 * rolling volume has quietly decayed below the maintenance threshold
 * shows up correctly as Level 1 the moment anyone asks, with no separate
 * sweep job needed to keep a stored value in sync).
 */
export async function getPlayerLevel(userId: string): Promise<ReturnType<typeof getLevelInfo>> {
  const wallet = await getWallet(userId);
  const rollingCount = await getRollingExchangeCount(userId);
  return getLevelInfo(wallet.exchangeCount, rollingCount, wallet.level2SinceTs);
}

// ── Transfer Coins ──────────────────────────────────────────
//

export async function transferCoins(fromId: string, toId: string, amount: number): Promise<{ success: boolean; reason?: string }> {
  if (amount <= 0) return { success: false, reason: 'invalid_amount' };
  if (fromId === toId) return { success: false, reason: 'self_transfer' };

  const from = await deductCoins(fromId, amount, { type: 'transfer_out', counterpartyId: toId });
  if (!from.success) return { success: false, reason: 'insufficient_funds' };

  try {
    await addCoins(toId, amount, { type: 'transfer_in', counterpartyId: fromId });
  } catch (err: any) {
    // The debit above already committed. If the credit fails (store error,
    // thrown exception in a garnishment hook, etc.) the coins must not just
    // vanish — refund the sender rather than silently eating their balance.
    // Both legs are logged loudly on failure so it's never a silent loss.
    console.error(`[economy] transfer credit failed after debit committed (from=${fromId} to=${toId} amount=${amount}):`, err?.message || err);
    try {
      await addCoins(fromId, amount, { type: 'transfer_in', counterpartyId: fromId, note: 'auto-refund: transfer credit failed' });
    } catch (refundErr: any) {
      console.error(`[economy] CRITICAL: transfer refund ALSO failed (from=${fromId} to=${toId} amount=${amount}) — funds may be stuck, needs manual reconciliation:`, refundErr?.message || refundErr);
    }
    return { success: false, reason: 'transfer_failed' };
  }

  return { success: true };
}

// ── Attendance-triggered daily bonus ──────────────────────────────────────────
// No more manual "!daily" claim — this is called once by attendance.ts right
// after it approves a submission for the day.
//
// All reward math (base amount, streak multiplier, image bonus) is resolved
// entirely inside plugins/attendance.ts using ITS OWN settings (.attendance
// settings) — attendance already tracks streak independently (dbUsers /
// userData.streak), so it's the single source of truth for that number. This
// function does not read economy settings and does not recompute anything.
//
// IMPORTANT: the reward is drawn from the SAME shared bank that backs
// !slots/!coinflip/!dice (lib/slotMachine.ts), not minted. It goes through
// settleWin() — the exact function every game payout uses — so it's capped
// down to whatever the bank can actually afford above its protected floor,
// same as a slot payout would be, rather than paid in full regardless. It's
// also recorded via recordHouseActivity() so it shows up in !reserve's daily
// stats (as a payout with no corresponding "bet", since attendance isn't a
// wager).

export async function awardAttendanceBonus(
  userId: string,
  totalReward: number,
  streak: number,
  minLevel: number = 2
): Promise<
  | { success: false; reason: 'already_awarded_today' }
  | { success: true; reward: number; capped: boolean; levelGated: boolean }
> {
  const today = todayStr();

  // Atomically CLAIM today's slot before doing any reward math. Checking
  // lastDailyDate via a plain read and only writing it back several awaits
  // later (as this used to) is a check-then-act race: two concurrent calls
  // for the same user (a duplicate attendance submission, a retry) can both
  // read "not yet awarded" before either commits, and both pay out. Doing
  // the claim as its own mutateWallet() call means only one caller can ever
  // flip lastDailyDate for a given day — everyone else is correctly told
  // it's already awarded, even if they all arrive at the exact same instant.
  let alreadyAwarded = false;
  let exchangeCountAtClaim = 0;
  let level2SinceTsAtClaim: number | null = null;
  await mutateWallet(userId, (w) => {
    if (w.lastDailyDate === today) { alreadyAwarded = true; return; }
    exchangeCountAtClaim = w.exchangeCount;
    level2SinceTsAtClaim = w.level2SinceTs;
    w.lastDailyDate = today;
    w.dailyStreak = streak;
  });
  if (alreadyAwarded) {
    return { success: false, reason: 'already_awarded_today' };
  }

  // minLevel <= 1 means the caller (attendance settings) wants the bonus
  // open to everyone — skip the rolling/level lookup entirely in that case.
  let levelNumber = 1;
  if (minLevel > 1) {
    // Fetch rolling exchange count for the last 7 days
    const rollingCount = await getRollingExchangeCount(userId, 7);
    ({ levelNumber } = getLevelInfo(exchangeCountAtClaim, rollingCount, level2SinceTsAtClaim));
  }

  if (minLevel > 1 && levelNumber < minLevel) {
    // Level too low (either lifetime <25 or rolling <100, and outside any
    // grace period) – no coin reward. The claim above already recorded
    // today's streak/date, so nothing more to write here.
    return { success: true, reward: 0, capped: false, levelGated: true };
  }

  const pool = await getJackpotPool();
  const { payout: grossPayout, capped } = settleWin(totalReward, pool);

  // The bank still pays out the full amount (and any garnished share flows
  // back in separately via the garnishment handler's own repayment path) —
  // only what actually lands in the wallet is reduced.
  if (grossPayout > 0) await deductFromJackpot(grossPayout);
  await recordHouseActivity(0, grossPayout);

  const payout = await applyGarnishment(userId, grossPayout, { type: 'attendance', note: `streak: ${streak}` });

  // Streak/attendance credit still updates even if the bank is completely
  // dry right now (payout === 0) — attendance itself was still valid, and
  // blocking that would unfairly penalize the member for the bank's state.
  // (lastDailyDate/dailyStreak were already committed by the claim above —
  // if the process crashes between the claim and this credit, the member's
  // "today" is correctly consumed and won't double-pay on retry; worst case
  // is a missed credit that support can top up, never a double credit.)
  const saved = await mutateWallet(userId, (w) => {
    w.coins += payout;
    if (payout > 0) w.lifetimeCoinsEarned += payout;
  });
  await logTransaction(userId, {
    currency: 'coins',
    amount: payout,
    balanceAfter: saved.coins,
    type: 'attendance',
    note: `streak: ${streak}${capped ? ' (capped — bank reserve low)' : ''}`,
  });

  return { success: true, reward: payout, capped, levelGated: false };
}

// ── Work command (cooldown-based random payout) ──────────────────────────────

export async function doWork(userId: string): Promise<
  | { success: false; remainingMs: number }
  | { success: true; reward: number }
> {
  const settings = await getSettings();
  const now = Date.now();

  // Same atomic-claim shape as awardAttendanceBonus: check the cooldown AND
  // flip lastWorkTs inside one mutateWallet() call so two rapid !work
  // commands can't both pass the cooldown check before either commits.
  let onCooldown = false;
  let remainingMs = 0;
  await mutateWallet(userId, (w) => {
    const readyAt = w.lastWorkTs + settings.workCooldownMs;
    if (now < readyAt) { onCooldown = true; remainingMs = readyAt - now; return; }
    w.lastWorkTs = now;
  });
  if (onCooldown) return { success: false, remainingMs };

  const grossReward = Math.floor(Math.random() * (settings.workMax - settings.workMin + 1)) + settings.workMin;
  const reward = await applyGarnishment(userId, grossReward, { type: 'work' });
  const saved = await mutateWallet(userId, (w) => {
    w.coins += reward;
    w.lifetimeCoinsEarned += reward;
  });
  await logTransaction(userId, { currency: 'coins', amount: reward, balanceAfter: saved.coins, type: 'work' });

  return { success: true, reward };
}

// ── Mine command (mints new coins, split between miner and the jackpot) ──────
// Unlike doMine's first draft, this does NOT draw from the existing bank —
// it mints fresh coins the same way doWork() does, then splits that mint
// between the miner's wallet and the jackpot pool (default 50/50, via
// mineMinerCutPercent). So each successful !mine both pays the miner AND
// grows the same reserve that backs !slots/!coinflip/!dice and the loan
// pool — net POSITIVE for bank health, unlike a command that pays out of
// the existing reserve.
//
// ACCOUNTING NOTE: the jackpot's share is credited via contributeToJackpot()
// — the same function slotMachine.ts uses for real wagered stakes. That
// function's own docstring calls the pool "real bank capital... nothing is
// ever minted from nowhere" and eco_jackpot.ts's admin view computes
// "Lifetime net" as `pool - JACKPOT_SEED`, on the assumption that ALL pool
// growth came from wagers. Once !mine feeds it too, that assumption is no
// longer true — "Lifetime net" becomes wager profit PLUS mined subsidy,
// blended together with no way to tell them apart after the fact. Fine if
// you're okay with that number meaning something slightly different now;
// if you want it to stay a pure wager-profit figure, track the mined
// contribution in its own houseStats/jackpot key instead of routing it
// through contributeToJackpot, and have !reserve show it as a separate line.
export async function doMine(userId: string): Promise<
  | { success: false; reason: 'on_cooldown'; remainingMs: number; sameDay: boolean }
  | { success: true; minted: number; minerShare: number; jackpotShare: number }
> {
  const settings = await getSettings();
  const now = Date.now();

  // Same atomic-claim shape as doWork(): check the cooldown AND flip
  // lastMineTs inside one mutateWallet() call so two rapid !mine commands
  // from the same user can't both pass the check before either commits.
  //
  // `sameDay` drives which message the plugin shows: if the last successful
  // mine was on this same TZ calendar day, a vague "come back tomorrow" is
  // enough — they're not getting through today regardless. If the calendar
  // day has already turned over (it's "tomorrow" already) but the rolling
  // 24h window since lastMineTs still hasn't elapsed (e.g. they mined at
  // 11:58pm and it's 12:03am), that's worth an exact countdown instead,
  // since they're close. The underlying cooldown itself is a plain rolling
  // 24h window either way — this only changes the wording, not the gate.
  let onCooldown = false;
  let remainingMs = 0;
  let sameDay = false;
  await mutateWallet(userId, (w) => {
    const readyAt = w.lastMineTs + settings.mineCooldownMs;
    if (now < readyAt) {
      onCooldown = true;
      remainingMs = readyAt - now;
      sameDay = todayStr(w.lastMineTs) === todayStr(now);
      return;
    }
    w.lastMineTs = now;
  });
  if (onCooldown) return { success: false, reason: 'on_cooldown', remainingMs, sameDay };

  const minted = Math.floor(Math.random() * (settings.mineMax - settings.mineMin + 1)) + settings.mineMin;
  const cutPercent = Math.min(100, Math.max(0, settings.mineMinerCutPercent));
  const minerShareGross = Math.floor(minted * (cutPercent / 100));
  const jackpotShare = minted - minerShareGross; // remainder, so the two halves always sum to `minted` exactly regardless of rounding

  if (jackpotShare > 0) await contributeToJackpot(jackpotShare);

  // Garnishment applies to the miner's share the same way it applies to
  // !work income — this is newly minted player income, not a bank
  // withdrawal, so it goes through the normal credit path.
  const minerShare = await applyGarnishment(userId, minerShareGross, { type: 'mine', note: `${cutPercent}% miner cut, ${100 - cutPercent}% to jackpot` });
  const saved = await mutateWallet(userId, (w) => {
    w.coins += minerShare;
    if (minerShare > 0) w.lifetimeCoinsEarned += minerShare;
  });
  await logTransaction(userId, {
    currency: 'coins',
    amount: minerShare,
    balanceAfter: saved.coins,
    type: 'mine',
    note: `mined ${minted} total, ${jackpotShare} to jackpot`,
  });

  return { success: true, minted, minerShare, jackpotShare };
}

// ── Top-3-on-the-monthly-leaderboard payout ──────────────────────────────────
// Rank comes from lib/activitytracker.ts's cumulative monthly POINTS
// leaderboard (messages, stickers, videos, etc. — whatever's weighted in
// !activity settings), NOT a daily-reset counter. This is re-evaluated fresh
// every time it runs: whoever holds rank 1/2/3 *right now* gets paid for
// today. No streak state to track — if someone gets overtaken, they simply
// aren't in the top 3 next time this runs, and stop earning; the person who
// overtook them starts earning immediately. The leaderboard position IS the
// streak.

/**
 * Pays out coins to whoever holds the top-3 spots on the monthly activity
 * leaderboard for a given group+date. Idempotent — safe to call more than
 * once for the same chat+date (e.g. if the bot restarts near the scheduled
 * time), it will only pay out once. Skips groups that don't have activity
 * tracking enabled (via !activity enable).
 */
export async function payoutMonthlyTop3(chatId: string, dateStr: string): Promise<Array<{ userId: string; points: number; reward: number; rank: number }>> {
  if (!await isEconomyChat(chatId)) return [];
  if (!await isGroupEnabled(chatId)) return [];

  const processedKey = `monthlyTop3:${dateStr}:${chatId}`;

  // Atomically claim this chat+date before paying anyone. The previous
  // check-then-set (processed.get() up front, processed.set() only after
  // ALL payouts finished) left the entire payout loop as an open race
  // window — two overlapping calls (e.g. the scheduler firing again right
  // as the bot restarts, exactly the scenario this function's docstring
  // already worried about) would both see "not yet processed" and both pay
  // out the full top-3 rewards. Claiming via processed.mutate() first means
  // only one caller can ever win the claim for a given key.
  let alreadyProcessed = false;
  await processed.mutate(processedKey, (current: boolean | null) => {
    if (current) { alreadyProcessed = true; return current; }
    return true;
  });
  if (alreadyProcessed) return [];

  const settings = await getSettings();
  const top3 = await getMonthlyLeaderboard(chatId, null, 3);

  const results: Array<{ userId: string; points: number; reward: number; rank: number }> = [];
  for (let i = 0; i < top3.length; i++) {
  const reward = settings.top3Rewards[i] || 0;
  if (reward > 0) {
    // ✅ Clean the userId to match the wallet key
    const cleanId = cleanJid(top3[i].userId);
    await addCoins(cleanId, reward, {
      type: 'top3',
      note: `rank ${i + 1}, ${top3[i].points} pts`
    });
  }
    results.push({ userId: top3[i].userId, points: top3[i].points, reward, rank: i + 1 });
  }

  return results;
}

// ── Withdrawals (Groq Coins -> real payout, admin-approved) ───────────────────────

export interface WithdrawalRequest {
  id: string;
  userId: string;
  groqCoins: number;
  payoutInfo: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  note: string | null;
}

export async function requestWithdrawal(userId: string, groqCoinsAmount: number, payoutInfo: string): Promise<
  | { success: false; reason: 'below_threshold' | 'insufficient_funds' | 'request_failed' }
  | { success: true; request: WithdrawalRequest }
> {
  const settings = await getSettings();
  const wallet = await getWallet(userId);

  if (groqCoinsAmount < settings.groqCoinWithdrawThreshold) {
    return { success: false, reason: 'below_threshold' };
  }
  if (wallet.groqCoins < groqCoinsAmount) {
    return { success: false, reason: 'insufficient_funds' };
  }

  // Hold the Groq Coins in escrow immediately so they can't be double-spent
  // while the request is pending.
  const escrow = await deductGroqCoins(userId, groqCoinsAmount);
  if (!escrow.success) return { success: false, reason: 'insufficient_funds' };

  const id = `wd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const request: WithdrawalRequest = {
    id,
    userId,
    groqCoins: groqCoinsAmount,
    payoutInfo,
    status: 'pending',
    requestedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    note: null,
  };

  try {
    await withdrawals.set(id, request);
  } catch (err: any) {
    // Groq Coins are already held in escrow — if the request record itself
    // fails to save, refund the escrow rather than leaving it stuck with no
    // corresponding request to resolve.
    console.error(`[economy] withdrawal request save failed after escrow committed (user=${userId} amount=${groqCoinsAmount}):`, err?.message || err);
    try {
      await addGroqCoins(userId, groqCoinsAmount, { type: 'withdrawal_refund', note: 'auto-refund: request save failed' });
    } catch (refundErr: any) {
      console.error(`[economy] CRITICAL: withdrawal escrow refund ALSO failed (user=${userId} amount=${groqCoinsAmount}) — needs manual reconciliation:`, refundErr?.message || refundErr);
    }
    return { success: false, reason: 'request_failed' };
  }

  return { success: true, request };
}

export async function listWithdrawals(status?: WithdrawalRequest['status']): Promise<WithdrawalRequest[]> {
  const all = await withdrawals.getAll();
  const list = Object.values(all) as WithdrawalRequest[];
  return status ? list.filter(w => w.status === status) : list;
}

export async function getWithdrawal(id: string): Promise<WithdrawalRequest | null> {
  return withdrawals.get(id);
}

export async function resolveWithdrawal(
  id: string,
  adminId: string,
  approve: boolean,
  note?: string
): Promise<{ success: boolean; reason?: string; request?: WithdrawalRequest }> {
  const request: WithdrawalRequest | null = await withdrawals.get(id);
  if (!request) return { success: false, reason: 'not_found' };
  if (request.status !== 'pending') return { success: false, reason: 'already_resolved' };

  if (!approve) {
    // Refund the escrowed Groq Coins back to the user
    await addGroqCoins(request.userId, request.groqCoins);
  }

  request.status = approve ? 'approved' : 'rejected';
  request.resolvedAt = Date.now();
  request.resolvedBy = adminId;
  request.note = note || null;
  await withdrawals.set(id, request);

  return { success: true, request };
}

export async function markWithdrawalPaid(id: string, adminId: string, note?: string): Promise<{ success: boolean; reason?: string; request?: WithdrawalRequest }> {
  const request: WithdrawalRequest | null = await withdrawals.get(id);
  if (!request) return { success: false, reason: 'not_found' };
  if (request.status !== 'approved') return { success: false, reason: 'not_approved' };

  request.status = 'paid';
  request.resolvedAt = Date.now();
  request.resolvedBy = adminId;
  request.note = note || request.note;
  await withdrawals.set(id, request);

  return { success: true, request };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(type: 'coins' | 'groqcoins', limit = 10): Promise<Array<{ userId: string; amount: number }>> {
  const all = await wallets.getAll();
  return Object.entries(all)
    .map(([userId, w]: [string, any]) => ({ userId, amount: type === 'coins' ? (w.coins || 0) : (w.groqCoins || 0) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

// ── Admin utilities ───────────────────────────────────────────────────────────

export async function resetWallet(userId: string): Promise<void> {
  const prior = await getWallet(userId);
  if (prior.coins) await logTransaction(userId, { currency: 'coins', amount: -prior.coins, balanceAfter: 0, type: 'admin_reset' });
  if (prior.groqCoins) await logTransaction(userId, { currency: 'groqCoins', amount: -prior.groqCoins, balanceAfter: 0, type: 'admin_reset' });
  await wallets.set(userId, { ...EMPTY_WALLET, createdAt: Date.now() });
}

/**
 * ONE-OFF MAINTENANCE UTILITY — backfill `level2SinceTs` for wallets that
 * reached Level 2 (lifetime exchangeCount >= LEVEL_2_THRESHOLD) before
 * that field existed.
 *
 * Without this, those members have `level2SinceTs === null` forever (it's
 * only ever set going forward, inside addExchange(), the moment someone
 * NEWLY crosses the threshold — members already past it won't cross it
 * again). getLevelInfo() treats null as "no grace period", so they'd
 * remain exposed to the rolling-volume demotion bug retroactively fixed
 * here, instead of getting the intended 7-day cushion.
 *
 * `anchorTs` defaults to "now", meaning affected members get a fresh
 * full 7-day grace period starting from whenever you run this script —
 * NOT backdated to whenever they actually first hit Level 2 (that
 * moment isn't recoverable; it was never recorded). Pass an explicit
 * timestamp if you want a shorter/backdated window instead.
 *
 * Safe to run multiple times — only touches wallets where
 * level2SinceTs is still null, so it never overwrites a real value
 * (including one this same script already set on a prior run).
 *
 * Not wired to any command; run it once via
 * scripts/backfillLevel2SinceTs.ts (see that file) and remove/ignore
 * afterward.
 */
export async function backfillLevel2SinceTs(anchorTs: number = Date.now()): Promise<{
  scanned: number;
  updated: number;
  updatedUserIds: string[];
}> {
  const all = await wallets.getAll();
  const userIds = Object.keys(all || {});
  const updatedUserIds: string[] = [];

  for (const userId of userIds) {
    const raw = all[userId];
    const w = { ...EMPTY_WALLET, ...raw };
    const qualifies = (w.exchangeCount || 0) >= LEVEL_2_THRESHOLD && w.level2SinceTs == null;
    if (!qualifies) continue;

    await mutateWallet(userId, (wallet) => {
      // Re-check inside the lock in case something else set it between
      // the getAll() snapshot above and now.
      if ((wallet.exchangeCount || 0) >= LEVEL_2_THRESHOLD && wallet.level2SinceTs == null) {
        wallet.level2SinceTs = anchorTs;
      }
    });
    updatedUserIds.push(userId);
  }

  return { scanned: userIds.length, updated: updatedUserIds.length, updatedUserIds };
}

/**
 * ONE-OFF SUPPORT UTILITY — manually (re)anchor a *specific* member's
 * `level2SinceTs` to `anchorTs` (defaults to now), giving them a fresh
 * MIN_ROLLING_EXCHANGES_FOR_LEVEL_2 grace window starting from that moment.
 *
 * Unlike backfillLevel2SinceTs(), this DOES overwrite an existing (e.g.
 * stale/expired) level2SinceTs — it's for support cases where a member's
 * grace period lapsed through no fault of their own (a bug denied them the
 * bonus that would've kept their rolling volume up) and you want to restore
 * them to Level 2 with a clean 7-day window, not just backfill a null.
 *
 * Does NOT touch exchangeCount — only makes sense for wallets that already
 * have exchangeCount >= LEVEL_2_THRESHOLD; it will not promote someone who
 * hasn't actually reached Level 2 lifetime.
 *
 * Not wired to any command; run via scripts/resetLevel2Grace.ts.
 */
export async function resetLevel2Grace(
  userId: string,
  anchorTs: number = Date.now()
): Promise<{ success: boolean; reason?: 'below_level_2_threshold'; wallet?: Wallet }> {
  let reason: 'below_level_2_threshold' | undefined;
  const wallet = await mutateWallet(userId, (w) => {
    if ((w.exchangeCount || 0) < LEVEL_2_THRESHOLD) {
      reason = 'below_level_2_threshold';
      return;
    }
    w.level2SinceTs = anchorTs;
  });
  if (reason) return { success: false, reason };
  return { success: true, wallet };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// ── Peer-to-peer exchange (Taka-style "beans" trade) ─────────────────────────
// Unlike convertCoinsToGroqCoins (self-service conversion, kept above for any
// other callers), THIS is the mechanic behind the !exchange command: you
// spend your own coins, but the resulting Groq Coins land in the TARGET
// member's wallet, minus a fee that's routed to the fee pool rather than
// disappearing or going to either party. To get your own Groq Coins, someone
// else has to run !exchange targeting you.

/** Add to the persistent fee pool (Groq Coins collected from !exchange fees). */
export async function addToFeePool(amount: number): Promise<number> {
  if (amount <= 0) return getFeePoolBalance();
  const current = (await feePool.get('groqCoins')) || 0;
  const updated = current + amount;
  await feePool.set('groqCoins', updated);
  return updated;
}

/** Current fee pool balance, in Groq Coins. */
export async function getFeePoolBalance(): Promise<number> {
  return (await feePool.get('groqCoins')) || 0;
}

/** Owner-only: drain the fee pool (e.g. after spending it on something), returning what was drained. */
export async function drainFeePool(): Promise<number> {
  const current = await getFeePoolBalance();
  await feePool.set('groqCoins', 0);
  return current;
}

export async function exchangeWithMember(senderId: string, targetId: string, coinsAmount: number): Promise<
  | { success: false; reason: 'invalid_amount' | 'amount_not_allowed' | 'self_exchange' | 'below_minimum' | 'insufficient_funds' | 'exchange_failed' }
  | { success: true; coinsSpent: number; groqCoinsGained: number; fee: number; debtResolved: boolean; debtResolvedAmount?: number }
> {
  if (!coinsAmount || coinsAmount <= 0) return { success: false, reason: 'invalid_amount' };
  if (senderId === targetId) return { success: false, reason: 'self_exchange' };

  const settings = await getSettings();

  // Amount must be one of the admin-configured whitelist (default
  // 10/20/50/100) — keeps !exchange predictable rather than arbitrary
  // amounts. NOTE: this is independent of coinsPerGroqCoin (the conversion
  // rate) — if coinsPerGroqCoin is set higher than an allowed amount, that
  // amount will still fail with 'below_minimum' below. Keep the two settings
  // coherent (e.g. set coinsPerGroqCoin <= the smallest allowed amount) if
  // you want every whitelisted amount to actually be usable.
  if (!settings.exchangeAllowedAmounts.includes(coinsAmount)) {
    return { success: false, reason: 'amount_not_allowed' };
  }

  if (coinsAmount < settings.coinsPerGroqCoin) {
    return { success: false, reason: 'below_minimum' };
  }

  // Only the portion of coinsAmount that converts evenly is actually spent
  // (same rounding behavior as convertCoinsToGroqCoins).
  const groqCoinsGross = Math.floor(coinsAmount / settings.coinsPerGroqCoin);
  const coinsToSpend = groqCoinsGross * settings.coinsPerGroqCoin;

  const spend = await deductCoins(senderId, coinsToSpend, { type: 'exchange_out', counterpartyId: targetId });
  if (!spend.success) return { success: false, reason: 'insufficient_funds' };

  const feePercent = settings.exchangeFeePercent;
  const fee = Math.floor(groqCoinsGross * feePercent / 100);
  const netGroqCoins = groqCoinsGross - fee;

  try {
    if (netGroqCoins > 0) await addGroqCoins(targetId, netGroqCoins, { type: 'exchange_in', counterpartyId: senderId });
    if (fee > 0) await addToFeePool(fee);
  } catch (err: any) {
    // Coins were already spent — if crediting the target's Groq Coins (or
    // the fee pool) throws partway through, refund the sender's coins
    // rather than letting them vanish. Logged loudly either way so a
    // partial failure is never silent.
    console.error(`[economy] exchange credit failed after debit committed (sender=${senderId} target=${targetId} coinsSpent=${coinsToSpend}):`, err?.message || err);
    try {
      await addCoins(senderId, coinsToSpend, { type: 'exchange_out', counterpartyId: senderId, note: 'auto-refund: exchange credit failed' });
    } catch (refundErr: any) {
      console.error(`[economy] CRITICAL: exchange refund ALSO failed (sender=${senderId} target=${targetId} coinsSpent=${coinsToSpend}) — needs manual reconciliation:`, refundErr?.message || refundErr);
    }
    return { success: false, reason: 'exchange_failed' };
  }

  // Counts toward the SENDER's exchange-level progress (lifetime: +1 transaction;
  // rolling 7-day requirement: +netGroqCoins actually moved).
  await addExchange(senderId, 1, netGroqCoins);

  // Reciprocal debt bookkeeping: if the sender previously benefited from an
  // exchange FROM the target (i.e. sender already owed target a reciprocal),
  // this exchange settles that debt. Either way, the target now owes the
  // sender a reciprocal exchange going forward — that's the whole "Peter
  // sends Paul, so now Paul owes Peter" loop.
  const { resolved: debtResolved, amount: debtResolvedAmount } = await resolveOldestDebt(senderId, targetId);
  await addDebt(targetId, senderId, coinsToSpend);

  return { success: true, coinsSpent: coinsToSpend, groqCoinsGained: netGroqCoins, fee, debtResolved, debtResolvedAmount };
}

// ── Reciprocal exchange debt ledger ───────────────────────────────────────────
// Tracks, per debtor, who they still "owe" a reciprocal !exchange to. Purely
// informational (nothing is auto-charged) — powers the "who owes me" /
// "who do I owe" views and the post-exchange nudge message.

interface ExchangeDebt {
  id: string;
  creditorId: string; // the person who is owed a reciprocal exchange
  amount: number;     // coin amount of the exchange that created this debt (what a reciprocal should match)
  timestamp: number;
}

const MAX_DEBTS_PER_USER = 100;

async function addDebt(debtorId: string, creditorId: string, amount: number): Promise<void> {
  try {
    const list: ExchangeDebt[] = (await exchangeDebtsTbl.get(debtorId)) || [];
    list.push({ id: `debt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, creditorId, amount, timestamp: Date.now() });
    if (list.length > MAX_DEBTS_PER_USER) list.splice(0, list.length - MAX_DEBTS_PER_USER);
    await exchangeDebtsTbl.set(debtorId, list);
  } catch (_) {
    // Best-effort — debt tracking should never break the underlying exchange.
  }
}

/** Resolves (removes) the oldest debt debtorId owes to creditorId, if any. Returns whether one was found and its amount. */
async function resolveOldestDebt(debtorId: string, creditorId: string): Promise<{ resolved: boolean; amount?: number }> {
  try {
    const list: ExchangeDebt[] = (await exchangeDebtsTbl.get(debtorId)) || [];
    const idx = list.findIndex(d => d.creditorId === creditorId);
    if (idx === -1) return { resolved: false };
    const [removed] = list.splice(idx, 1);
    await exchangeDebtsTbl.set(debtorId, list);
    return { resolved: true, amount: removed.amount };
  } catch (_) {
    return { resolved: false };
  }
}

/** Reciprocal exchanges this user still owes to others (they received, haven't paid back yet). */
export async function getDebtsOwedByUser(userId: string): Promise<ExchangeDebt[]> {
  return (await exchangeDebtsTbl.get(userId)) || [];
}

/** Who still owes THIS user a reciprocal exchange (they sent coins to these people, no payback yet). */
export async function getDebtsOwedToUser(userId: string): Promise<Array<{ debtorId: string; amount: number; timestamp: number }>> {
  const all = (await exchangeDebtsTbl.getAll()) || {};
  const results: Array<{ debtorId: string; amount: number; timestamp: number }> = [];
  for (const [debtorId, list] of Object.entries(all as Record<string, ExchangeDebt[]>)) {
    for (const d of list) {
      if (d.creditorId === userId) results.push({ debtorId, amount: d.amount, timestamp: d.timestamp });
    }
  }
  return results.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Exchange count updater (also records history) ────────────────────────────

export async function addExchange(userId: string, countIncrement = 1, groqCoinsVolume: number = countIncrement): Promise<Wallet> {
  const saved = await mutateWallet(userId, (w) => {
    // Lifetime tier (Novice/Active/Pro/...) is a count of exchange
    // transactions, independent of how much GC each one moved.
    const wasBelowLevel2 = w.exchangeCount < LEVEL_2_THRESHOLD;
    w.exchangeCount += countIncrement;
    // Anchor the grace-period clock the instant they first cross into
    // Level 2 lifetime-wise. Never overwritten afterward — a later
    // rolling-volume demotion does NOT reset this, so grace only applies
    // once, on initial promotion, not every time someone dips and recovers.
    if (wasBelowLevel2 && w.exchangeCount >= LEVEL_2_THRESHOLD && !w.level2SinceTs) {
      w.level2SinceTs = Date.now();
    }
  });
  // Rolling 7-day requirement is GC VOLUME, not transaction count — record
  // the actual amount moved in this exchange.
  await recordExchange(userId, groqCoinsVolume);
  return saved;
}