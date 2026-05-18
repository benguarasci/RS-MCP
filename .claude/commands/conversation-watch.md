---
description: Continuous per-conversation monitoring across all customers. Runs every few hours, reads each new/updated conversation message-by-message, flags AI failures, and writes them to the watch-state Postgres DB as monitoring issues. No email. Feeds daily-pulse (clusters) and health-check (trends). Use scheduled, not manually.
argument-hint: optional comma-separated company IDs to scope this run (default: all companies)
---

You're a continuous observer of the AI agent's conversations. Each run: pick up every conversation created or updated since the last run, read its messages, flag anything obviously wrong, and write findings to the watch-state database. No email. The output is the `issues` table — daily-pulse and health-check consume it later.

# When to use this

- **conversation-watch** (this one) — runs every 2-4 hours via cron, processes new/updated conversations across the entire portfolio, writes flags to the watch-state DB. The substrate.
- **customer-watch** — manually-curated focused-attention tool for at-risk customers. Still Notion-based; separate, do not touch.
- **daily-pulse** — clusters Layer 0 issues across customers, sends daily email.
- **health-check** — weekly trends across all layers.

# Required MCP tools

Both tools are on the `rs-neon-mcp` server:

- **`query`** — read-only SQL against the prod Postgres DB (the conversation data).
- **`state_query`** — read/write SQL against the watch-state Postgres DB (the `issues`, `companies`, `runs` tables).

If either tool is missing, stop and report. This skill **never sends email** — no Gmail, no `send_email`. If you find yourself drafting an email, you're misusing this skill.

# The state database

This skill reads prod conversations and writes to the watch-state DB:

- **`issues`** — one row per `(company_id, kind)`. This skill's output. Identity is the natural key `(company_id, kind)` — there are no slugs to construct.
- **`companies`** — upserted as new customers are seen.
- **`runs`** — one row per execution; this skill logs its own run.

It **never** writes `clusters` or `cluster_snapshots` — daily-pulse owns those. Read denormalized state from the `v_issues` view; write to the base tables. All of this goes through `state_query`.

Status/severity model:

- **`status`** (lifecycle): `monitoring` → `open` → `resolved`; `dismissed` is terminal (the old "NON ISSUE").
- **`severity`**: `low` / `medium` / `high` (the old "HIGH ALERT" is `severity = high`).
- **`streak`**: consecutive runs the issue was sighted.
- **`clean_runs`**: consecutive runs with no sighting since it was last sighted.

# Configuration

- **Scope**: first arg, optional. If provided, restrict to those company IDs. If empty, process all companies. Operator uses scoping for testing; production runs are unscoped.
- **Time window**: from the start of the most recent *succeeded* conversation-watch run (see Step 2). If there is no prior succeeded run, default to the last 4 hours.

# Step 0 — Open the run

Before anything else, log the run and keep the returned id:

```sql
INSERT INTO runs (layer, status) VALUES ('conversation-watch', 'running') RETURNING id;
```

If the skill fails partway, the row stays `running` — that's the signal it never completed. The window query in Step 2 only counts `succeeded` runs, so this open row never corrupts the next window.

# Step 1 — Load known issues

```sql
SELECT * FROM v_issues ORDER BY company, kind;
```

This is your **known-issues map** for the run, keyed by `(company, kind)`. The `detection_signal` field on each row is the mechanical pattern you evaluate new conversations against. **Skip any issue with `status = 'dismissed'`** — never re-flag or resurrect it.

If the query fails, abort before any writeback — acting on a partial map would create duplicate issues.

# Step 2 — Determine the window

```sql
SELECT MAX(started_at) AS window_start
FROM runs WHERE layer = 'conversation-watch' AND status = 'succeeded';
```

Window start = that timestamp; window end = `now()`. If `window_start` is null (first ever run), default to 4 hours back. Get a precise "now" from the DB (`SELECT now()`); never round.

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

Using the **`query`** tool (read-only prod), pull conversations where `updatedAt >= window_start` AND `updatedAt <= now` from `Conversation`. If a scope filter was provided, restrict to those `companyId` values. Join `Company` if you need the company name (and `Company.id`, which is the admin ID) for reporting and the `companies` upsert.

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

For each conversation, read the messages and ask: **did the AI do something obviously wrong?**

Examples of "obviously wrong":

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

**Single instance is enough.** One flagged conversation creates or updates a monitoring issue.

For each flagged conversation, decide:

1. **Does it match a known issue's `detection_signal` for this customer?** (matched on `(company, kind)`)
   - If yes: it's a sighting of that issue. Add the conv ID to a list for that issue's `sample_convs` (keep most recent 3). Mark the issue sighted this run.
2. **Is it a new pattern?**
   - Form a kebab-case `kind` describing the failure (e.g. `stale-slot-quoting`, `tour-booking-silent-failure`). The `kind` is stable forever once created.
   - Note 1+ example conv IDs.
   - Judge a `severity`: `high` for severe failures (silent booking failure, merged threads, wrong-region quotes), otherwise `medium`.
   - Mark for insertion as a new `monitoring` issue in Step 6.

## Avoid double-counting

Track which conv IDs you process this run. A conversation may match two issues — append to both. But never write the same conv ID twice into one issue's `sample_convs`, and if a conv ID already appears in an issue's existing `sample_convs` from a prior run, it is **not** a fresh sighting — don't increment `streak` for it.

## Tally the run counts

Maintain two integers for the run record (Step 6):

- **processed** — total conversations in this run's window (every conversation pulled in Step 3, no filtering).
- **flagged** — count of DISTINCT conversation IDs that triggered at least one issue this run. Count each conversation once even if it matched multiple issues.

`flagged` is always <= `processed`. If `flagged` exceeds `processed`, you double-counted — recheck before writeback.

# Step 5 — Status transitions

For every known issue (Step 1) plus every new pattern, compute the new state. "Sighted" = the issue fired in at least one conversation this run.

- **`monitoring`** — sighted → `streak += 1`, `clean_runs = 0`, `last_sighted = now()`. If `streak >= 3` → `status = 'open'`. Not sighted → `clean_runs += 1`.
- **`open`** — sighted → `streak += 1`, `clean_runs = 0`, `last_sighted = now()`. Not sighted → `clean_runs += 1`. If `clean_runs >= 30` → `status = 'resolved'`, `resolved_at = now()`.
- **`severity = 'high'`** (sticky, independent of status) — sighted → `clean_runs = 0`. Not sighted → `clean_runs += 1`. If `clean_runs >= 10` → step `severity` down to `medium` (status unchanged).
- **`resolved`** — sighted this run → regression: `status = 'open'`, `streak = 1`, `clean_runs = 0`, `resolved_at = NULL`. Otherwise no change.
- **`dismissed`** — skip entirely; never re-flag.

## Monitoring auto-dismissal

A `monitoring` issue auto-resolves only when BOTH hold: `first_sighted` is more than 7 days ago AND `last_sighted` is more than 7 days ago (i.e. no sighting in a 7+ day window). If first sighted less than 7 days ago, leave it `monitoring` regardless of clean-run count. Every auto-resolve must record a rationale in `notes` — see Hard rules.

# Step 6 — Writeback

All writes go through `state_query`. Order: upsert companies, then upsert issues, then close the run.

## 6a. Upsert companies

For every company flagged this run, ensure it exists. `admin_id` is the prod `Company.id` (the value behind `/admin/companies/{id}`); `slug` is a kebab-case handle of the name:

```sql
INSERT INTO companies (slug, name, admin_id)
VALUES ('briarlane', 'Briarlane', 76)
ON CONFLICT (slug) DO UPDATE
  SET name = excluded.name, admin_id = excluded.admin_id;
```

## 6b. New issues

For each new pattern, insert it as `monitoring`. Resolve the `company_id` from the slug in the same statement:

```sql
INSERT INTO issues (company_id, kind, status, severity, streak, clean_runs,
                    summary, detection_signal, sample_convs, first_sighted, last_sighted)
SELECT c.id, 'tour-booking-silent-failure', 'monitoring', 'medium', 1, 0,
       'AI confirmed a tour but the booking never registered.',
       'AI message states a tour is booked; no booking confirmation message follows.',
       '["12345","12346"]'::jsonb, now(), now()
FROM companies c WHERE c.slug = 'briarlane'
ON CONFLICT (company_id, kind) DO UPDATE
  SET streak = issues.streak + 1, clean_runs = 0, last_sighted = now(),
      sample_convs = excluded.sample_convs, status = 'monitoring';
```

`summary` and `detection_signal` are written once and **never rewritten** on later runs.

## 6c. Existing issues

For each known issue, apply the Step 5 transition by `id`:

```sql
UPDATE issues
SET status = 'open', severity = 'medium', streak = 4, clean_runs = 0,
    last_sighted = now(), sample_convs = '["12350","12348","12345"]'::jsonb,
    notes = 'sighted this run; promoted monitoring -> open at streak 3'
WHERE id = 42;
```

For an auto-resolve, also set `resolved_at = now()` and a `notes` rationale (trigger rule, first/last-sighted dates, days clean).

- Update only the rows that changed this run. An untouched issue (not sighted, no transition) still needs `clean_runs += 1` — apply that.
- **`kind`, `summary`, `detection_signal` are stable** — never rewrite them once set.
- Do not set `updated_at` — the DB trigger maintains it.

## 6d. Close the run

```sql
UPDATE runs
SET status = 'succeeded', finished_at = now(),
    summary = 'Run processed 87 conversations across 12 companies; 3 new monitoring flags.',
    stats = '{"processed":87,"flagged":9,"companies":12,"new_issues":3}'::jsonb
WHERE id = <run_id>;
```

If the run failed before this point, leave the row `running` (or set it to `failed` with a summary if you can).

# Hard rules

- Read-only on the prod DB (`query`). Reads and writes only to the watch-state DB (`state_query`), and only the `issues`, `companies`, `runs` tables.
- **Read message-level data, not summaries.** Every check must read actual `ConversationMessage` rows (NOT `Message` — a different table). `Conversation.summary` is unreliable; use only as an orientation hint.
- **No email.** This skill writes to the state DB only.
- No emojis.
- Never propose fixes, file tickets, or recommend Linear actions. This skill records observations. Higher layers do analysis.
- `status` writes must be exactly `open`, `monitoring`, `resolved`, or `dismissed`; `severity` exactly `low`, `medium`, or `high`. The DB domains will reject anything else — if a write is rejected, skip it and surface in report-back.
- **`detection_signal` must be mechanical** — describe the pattern in terms of message content, property/building involvement, error codes, or state metrics. NEVER reference `Conversation.summary`. Future runs evaluate this field against message content.
- Never write `clusters` or `cluster_snapshots` — those belong to daily-pulse.
- **Every resolve requires a rationale in `notes`** — trigger rule, first-sighted date, last-sighted date, days clean. If you can't construct one (e.g. issue first sighted <7 days ago), do NOT resolve — leave the issue in its current status.

# Chat report-back

Very short. One line each:

- Runs at: timestamp (now)
- Window: `{window_start}` → `{now}`
- Conversations processed: N; flagged: K (distinct)
- New monitoring flags this run: K (with `kind` slugs if K <= 5, else just count)
- Existing issues updated: J
- Companies touched: L
- Anything weird: state_query write failures, domain rejections, etc.

That's it. No summary, no recommendations. Higher layers do that.
