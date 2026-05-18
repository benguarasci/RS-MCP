---
description: Continuous per-conversation monitoring across all customers. Runs every few hours, reads each new/updated conversation message-by-message, flags AI failures, and writes them to Notion as MONITORING issues. No email — Notion is the substrate. Feeds daily-pulse (clusters) and health-check (trends). Use scheduled, not manually.
argument-hint: optional comma-separated company IDs to scope this run (default: all companies)
---

You're a continuous observer of the AI agent's conversations. Each run: pick up every conversation created or updated since the last run, read its messages, flag anything obviously wrong, and write findings to Notion. No email. The output is the Notion state — daily-pulse and health-check consume it later.

# When to use this

- **conversation-watch** (this one) — runs every 2-4 hours via cron, processes new/updated conversations across the entire portfolio, writes flags to Notion. The substrate.
- **customer-watch** — manually-curated focused-attention tool for at-risk customers. Reads same Notion DB.
- **daily-pulse** — clusters Layer 0 flags across customers, sends daily email.
- **health-check** — weekly trends across all layers.

# Required MCP tools

- Postgres MCP (read-only DB)
- Notion MCP `notion-query-database-view` (primary lookup), `notion-fetch` (body reads), `notion-update-page` + `notion-create-pages` (writeback) on `Self learning db` (`collection://35f9fe3f-af42-80ba-bf81-000b602adf12`)

If Postgres is missing, stop and report. If Notion is missing, stop — there's no point continuing without the writeback target.

This skill **never sends email**. No Gmail, no RS-DB send_email. If you find yourself drafting an email, you're misusing this skill.

# Configuration

- **Scope**: first arg, optional. If provided, restrict to those company IDs. If empty, process all companies. Operator uses scoping for testing; production runs are unscoped.
- **Time window**: from the most recent prior conversation-watch run's `Run date` (the `Run date` property on the `cw-state` record — see Step 6) up to now. If `cw-state` doesn't exist yet, default to the last 4 hours.

# Namespace

This skill maintains exactly one Notion record: `cw-state` (`Issue Type = System`). Every symptom it tracks lives as a section inside that record's body — it never writes per-issue rows. customer-watch owns the separate `cs-` namespace; daily-pulse owns `cl-state`. **Never read or write `cs-` rows, and never touch `cl-state`.** If you find yourself about to create any row other than `cw-state`, stop.

# Step 1 — Read the cw-state record

This skill maintains a single consolidated record, `cw-state`, in the `Self learning db` data source. Its body holds every tracked symptom as a `### cw-{customer}-{symptom}` section under `## Active issues` / `## Resolved issues`. The old per-issue-row format is retired — there is no per-row map to build.

## 1a. Locate cw-state

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the **`system-watch-lookup`** view — pre-filtered to `Issue Type = System`. **Do not use the `customer-watch-lookup` view** (`?v=3609fe3faf428049bc99000cd69e28a3`) — that one filters to `Issue Type = Customer` and will not return `cw-state`. Iterate pagination until exhausted, then pick the single row with Name exactly `cw-state`.

- If `cw-state` exists, that's your record.
- If `cw-state` does not exist (first ever run), there are no known issues yet — you'll create the record in Step 6.
- Ignore every other row: `cl-state` belongs to daily-pulse, `cs-*` rows belong to customer-watch, and any legacy per-issue `cw-*` rows are retired. Never read or write them.

## 1b. Fetch and parse the body

`notion-fetch` the `cw-state` page. From its body, read every `### cw-{customer}-{symptom}` section under `## Active issues` and `## Resolved issues`. Each section carries: Status, Streak, Clean runs since last sighting, Customer, Last sighted, Sample convs, Detection signal, Issue, and Notes.

This parsed set is your **known-issues map** for the rest of the run, keyed by the exact `cw-{customer}-{symptom}` slug. The `Detection signal` field on each section is what you evaluate new conversations against.

## 1c. Drop NON ISSUE

Skip any section whose Status is `NON ISSUE` — never re-flag or resurrect it.

## 1d. Hard precondition

Before any writeback the known-issues map must be in hand. If the view query failed, abort the writeback and surface the failure. Do not "best-effort create" a fresh `cw-state` — that would clobber existing history.

# Step 2 — Determine the window

Window start = the `Run date` property on the `cw-state` record (the timestamp of this skill's previous run). Window end = now. If `cw-state` doesn't exist yet, default to 4 hours back.

**Strict rules** (same as customer-watch):

- Use ONLY `cw-state`'s `Run date` property. Never `Last edited time`, `Created time`, or any other timestamp.
- Treat date-only values as midnight UTC.
- When writing Run date, always write as a datetime (ISO with time component, `2026-05-14T22:00:00.000Z`).

# Step 3 — Pull conversations to process

## Schema (source: `prisma/schema.prisma`)

You will be reading two tables. **Pay attention — there is also a `Message` table in this schema for an unrelated chat feature; do not query it. The right table is `ConversationMessage`.**

**`Conversation`** — one row per prospect conversation thread.

- `id` (int), `createdAt`, `updatedAt`, `lastMessageAt` (all `timestamp without time zone`, stored UTC)
- `companyId` (int, FK → `Company.id`)
- `userId` (int, nullable — prospect user)
- `adminRating` (int, nullable)
- `summary` (text, nullable) — **do not rely on this**, it's a post-hoc rollup, often wrong
- `evaluation`, `evaluationUpdatedAt`
- **There is no `messageCount` column.** If you want a count, COUNT-join `ConversationMessage`.

**`ConversationMessage`** — one row per message inside a conversation.

- `id` (int), `createdAt`, `updatedAt`
- `conversationId` (int, FK → `Conversation.id`) — the join you want
- `senderType` (enum `ConversationMessageRole`) — tells you whether AI or prospect sent it
- `senderId` (int, nullable)
- `receiverType`, `receiverId`
- `messageType` (enum `ConversationMessageType`)
- `body` (text) — the actual message content; read this, not summaries
- `listingId` (int, nullable — set when the AI references a specific listing)
- `metadata` (jsonb — sometimes contains error info, e.g. 'Agent Off Hours' suppression)
- `cronAction` (enum, nullable — set for system-generated messages)

## Query

Pull conversations where `updatedAt >= window_start` AND `updatedAt <= now` from `Conversation`. If a scope filter was provided, restrict to those `companyId` values. Join `Company` if you need the company name for reporting.

**Read every conversation in the window. No skipping, no cheap filters, no length thresholds.** A short bot-only thread can still hide a real AI failure, and the window is small enough that the cost of reading all of it is acceptable. If volume ever becomes a real problem, raise it then — don't pre-optimize by dropping signal.

For each conversation, fetch its messages:

```sql
SELECT id, "conversationId", "senderType", body, "createdAt", metadata
FROM "ConversationMessage"
WHERE "conversationId" IN (...)
ORDER BY "conversationId", id;
```

For large windows, batch the IN list (5-10 conv IDs per query) to keep result size manageable. If individual message bodies are huge, `LEFT(body, 600)` is usually enough to judge AI behavior.

Both sides matter — read AI-sent messages AND prospect-sent messages.

# Step 4 — Per-conversation review

For each conversation in the filtered list, read the messages and ask: **did the AI do something obviously wrong?**

This is the same criteria as customer-watch Step 4 — examples of "obviously wrong":

- AI quoted a price that doesn't match listing data
- AI offered a property in the wrong city / way out of region
- AI agreed to something it can't deliver (a tour at a time without availability, a unit type that doesn't exist)
- AI dropped the close-loop — confirmed nothing after a long exchange
- AI gave clearly hallucinated information (made-up building names, fabricated policies)
- AI handed off to a human when it shouldn't have, or *didn't* hand off when it should have
- AI repeated itself / got stuck in a loop
- Tour booking failed silently
- Stale availability quoted from prior context
- Conversation had a wrong-bedroom / wrong-property reminder
- Backend threading bug — multiple prospects merged in one thread

**Single instance is enough.** One flagged conversation creates or updates a MONITORING issue section in `cw-state`.

For each flagged conversation, decide:

1. **Does it match a known issue's detection signal for this customer?**
   - If yes: append the conv ID to that issue section's Sample convs (replace, keep most recent 3). Increment Streak (sighting count for MONITORING; reset to 0 for OPEN/HIGH ALERT since signal fired).
2. **Is it a new pattern?**
   - Form a kebab-case slug describing the failure
   - Note 1+ example conv IDs
   - Mark for addition as a new MONITORING section in Step 6

## Avoid double-flagging the same conversation

Track which conv IDs you process this run. If the same conversation matches two known issues, that's fine — append to both. But never write the same conv ID twice into the same row's Sample Convs.

If a conv ID already appears in the issue section's existing Sample convs from a prior run, don't increment Streak — that conversation has already been counted.

## Tally the run counts

While reviewing conversations this run, maintain two integers for the Run ledger (Step 6):

- **processed** — the total number of conversations in this run's window (every conversation pulled in Step 3, no filtering). Same number you report in chat report-back.
- **flagged** — the count of DISTINCT conversation IDs that triggered at least one symptom this run, i.e. a conversation that created a new `### cw-...` section or appended its conv ID to an existing one. Count each conversation once, even if it matched two or more symptoms. A conversation you read but did not flag does not count here.

`flagged` is always <= `processed`. If `flagged` exceeds `processed`, you double-counted a conversation — recheck before writeback.

# Step 5 — Status transitions (same as customer-watch Step 3)

For each issue touched this run, apply the standard transitions:

- **MONITORING** (Streak = sighting count). Sighted this run → Streak += 1. At Streak >= 3 → flip to OPEN, reset Streak to 0. Not sighted → no change.
- **OPEN** (Streak = clean-run count). Sighted this run → Streak = 0. Not sighted → Streak += 1. At Streak >= 30 with no firing this run → flip to RESOLVED.
- **HIGH ALERT** (Streak = clean-run count, sticky). Sighted → Streak = 0. Not sighted → Streak += 1. At Streak >= 10 → step down to OPEN, preserve Streak.
- **RESOLVED**. Sighted this run → flip to OPEN (regression), Streak = 0. Otherwise no change.
- **NON ISSUE**. Skip entirely.

## MONITORING auto-dismissal

A MONITORING issue may auto-dismiss to RESOLVED only when BOTH hold: (a) at least **7 days since first sighting** (use the first-sighted date recorded in the issue section's Notes), AND (b) no sightings in that 7+ day window. Track in the section's Notes: `"first sighted 2026-05-08; 4 clean runs since"`. If the issue was first sighted less than 7 days ago, leave it MONITORING regardless of clean-run count. Every RESOLVED write must include a rationale — see Hard rules.

# Step 6 — Notion writeback

This skill writes exactly one record: `cw-state`. You rewrite its whole body each run — assemble the full new body in memory, then write it once.

## Assemble the new cw-state body

```markdown
- **Last run:** <ISO datetime this writeback finishes>
- **Window this run:** <window_start> → <now>
- **Run count:** <prior run count + 1>
- **Conversations processed this run:** <processed>
- **Conversations flagged this run:** <flagged>
- **Last run summary:** <one line — conversations processed, companies touched, new flags>

## Run ledger

- <ISO datetime of this run> — processed <processed>, flagged <flagged>
- <prior run line, carried forward verbatim>
- ... (one line per run, newest first, keep only lines from the last 8 days)

## Active issues

### cw-{customer}-{issue}
- **Status:** MONITORING | OPEN | HIGH ALERT
- **Streak:** <number>
- **Clean runs since last sighting:** <number>
- **Customer:** <customer name>
- **Last sighted:** <ISO datetime of most recent sighting>
- **Sample convs:** <up to 3 conversation IDs, most recent>
- **Detection signal:** <mechanical pattern — see below>
- **Issue:** <one sentence — what's wrong from the customer's perspective>
- **Notes:** <one short line — sighting / clean-run state, plus the first-sighted date>

## Resolved issues

### cw-{customer}-{issue}
- (same fields; Notes carries the RESOLVED rationale)
```

Rules for assembling it:

- **Carry forward every existing section unchanged** except the ones touched this run. A `replace_content` that drops untouched issues loses history — assemble from the full parsed map (Step 1), not just this run's changes.
- For an existing issue sighted or transitioned this run: update its Status, Streak, Clean runs since last sighting, Last sighted, Sample convs, and Notes. **Detection signal and Issue stay stable** — never rewrite them once set.
- For a new pattern found this run: add a new `### cw-{customer}-{issue}` section under `## Active issues`, Status `MONITORING`, with the full field set.
- **Slugs are stable forever.** A `### cw-{customer}-{issue}` heading never changes once created — that's how history is preserved across runs.
- When an issue flips to `RESOLVED`, move its section under `## Resolved issues`. If a RESOLVED issue regresses (its signal fires again), move it back under `## Active issues`.
- Skip `NON ISSUE` sections — leave them as they are; never re-flag them.
- **Run ledger:** prepend exactly one line for this run to `## Run ledger`, formatted `- <ISO datetime> — processed <N>, flagged <K>`. Use the same ISO datetime (to the second, UTC) as the `Run date` property. Carry forward every prior ledger line verbatim, then drop any line whose timestamp is more than 8 days before now. Newest line first. If `## Run ledger` does not exist yet (records written before this skill version), create it with just this run's line.
- The `## Run ledger` section is append-and-prune only — never edit or reorder existing lines, never collapse them. daily-pulse reads these raw lines to compute the conversation-health score; rewriting history there corrupts the trend.

**Detection signal** must be mechanical: describe the pattern in terms of message content (what the AI said, what the prospect said), property/building involvement, error codes, or state metrics. NEVER reference `Conversation.summary`. Future runs evaluate this field against message content.

## Write cw-state back

- **If `cw-state` exists** (found in Step 1): `notion-update-page` with `command: replace_content`, passing the full new body as `new_str`; then `update_properties` for the page-level properties below.
- **If `cw-state` does not exist** (first ever run): `notion-create-pages` with parent `{"type": "data_source_id", "data_source_id": "35f9fe3f-af42-80ba-bf81-000b602adf12"}`, the assembled body as `content`, and the properties below.

Page-level properties on `cw-state`:

- **Name** (title): `cw-state` — never changes
- **Issue Type** (select): `System` (the actual Notion field name is `Issue Type`, not `Type`)
- **Status** (select): `OPEN` — an operational marker only; semantically meaningless on this record (per-issue status lives in the body)
- **Companies count** (number): number of companies with conversations processed this run
- **Run date** (datetime): **the exact UTC time the writeback finishes**, ISO with time component to the second (e.g. `2026-05-15T01:43:08.000Z`). **Do not round to the nearest hour or midnight** — the next run uses this as its window start, so rounding gives the wrong window. If you don't know "now" precisely, query the DB with `SELECT NOW()`.
- **Notes** (text): one short line, e.g. `Run 14 — processed 87 conversations across 12 companies; 3 new MONITORING flags.`

`cw-state` is the only state this skill maintains across runs; the next run reads its `Run date` as the window start. There is no separate `cw-heartbeat` row — that singleton is retired; `cw-state` absorbs its role.

**Hard rules against clobbering:**

- Never `notion-create-pages` when `cw-state` already exists — that creates a duplicate. Update the existing record in place.
- Never write a second `cw-state`, never write per-issue `cw-*` rows, never write `cl-state` or `cs-*` rows.
- Every `### cw-{customer}-{issue}` slug must match that pattern exactly. No suffixes, no `cs-` prefix ever.

# Hard rules

- Read-only on the DB.
- **Read message-level data, not summaries.** Every conversation check must read actual `ConversationMessage` rows (NOT `Message` — that's a different table for an unrelated chat feature). `Conversation.summary` is a post-hoc rollup and unreliable; use only as orientation hint, never as source of truth.
- **No email.** This skill writes to Notion only.
- No emojis.
- Never propose fixes, file tickets, recommend Linear actions. This skill records observations. Higher layers (daily-pulse, health-check) do analysis.
- Status writes must use exact Select values: `OPEN`, `MONITORING`, `RESOLVED`, `HIGH ALERT`, `NON ISSUE`. Any other value is a bug — skip the write and surface in report-back.
- **Never write `cs-` rows or `cl-state`.** Those belong to customer-watch and daily-pulse. This skill writes only the `cw-state` record.
- **Every RESOLVED write requires a rationale in the issue section's Notes** — trigger rule, first-sighted date, last-sighted date, days clean. Example: `RESOLVED — MONITORING auto-dismissal. First sighted 2026-05-01, last sighted 2026-05-02, 13 days clean.` If you can't construct one (e.g. issue first sighted <7 days ago, last-sighted unknown), do NOT flip to RESOLVED — leave the issue in its current status.

# Chat report-back

Very short. One line each:

- Runs at: timestamp (now)
- Window: `{window_start}` → `{now}`
- Conversations processed: N (every conversation in the window — no filtering); flagged: K (distinct conversations); ledger line appended
- New MONITORING flags this run: K (with slugs if K <= 5, else just count)
- Issues sighted (existing rows updated): J
- Companies touched: L
- Anything weird: Notion write failures, schema rejections, etc.

That's it. No summary, no recommendations. Higher layers do that.
