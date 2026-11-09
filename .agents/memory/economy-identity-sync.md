---
name: Economy wallet identity sync
description: How and where economy wallets get a recognizable name/phone attached, and why it's centralized in one place.
---

Economy wallets are keyed by a normalized JID (digits, or a `@lid` identifier), which is not
human-recognizable on its own. `lib/economy.ts` exports `syncIdentity(userId, sock, pushNameHint?)`
which opportunistically resolves and persists `wallet.name` / `wallet.phone`, using the same
resolution strategy already proven in `plugins/birthday.ts` (phone: store.contacts → runtime
`lidToPhone` map → `sock.signalRepository.lidMapping.getPNForLID`) and `plugins/chatbot.ts`
(name: first-letter-capitalized first token extracted from pushName/contact name, stripping emoji).

**Why:** Every plugin that touched wallets was duplicating ad-hoc `@${targetId}` mention-only
output with no durable record of who a wallet actually belongs to, making admin lookups and
leaderboards unrecognizable. Centralizing avoided re-deriving the @lid/pushName dance in every
plugin and keeps the resolution logic consistent with birthday/chatbot's already-battle-tested
approach.

**How to apply:**
- `withEconomyGuard` (in `lib/economy.ts`) fire-and-forget calls `syncIdentity` for the sender on
  every guarded command — covers balance/give/exchange/slots/coinflip/jackpot/leaderboard/topactive.
- Plugins that write to *another* user's wallet without that user's own live message (`eco_give.ts`
  recipient, `eco_admin.ts` targets) call `syncIdentity(targetId, sock)` explicitly (no pushName
  hint available — falls back to cached `sock.store.contacts`).
- `attendance.ts` calls it directly too (separate guard from the economy group guard), preferring
  the attendance form's own extracted name over pushName.
- The sync only writes when the resolved phone/name actually differs from what's stored — cheap,
  non-blocking, never throws (best-effort, wrapped in try/catch internally).
