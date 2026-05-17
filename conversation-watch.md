---
description: Continuous per-conversation monitoring across all customers. Runs every few hours, reads each new/updated conversation message-by-message, flags AI failures, and records them inside one Notion record. No email — that single record is the substrate. Feeds daily-pulse (clusters) and health-check (trends). Use scheduled, not manually.
argument-hint: optional comma-separated company IDs to scope this run (default: all companies)
---

You're a continuous observer of the AI agent's conversations. Each run: pick up every conversation created or updated since the last run, read its messages, flag anything obviously wrong, and record findings in one Notion record. No email. That record is the output — daily-pulse and health-check read it later.

# When to use this

- **conversation-watch** (this one) — runs every 2-4 hours via cron, processes new/updated conversations across the whole portfolio, maintains one Notion record of all flagged issues. The substrate.
- **daily-pulse** — reads this skill's record, clusters the issues, maintains its own record, emails a daily brief.
- **health-check** — weekly, reads both records, emails a trend summary.
- **customer-watch** — separate, manually-curated watch over named at-risk customers. Lives in `cs-` rows. Untouched by this skill.

# The one-record model

This skill maintains exactly **one** Notion record: a page named **`cw-state`**. All issue tracking lives inside that page's body as structured Markdown. The skill never creates a row per issue — it reads `cw-state`, updates the issue list in memory, and writes the whole body back. One read, one write.

This is deliberate: a row-per-issue design meant dozens of Notion round-trips per run and timed out. One record = one fetch + one update, regardless of how many issues are tracked.

# Required MCP tools

- Postgres MCP — read-only DB access (`query`)
- Notion MCP — `notion-query-database-view` (locate the record), `notion-fetch` (read its body), `notion-update-page` (rewrite its body), `notion-create-pages` (first run only)

If Postgres is missing, stop and report. If Notion is missing, stop — there's no record to update.

This skill **never sends email**. If you find yourself drafting an email, you're misusing it.

# Configuration

- **Scope**: first arg, optional. Comma-separated company IDs to restrict the run. Empty = all companies. Used for testing; production runs are unscoped.
- **Time window**: from the `cw-state` record's last-run timestamp up to now. If the record doesn't exist yet (first run ever), default to the last 4 hours.

# Step 1 — Read the `cw-state` record

## 1a. Locate the record

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the `system-watch-lookup` view (filtered to `Issue Type = System`). Find the single row whose Name is exactly `cw-state`. Note its page_id and its `Run date` property.

- If `cw-state` exists → proceed to 1b.
- If `cw-state` does not exist → this is the first run. There is no prior state and no window history. Skip to Step 2 with a default 4-hour window; you'll create the record in Step 6.

**Ignore every other row.** `cs-*` rows belong to customer-watch. Old `cw-{company}-{issue}` rows from a previous design are obsolete — do not read them, do not update them. (If you see many such rows, note it in report-back so the operator can delete them.)

## 1b. Read the record body

`notion-fetch` the `cw-state` page to get its body. The body is structured Markdown — parse it into:

- **Header fields** — last run timestamp, run count, last-run summary
- **Active issues** — every issue under the `## Active issues` heading
- **Resolved issues** — every issue under the `## Resolved issues` heading (kept for regression detection)

Each issue is a `###`-level section with these fields:

- `Status` — `MONITORING`, `OPEN`, `HIGH ALERT`, or `RESOLVED`
- `Streak` — integer
- `Clean runs since last sighting` — integer
- `Customer` — customer name
- `Last sighted` — ISO datetime
- `Sample convs` — up to 3 conversation IDs
- `Detection signal` — the mechanical rule for re-detecting this issue
- `Notes` — one short line

The issue's identifier is its `###` heading: `cw-{company-slug}-{issue-slug}`. Stable across runs.

# Step 2 — Determine the window

Window start = the `cw-state` record's `Run date` property (set by the previous run). Window end = now.

If `cw-state` doesn't exist yet, window start = now − 4 hours.

**Strict rules:**

- Use ONLY the `Run date` property (or the body's "Last run" field — they should match). Never `Last edited time` or `Created time`.
- "Now" must be the **exact UTC time**, to the second. Query `SELECT NOW()` from Postgres if unsure. Never round.

# Step 3 — Pull conversations to process

## Schema (source: `prisma/schema.prisma`)

You will read two tables. **There is also a `Message` table for an unrelated chat feature — do not query it. The right table is `ConversationMessage`.**

**`Conversation`** — one row per prospect conversation thread.

- `id` (int), `createdAt`, `updatedAt`, `lastMessageAt` (timestamps, UTC)
- `companyId` (int, FK → `Company.id`)
- `userId` (int, nullable — prospect user)
- `adminRating` (int, nullable)
- `summary` (text, nullable) — **do not rely on this**, post-hoc rollup, often wrong
- **No `messageCount` column.** COUNT-join `ConversationMessage` if you need a count.

**`ConversationMessage`** — one row per message inside a conversation.

- `id` (int), `createdAt`, `updatedAt`
- `conversationId` (int, FK → `Conversation.id`) — the join you want
- `senderType` (enum `ConversationMessageRole`) — AI vs prospect
- `messageType` (enum `ConversationMessageType`)
- `body` (text) — the actual message content
- `listingId` (int, nullable)
- `metadata` (jsonb — sometimes carries error info, e.g. 'Agent Off Hours' suppression)

## Query

Pull conversations where `updatedAt >= window_start` AND `updatedAt <= now` from `Conversation`. If a scope filter was given, restrict to those `companyId` values. Join `Company` for the name.

**Read every conversation in the window. No skipping, no cheap filters, no length thresholds.** A short bot-only thread can still hide a real AI failure.

For each conversation, fetch its messages:

```sql
SELECT id, "conversationId", "senderType", body, "createdAt", metadata
FROM "ConversationMessage"
WHERE "conversationId" IN (...)
ORDER BY "conversationId", id;
```

Batch the `IN` list (5-10 conv IDs per query) for large windows. `LEFT(body, 600)` is usually enough per message. Read both AI and prospect sides.

# Step 4 — Per-conversation review

For each conversation, read the messages and ask: **did the AI do something obviously wrong?** Examples:

- Quoted a price that doesn't match listing data
- Offered a property in the wrong city / region
- Agreed to something undeliverable (a tour at an unavailable time, a non-existent unit)
- Dropped the close-loop — confirmed nothing after a long exchange
- Hallucinated information (made-up buildings, fabricated policies)
- Handed off to a human when it shouldn't have, or didn't when it should have
- Repeated itself / got stuck in a loop
- Tour booking failed silently
- Stale availability quoted from prior context
- Wrong-bedroom / wrong-property in a tour reminder
- Backend threading bug — multiple prospects merged in one thread

**Single instance is enough** to flag.

For each flagged conversation, decide:

1. **Does it match an existing issue's detection signal** (from the parsed `cw-state` active issues)?
   - If yes: add the conv ID to that issue's Sample convs (keep most recent 3). It counts as a sighting this run.
2. **Is it a new pattern?**
   - Form a kebab-case `cw-{company-slug}-{issue-slug}` identifier
   - Write a one-line Issue description and a mechanical Detection signal
   - Note 1+ example conv IDs
   - It enters as a new `MONITORING` issue

## Avoid double-counting

Track which conv IDs you process this run. A conversation can match two issues — that's fine, count it for both. But if a conv ID already appears in an issue's Sample convs from a prior run, it's not a new sighting — don't increment Streak for it.

# Step 5 — Status transitions

For each issue in the parsed active list, apply transitions based on whether it was sighted this run:

- **MONITORING** (Streak = sighting count). Sighted → Streak += 1; reset clean-runs-since to 0. At Streak >= 3 → flip to `OPEN`, reset Streak to 0. Not sighted → Streak unchanged, clean-runs-since += 1.
- **OPEN** (Streak = clean-run count). Sighted → Streak = 0. Not sighted → Streak += 1. At Streak >= 30 with no sighting → flip to `RESOLVED`.
- **HIGH ALERT** (Streak = clean-run count, sticky). Sighted → Streak = 0. Not sighted → Streak += 1. At Streak >= 10 → step down to `OPEN`, preserve Streak.
- **RESOLVED**. Sighted this run → flip back to `OPEN` (regression), Streak = 0, note "regressed". Not sighted → no change.
- **NON ISSUE**. Never auto-changes. (Set only by an operator editing the record by hand.)

## MONITORING auto-dismissal

If a MONITORING issue reaches **3 consecutive runs with no sighting** (clean-runs-since >= 3), flip it to `RESOLVED` with Notes "dismissed before escalation — no further sightings."

## Pruning resolved issues

Any issue in the Resolved section that has been `RESOLVED` for **more than 30 days** can be dropped from the record entirely — its detection signal is no longer needed for regression detection. This keeps the record from growing without bound. Note pruned count in report-back.

# Step 6 — Rewrite the `cw-state` record

Build the full new body and write it in **one** `notion-update-page` call with `command: replace_content`.

## Record body template

```markdown
# conversation-watch state

- **Last run:** {now, exact UTC ISO to the second}
- **Window this run:** {window_start} → {now}
- **Run count:** {prior count + 1}
- **Last run summary:** processed {N} conversations across {M} customers; {K} new issues, {J} sighted, {R} resolved.

## Active issues

### cw-{company-slug}-{issue-slug}
- **Status:** MONITORING
- **Streak:** 1
- **Clean runs since last sighting:** 0
- **Customer:** {Company Name}
- **Last sighted:** {ISO datetime}
- **Sample convs:** {id, id, id}
- **Detection signal:** {mechanical rule — message content the AI/prospect said, property/error involvement, state metrics. NEVER reference Conversation.summary.}
- **Issue:** {one sentence — what's wrong from the customer's perspective}
- **Notes:** {one short line}

### cw-{next-issue}
...

## Resolved issues

_Kept for regression detection. Issues resolved >30 days are pruned._

### cw-{company-slug}-{issue-slug}
- **Status:** RESOLVED
- **Resolved on:** {ISO datetime}
- **Customer:** {Company Name}
- **Detection signal:** {kept so a future run can detect a regression}
- **Notes:** {how it resolved — "auto-resolved 30 clean runs" / "dismissed before escalation" / etc.}
```

## Record properties

On the `cw-state` row itself, set:

- **Name** (title): `cw-state`
- **Issue Type** (select): `System`
- **Status** (select): `OPEN` (schema placeholder — meaningless on this record)
- **Run date** (datetime): exact UTC time of this writeback, to the second. The next run reads this as its window start. **Never round.**
- **Companies count** (number): customers with conversations processed this run
- **Notes** (text): same one-line summary as the body header

## First run

If `cw-state` didn't exist, `notion-create-pages` it with parent `{"type": "data_source_id", "data_source_id": "35f9fe3f-af42-80ba-bf81-000b602adf12"}`, the body above, and the properties above.

# Hard rules

- Read-only on the Postgres DB.
- **Read message-level data, not summaries.** Every check reads actual `ConversationMessage` rows (NOT `Message` — different table, unrelated feature). `Conversation.summary` is unreliable; orientation hint only.
- **One Notion record.** This skill reads and writes exactly `cw-state`. It never creates per-issue rows. It never touches `cs-*` rows or daily-pulse's `cl-state` record.
- **No email.**
- No emojis.
- Never propose fixes, file tickets, or recommend Linear actions. This skill records observations. Higher layers analyze.
- Status values must be exactly `OPEN`, `MONITORING`, `RESOLVED`, `HIGH ALERT`, or `NON ISSUE`.
- Run date is the exact UTC writeback time, to the second. Never round.

# Chat report-back

Very short. One line each:

- Runs at: {now}
- Window: {window_start} → {now}
- Conversations processed: N (every conversation in the window — no filtering)
- New issues this run: K (with identifiers if K <= 5, else count)
- Issues sighted: J
- Issues resolved this run: R
- Resolved issues pruned (>30 days): P
- Companies touched: L
- Anything weird: obsolete `cw-{company}-{issue}` rows still in Notion, write failures, etc.

No summary, no recommendations. Higher layers do that.
