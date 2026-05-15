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
- **Time window**: from the most recent prior conversation-watch run's `Run date` (stored on the singleton heartbeat row, see Step 7) up to now. If no prior run, default to last 4 hours.

# Namespace

This skill writes rows with the `cw-` prefix exclusively. customer-watch owns the `cs-` prefix. **The two namespaces never overlap.** Rows are also tagged `Issue Type = System` vs `Issue Type = Customer`, but the name prefix is the primary separator — if you ever find yourself about to write a `cs-` row from this skill, stop.

# Step 1 — Read Notion known issues

The view query returns every row in the database. Filter to `cw-`-prefixed rows only. **Never read, update, or even include `cs-`-prefixed rows in the map.** Those belong to customer-watch.

## 1a. Query the lookup view

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the **`system-watch-lookup`** view — pre-filtered to `Issue Type = System`, sorted by `Last edited time` desc. **Do not use the `customer-watch-lookup` view** (`?v=3609fe3faf428049bc99000cd69e28a3`) — that one filters to `Issue Type = Customer` and will return zero `cw-` rows, making this skill think every pattern is brand new on every run.

Iterate pagination until exhausted.

## 1b. Build the page_id map

For each row, exact-Name match against:

- `cw-{slug}-{issue-slug}` → per-issue row

Ignore every row whose Name does not match this pattern exactly. Specifically drop:

- Any `cs-*` row (customer-watch's namespace)
- The `cw-heartbeat` singleton (not a per-issue row)
- Any malformed name

Build: `issues → {company-slug → {exact_name → {page_id, properties, body, detection_signal}}}`

For each canonical per-issue row, `notion-fetch` the body to extract its `Detection signal`.

## 1c. Deduplicate and drop NON ISSUE

Most recent by `Run date` wins on duplicates. Drop NON ISSUE Names entirely.

## 1d. Hard precondition

Before any writeback: the map must exist. If the view query failed, abort writeback and surface the failure. Do not "best-effort create" anything.

# Step 2 — Determine the window

Window start = the most recent `Run date` on the **heartbeat row** (Name = `cw-heartbeat`, a singleton row that tracks just this skill's last run). Window end = now. If no heartbeat exists yet, default to 4 hours back.

**Strict rules** (same as customer-watch):

- Use ONLY `Run date`. Never `Last edited time`, `Created time`, or any other timestamp.
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

**Single instance is enough.** One flagged conversation creates or updates a MONITORING issue row.

For each flagged conversation, decide:

1. **Does it match a known issue's detection signal for this customer?**
   - If yes: append the conv ID to the existing per-issue row's Sample Convs (replace, keep most recent 3). Increment Streak (sighting count for MONITORING; reset to 0 for OPEN/HIGH ALERT since signal fired).
2. **Is it a new pattern?**
   - Form a kebab-case slug describing the failure
   - Note 1+ example conv IDs
   - Mark for creation as new MONITORING row in Step 7

## Avoid double-flagging the same conversation

Track which conv IDs you process this run. If the same conversation matches two known issues, that's fine — append to both. But never write the same conv ID twice into the same row's Sample Convs.

If a conv ID already appears in the row's existing Sample Convs from a prior run, don't increment Streak — that conversation has already been counted.

# Step 5 — Status transitions (same as customer-watch Step 3)

For each issue row touched this run, apply the standard transitions:

- **MONITORING** (Streak = sighting count). Sighted this run → Streak += 1. At Streak >= 3 → flip to OPEN, reset Streak to 0. Not sighted → no change.
- **OPEN** (Streak = clean-run count). Sighted this run → Streak = 0. Not sighted → Streak += 1. At Streak >= 30 with no firing this run → flip to RESOLVED.
- **HIGH ALERT** (Streak = clean-run count, sticky). Sighted → Streak = 0. Not sighted → Streak += 1. At Streak >= 10 → step down to OPEN, preserve Streak.
- **RESOLVED**. Sighted this run → flip to OPEN (regression), Streak = 0. Otherwise no change.
- **NON ISSUE**. Skip entirely.

## MONITORING auto-dismissal

If a MONITORING row has not been sighted for **3 consecutive conversation-watch runs**, flip to RESOLVED with Notes "dismissed before escalation — no further sightings."

Track this via a "clean runs since last sighting" counter in Notes (e.g. `"sighting 2, 1 clean since"`).

# Step 6 — Notion writeback

For each issue row to write:

1. Look up page_id by exact Name in Step 1 map.
2. **If page_id exists:** `notion-update-page` `update_properties` with new Status, Run date (now, ISO with time), Sample Convs, Streak, Notes. Body untouched.
3. **If no page_id** (new pattern): `notion-create-pages` with parent `{"type": "data_source_id", "data_source_id": "35f9fe3f-af42-80ba-bf81-000b602adf12"}` and the new-issue body template.

**Hard rules against duplicates:**

- Never `notion-create-pages` for a Name in the Step 1 map.
- Never `notion-create-pages` because a search "didn't return" something — only because the map genuinely has no entry.
- Name string must match `cw-{company-slug}-{issue-slug}` exactly. No suffixes, no `cs-` prefix ever.

## Heartbeat row

After processing, upsert a singleton row with Name `cw-heartbeat`:

- **Name** (title): `cw-heartbeat`
- **Status** (select): `OPEN` (just for schema validity — semantically meaningless on this row)
- **Run date** (datetime): **the exact UTC time the writeback finishes**, ISO with time component to the second (e.g. `2026-05-15T01:43:08.000Z`). **Do not round to the nearest hour or midnight** — the next run uses this as its window start, so rounding gives the wrong window. If you don't know "now" precisely, query the DB with `SELECT NOW()`.
- **Companies count** (number): number of companies with conversations processed this run
- **Notes** (text): one short line, e.g. "Run 14 — processed 87 conversations across 12 companies; 3 new MONITORING flags."

Next run reads `cw-heartbeat`'s Run date as the window start. This is the only state this skill maintains across runs.

## New per-issue body template

```markdown
**Issue:** <one sentence — what's going wrong from customer's perspective>

**Detection signal:** <mechanical — describe the pattern in terms of message content (what the AI said, what the prospect said), property/building involvement, error codes, or state metrics. NEVER reference Conversation.summary. Future runs evaluate this against message content.>

**Recovery criteria:** <when can we mark RESOLVED — auto-resolution handles standard cases at 30 clean runs, but document any custom recovery here>

**Examples on first detection:**

- {conv_id} — {one-line context}
```

## Properties for per-issue rows

- **Run date** (datetime): now
- **Companies** (text): customer name
- **Companies count** (number): 1
- **Issue Type** (select): `System` (the actual Notion field name is `Issue Type`, not `Type`)
- **Name** (title): `cw-{company-slug}-{issue-slug}`, stable across runs
- **Status** (select): from Step 5 transitions
- **Sample Convs** (text): up to 3 conv IDs from this run if signal fired; preserved across runs if not
- **Streak** (number): per Step 5
- **Notes** (text): one short line — e.g. `"fired: 2 examples this run"`, `"MONITORING: sighting 2, 1 clean since"`, `"OPEN: clean run 12/30"`

# Hard rules

- Read-only on the DB.
- **Read message-level data, not summaries.** Every conversation check must read actual `ConversationMessage` rows (NOT `Message` — that's a different table for an unrelated chat feature). `Conversation.summary` is a post-hoc rollup and unreliable; use only as orientation hint, never as source of truth.
- **No email.** This skill writes to Notion only.
- No emojis.
- Never propose fixes, file tickets, recommend Linear actions. This skill records observations. Higher layers (daily-pulse, health-check) do analysis.
- Status writes must use exact Select values: `OPEN`, `MONITORING`, `RESOLVED`, `HIGH ALERT`, `NON ISSUE`. Any other value is a bug — skip the write and surface in report-back.
- **Never write to `cs-` rows.** Those belong to customer-watch. This skill writes only `cw-`-prefixed rows and the `cw-heartbeat` singleton.

# Chat report-back

Very short. One line each:

- Runs at: timestamp (now)
- Window: `{window_start}` → `{now}`
- Conversations processed: N (every conversation in the window — no filtering)
- New MONITORING flags this run: K (with slugs if K <= 5, else just count)
- Issues sighted (existing rows updated): J
- Companies touched: L
- Anything weird: Notion write failures, schema rejections, etc.

That's it. No summary, no recommendations. Higher layers do that.
