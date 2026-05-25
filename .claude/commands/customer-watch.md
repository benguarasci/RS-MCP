---
description: Scans data since the last run for a small named list of customers and reports which known issues are still firing, with example conversation IDs. Also surfaces any new patterns noticed in the conversations. Doesn't propose fixes — just shows what's happening. Runs as often as you want; state lives in the watch-state Postgres DB (cs_issues) and the window is keyed off the last succeeded run.
argument-hint: comma-separated company admin IDs to watch (required), then optional comma-separated email recipients
---

You're the operator's per-customer scan. For each watched customer: check whether each known issue is still firing, give example conv IDs, and flag anything new you noticed in the data. Don't propose fixes. Don't recommend tickets. Just report what's there.

# When to use this

- **conversation-watch** (Layer 0) — portfolio-wide every-few-hours sweep, writes to `issues`
- **daily-pulse** — daily cluster brief
- **customer-watch** (this one) — per-run scan of a fixed list of customers, reads/writes `cs_issues`
- **health-check** — weekly trend report

# Required MCP tools

Both tools are on the `rs-neon-mcp` server:

- **`query`** — read-only SQL against the prod Postgres DB (conversation data).
- **`state_query`** — read/write SQL against the watch-state Postgres DB (`cs_issues`, `companies`, `runs`).
- **`send_email`** — sends the per-run brief.

If `query` or `state_query` is missing, stop and report. If `send_email` is missing, write the HTML to stdout but still do the `state_query` writeback.

# The state database

Customer-watch maintains its own per-issue table, isolated from conversation-watch:

- **`cs_issues`** — one row per `(company_id, kind)` watched by this skill. Recurring patterns.
- **`cs_actions`** — one row per `(conversation_id, action_kind)`. One-shot recoveries the operator should personally take on a specific prospect / conversation. Distinct from `cs_issues`: patterns vs. concrete action items.
- **`companies`** — shared with the other watch skills; upserted as new watched customers are seen.
- **`runs`** — shared; this skill logs its own run as `layer = 'customer-watch'`.

It **never** writes `issues`, `clusters`, or `cluster_snapshots` — those belong to conversation-watch / daily-pulse. Read denormalized state from the `v_cs_issues` and `v_cs_actions` views; write to `cs_issues` and `cs_actions`. All of this goes through `state_query`.

Status / severity model (same domain values as the rest of the watch system):

- **`status`**: `monitoring` → `open` → `resolved`; `dismissed` is terminal (the old Notion "NON ISSUE").
- **`severity`**: `low` / `medium` / `high` (the old Notion "HIGH ALERT" is `severity = high`).
- **`streak`**: consecutive runs the issue was sighted (matches conversation-watch's convention).
- **`clean_runs`**: consecutive runs with no sighting since the issue was last sighted.

# Configuration

- **Watched companies**: first arg — comma-separated prod `Company.id` admin IDs, e.g. `22,57,76`. Required. If not provided, stop and ask.
- **Email recipients**: second arg, else env `$HEALTH_CHECK_RECIPIENTS`, else ask once.

# Step 0 — Open the run

```sql
INSERT INTO runs (layer, status) VALUES ('customer-watch', 'running') RETURNING id;
```

If the skill fails partway, the row stays `running` — that's the signal it never completed. The window query in Step 2 only counts `succeeded` runs, so this open row never corrupts the next window.

# Step 1 — Load known issues for the watched customers

Resolve the watched admin IDs to company rows first (upsert if missing — see Step 6a). Then load every `cs_issues` row for those companies via the view:

```sql
SELECT * FROM v_cs_issues
WHERE company_admin_id IN (22, 57, 76)
ORDER BY company, kind;
```

This is your **known-issues map** for the run, keyed by `(company_admin_id, kind)`. The `detection_signal` field is the mechanical pattern you evaluate this run's conversations against.

**Dismissed issues stay in the map.** A row with `status = 'dismissed'` was marked a non-issue by the operator. Keep it in the map so a re-detection of the same `(company, kind)` *matches* it and is then left alone — never reopen it, and never let a dismissed pattern be re-inserted as a "new" pattern in Step 4.

**`origin = 'operator'` issues are first-class watch targets.** The operator added them by hand to a customer's watch list. Evaluate conversations against them every run, exactly like watcher-detected issues. An operator issue may have no `detection_signal` — fall back to `summary` as the pattern to look for.

**Read `operator_note`.** If an issue carries an `operator_note`, that is the operator's commentary for this run — context, what to ignore, what to look at harder. Factor it into your judgment for that `(company, kind)`. It is operator-owned: read it, never overwrite or clear it.

If the query fails, abort before any writeback — acting on a partial map would create duplicate issues.

# Step 2 — Determine the window

```sql
SELECT MAX(started_at) AS window_start
FROM runs WHERE layer = 'customer-watch' AND status = 'succeeded';
```

Window start = that timestamp; window end = `now()`. If `window_start` is null (first ever run), default to 24 hours back. Get a precise "now" from the DB (`SELECT now()`); never round.

# Step 2.5 — Top-line activity numbers

For each watched customer, pull a small set of activity counts for the window (via `query` against prod). These render as a one-line strip under the customer name so the operator has context for the issue updates.

Numbers to collect (per customer, since `window_start`):

- **Conversations** — `Conversation.companyId = X AND createdAt >= window_start`
- **Low-rated conversations** — same, plus `adminRating <= 2`
- **Tours booked** — `Appointment` via `Manager.companyId`, `status IN ('Confirmed', 'ManagerConfirmed')`, not deleted
- **Tours completed** — same, `status = 'Completed'`
- **Tours cancelled** — same, `status IN ('ManagerCancelled', 'ProspectCancelled')`
- **Prospects** — `Prospect.companyId = X AND createdAt >= window_start`

Keep the strip short — only render non-zero counts. If a customer is completely silent in the window, render just one phrase: "no activity in window."

# Step 3 — Check each known issue

For every per-issue row that isn't `dismissed`:

1. Re-run the issue's `detection_signal` (or, for an operator issue with no signal, `summary`) against the window. **Read the actual `ConversationMessage` rows for each conversation, not just `Conversation.summary`** — summaries are generated post-hoc and often miss what actually happened. Pull messages via `ConversationMessage.conversationId` joined to conversations in the window. Read both AI and prospect sides.
2. Collect up to 3 example conversation/property/error IDs.
3. Compute today's **fired** state — a per-run boolean, not a stored status:
   - `fired = true` if signal fires at least once in the window. Email renders as **OPEN** (or **HIGH ALERT** if severity is high) with examples.
   - `fired = false` if no signal in the window. Email renders as **QUIET** (display-only label — never persisted).

## Stored status — the lifecycle, not this run

The DB `status` is the issue's **lifecycle state**, not its per-run signal:

- **`monitoring`** — probationary state. New patterns from Step 4 start here. `streak` counts sightings; auto-escalates to `open` at 3 sightings, auto-dismisses to `resolved` after 7+ days clean (see Step 4).
- **`open`** — default state for a tracked issue. Stays `open` whether or not the signal fires on any given run. `clean_runs` counts consecutive clean runs.
- **`resolved`** — auto-flipped after 30 consecutive clean runs from `open`. Or auto-dismissed from `monitoring`. Means we're not actively watching anymore.
- **`severity = 'high'`** — manual operator flag (the old Notion "HIGH ALERT"). Sticky alongside `status`. Always rendered in the email even on quiet runs. **Auto-steps-down to `severity = 'medium'` after 10 consecutive clean runs** (`clean_runs` preserved). Status is independent — `severity = 'high'` can coexist with any status.
- **`dismissed`** — manual operator flag (the old Notion "NON ISSUE"). Dropped from email entirely.

## Counter rules

- Sighted this run → `streak += 1`, `clean_runs = 0`, `last_sighted = now()`.
- Not sighted this run → `clean_runs += 1`. `streak` unchanged.
- New issue created this run → `streak = 1`, `clean_runs = 0`.

## Auto-resolution and auto-step-down

Evaluated in this order each run:

1. **`severity = 'high'` step-down.** If `severity = 'high'`, signal absent this run, and `clean_runs >= 10` (going into this run, before incrementing), step `severity` down to `medium`. `status` and `clean_runs` preserved.
2. **`open` → `resolved` (auto-resolve).** If `status = 'open'`, signal absent this run, and `clean_runs >= 30`, flip `status` to `resolved`, set `resolved_at = now()`, and write a rationale to `notes`. Every resolve requires a rationale (see Hard rules).

Operator flips (severity high, dismissed) are sticky against signal-driven transitions but not against each other — the operator can always override by hand.

## Regression detection

If prior `status = 'resolved'` and signal fires this run, flip `status` back to `open`, `streak = 1`, `clean_runs = 0`, `resolved_at = NULL`, and write `notes` like `"regressed after {N} clean runs"`. Render in the email with an italic trailing note: `(regressed after {N} clean runs)`.

# Step 4 — Scan every conversation for new issues

Read **every** conversation in the window for each watched customer, not just low-rated ones. Don't filter by `adminRating`.

**Read message by message, not the summary.** `Conversation.summary` is post-hoc and unreliable. For each conversation in the window, fetch `ConversationMessage` rows (NOT `Message` — that's a different unrelated table) ordered by `id`. Read AI side and prospect side. Then judge.

For each conversation, ask: **does the AI do something obviously wrong?** Examples:

- AI quoted a price that doesn't match listing data
- AI offered a property in the wrong city / region
- AI agreed to something undeliverable (a tour at a time without availability, a non-existent unit)
- AI dropped the close-loop — confirmed nothing after a long exchange
- AI hallucinated information (made-up buildings, fabricated policies)
- AI handed off to a human when it shouldn't have, or didn't when it should have
- AI repeated itself / got stuck in a loop
- Tour booking failed silently
- Stale availability quoted from prior context
- Anything that would make the operator wince

Also still look at:

- Integration error spikes by `xPropertyId`
- Funnel/appointment anomalies you'd notice without being told to look

**Single instance is enough.** Don't require 2+ matches. The window is too short for that threshold.

For each flagged item:

- Form a stable kebab-case `kind` (e.g. `wrong-city-cross-sell`, `quoted-price-mismatch`)
- Write a one-sentence `summary` (customer's perspective)
- Write a mechanical `detection_signal` referencing message content
- Note 1+ example conv IDs

**Match-against-existing first.** Before creating a new row, check whether the `(company_id, kind)` already exists in the Step 1 map (any status, including `dismissed`). If yes, do not create — it's a sighting of the existing issue (skip if `dismissed`). New rows are only created when nothing matches at all.

These become new `cs_issues` rows in Step 6 with `status = 'monitoring'`, `severity = 'medium'`, `origin = 'customer-watch'`.

## `monitoring` semantics

`monitoring` is a probationary state for issues that haven't earned full tracking yet.

- **Auto-escalation:** when a `monitoring` issue is sighted this run and `streak >= 3` (going into the increment), flip `status` to `open`, reset `streak = 0` and `clean_runs = 0`. Write `notes` like `"promoted monitoring -> open at streak 3"`.
- **Auto-dismissal:** a `monitoring` issue auto-resolves only when BOTH hold: `first_sighted` is more than 7 days ago AND `last_sighted` is more than 7 days ago (no sighting in a 7+ day window). If first sighted less than 7 days ago, leave it `monitoring` regardless of clean-run count. Every auto-resolve must record a rationale in `notes`.

# Step 4.5 — Detect CS action items

This step is the operator's recovery queue: specific conversations where a human should reach out **right now** to smooth things over before the customer hears about it. Distinct from Step 3/4 (recurring patterns) — these are one-shot recoveries on individual prospects.

## Load already-known actions

```sql
SELECT * FROM v_cs_actions
WHERE company_admin_id IN (22, 57, 76)
  AND status = 'open';
```

These are items flagged on prior runs that the operator hasn't yet marked `resolved` or `dismissed`. Keep them in mind so this run doesn't double-insert.

## What counts as an action item

Scan the same window as Steps 3 and 4. For each conversation, ask: **is there a clear, immediate action the operator should take on this prospect, off-thread or in-thread, before this customer notices?** Examples:

- **`failed-booking`** — a tour booking errored, was cancelled by the manager, or the prospect got a "no slot available" reply for something they explicitly asked for. Operator should call the prospect and rebook.
- **`dropped-thread`** — prospect asked a clear question or requested action, AI's last reply doesn't address it, prospect went silent or said "are you still there?". Conversation is recent (last message <48h ago) and the prospect is real (has a name, has multiple messages).
- **`ai-confusion`** — AI agreed to something undeliverable (wrong unit type, time outside availability, policy the customer doesn't honor), the prospect either noticed and pushed back OR is about to find out. Operator should reach out before the prospect arrives / calls the office.
- **`unanswered-question`** — prospect asked a specific concrete question (price, availability for a date, application status, pet policy on a specific unit) and the AI hung on a generic non-answer. Prospect's last message is on the table.
- **`frustrated-prospect`** — prospect explicitly said they were frustrated, wanted a human, said "this isn't working", or used profanity at the AI. Hand-off didn't happen.
- **`tour-no-show`** — `Appointment.status = 'NoShow'` in the window with no follow-up message from the manager or AI.
- **`wrong-bedroom-or-unit`** — AI sent a tour reminder / confirmation with the wrong unit, wrong bedroom count, or wrong building. Prospect will arrive at the wrong place.

This list is illustrative, not closed. The judgment is: **if the operator saw this conversation, would they pick up the phone?** If yes, flag it. If it's just a system-pattern observation (better tracked in `cs_issues`), don't.

## Single-instance rule

One conversation, one action item per `action_kind`. If a single conversation has both a failed booking and a frustrated prospect, that's two action items (two `action_kind` values). The `(conversation_id, action_kind)` unique constraint enforces this.

## Match against open items first

For each candidate action, check whether `(conversation_id, action_kind)` is already in the open-actions map. If yes, it's a re-flag — bump `last_flagged = now()`, leave everything else alone. Don't insert a duplicate.

## Auto-resolve heuristics

For each `open` action loaded above, check whether the situation has resolved itself in the underlying data. If yes, this skill flips it to `resolved` automatically.

- **`dropped-thread`** — if the conversation has had at least one AI or manager-sent message after `first_flagged` AND the prospect has replied to it (or at least the manager has joined), auto-resolve.
- **`unanswered-question`** — same heuristic: if a substantive reply has been sent after `first_flagged`, auto-resolve.
- **`failed-booking`** — if a new `Appointment` row exists for the same prospect with `status IN ('Confirmed','ManagerConfirmed','Completed')` and `createdAt > first_flagged`, auto-resolve (the booking was redone).
- **`tour-no-show`** — if a follow-up message (manager- or AI-sent) was logged after `first_flagged`, auto-resolve.
- **`ai-confusion` / `wrong-bedroom-or-unit` / `frustrated-prospect`** — no reliable auto-resolve heuristic. Stay `open` until the operator marks them by hand.

Every auto-resolve writes a `notes` rationale. Items the operator manually marked `dismissed` are terminal — never re-flag the same `(conversation_id, action_kind)`.

## Aging-out

An `open` action whose `first_flagged > 14 days ago` is no longer "right now" actionable. Flip it to `dismissed` with `notes = 'aged out — stale for 14+ days'`. Don't render it in the email any further.

# Step 5 — Email

Short HTML. Should scan on a phone in under 30 seconds. Mobile email clients are inconsistent — use inline styles, no flexbox, no grid, no JS, no external CSS.

## Subject

`Customer watch — {N} customers — YYYY-MM-DD HH:MM`

Use a timestamp because runs can happen multiple times a day.

## Pill mapping

The DB stores `status` + `severity` separately; the email shows the familiar single pill. Map:

| Stored | Pill displayed |
|---|---|
| `severity = 'high'` (any active status) | **HIGH ALERT** |
| `status = 'open'` + sighted this run | **OPEN** (firing) |
| `status = 'open'` + not sighted | **QUIET** (display-only label, never persisted) |
| `status = 'monitoring'` + sighted | **MONITORING** (sighting) |
| `status = 'monitoring'` + not sighted | **MONITORING** (muted) |
| `status = 'resolved'` + not sighted | omitted entirely |
| `status = 'resolved'` + sighted (regression) | **OPEN** with italic regression note |

## HTML structure

Wrap the body in a centered container with max-width so it doesn't stretch on desktop. Use this exact skeleton — fill the slots, don't paraphrase the styles:

```html
<div style="max-width:640px;margin:0 auto;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f1e1c;line-height:1.55;font-size:15px;">

  <p style="margin:0 0 24px;color:#3d3b35;font-size:14px;">{one-line opening — casual, what's the headline since last run}</p>

  <!-- Per customer block. Repeat. -->
  <div style="margin:0 0 32px;padding-top:20px;border-top:1px solid #e3decf;">

    <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:500;margin:0 0 4px;color:#1f1e1c;">{Customer Name}</h2>

    <!-- Activity strip from Step 2.5 — non-zero counts only -->
    <p style="margin:0 0 18px;font-size:12px;color:#807548;letter-spacing:0.02em;">
      24 conversations · 4 low-rated · 8 tours booked · 2 cancelled · 11 prospects
    </p>

    <h3 style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#807548;font-weight:600;margin:0 0 10px;">Known issues</h3>

    <!-- OPEN issue firing this run: full color, sub-tag counts instances, examples on second line -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#8a4a30;">cross-region-leads</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#f0d9cc;color:#8a4a30;border-radius:999px;font-weight:600;">OPEN</span>
      <span style="margin-left:6px;font-size:11px;color:#8a4a30;font-style:italic;">2 caught</span>
      <br/>
      <span style="color:#3d3b35;">Conv 8224 (Olivia, Panorama→Foothills, ~700km). Conv 8083 same shape on 2026-05-12.</span>
    </p>

    <!-- OPEN, state-based signal firing (no discrete instances) -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#8a4a30;">manager-cancellation-rate-high</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#f0d9cc;color:#8a4a30;border-radius:999px;font-weight:600;">OPEN</span>
      <span style="margin-left:6px;font-size:11px;color:#8a4a30;font-style:italic;">firing</span>
      <br/>
      <span style="color:#3d3b35;">30d ratio still 0.500 (11 ManagerCancelled / 11 ManagerConfirmed / 0 Completed).</span>
    </p>

    <!-- OPEN, no fire this run: muted, sub-tag says clean run, clean_runs + countdown -->
    <p style="margin:0 0 8px;font-size:13px;color:#807548;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">date-confusion-on-tour-booking</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#ede8d8;color:#807548;border-radius:999px;font-weight:600;">QUIET</span>
      <span style="margin-left:6px;font-size:11px;color:#807548;font-style:italic;">clean run</span>
      <span style="margin-left:8px;font-size:12px;">12 runs clean · 18 more to resolved</span>
    </p>

    <!-- HIGH ALERT firing this run (severity='high' + sighted) -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#b54a3a;">tentative-booking-language-confusing</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#b54a3a;color:#fff;border-radius:999px;font-weight:600;">HIGH ALERT</span>
      <span style="margin-left:6px;font-size:11px;color:#b54a3a;font-style:italic;">1 caught</span>
      <br/>
      <span style="color:#3d3b35;">Conv 8302 (Jordan, Foothills Crossing). Operator-flagged; not auto-resolving.</span>
    </p>

    <!-- HIGH ALERT not firing this run -->
    <p style="margin:0 0 8px;font-size:13px;color:#8a4a30;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">leads-not-received</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#fbe5dc;color:#b54a3a;border-radius:999px;font-weight:600;">HIGH ALERT</span>
      <span style="margin-left:6px;font-size:11px;color:#b54a3a;font-style:italic;">clean run</span>
      <span style="margin-left:8px;font-size:12px;">8 runs clean · 2 more before step-down</span>
    </p>

    <!-- MONITORING (probationary) firing this run -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#7a5d1c;">riverside-no-langley-inventory</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#f4e5c4;color:#7a5d1c;border-radius:999px;font-weight:600;">MONITORING</span>
      <span style="margin-left:6px;font-size:11px;color:#7a5d1c;font-style:italic;">sighting 2/3</span>
      <br/>
      <span style="color:#3d3b35;">Sara at Riverside Gardens Langley requested a 3-bed, AI tried intra-region cross-sell but no Langley/Aldergrove inventory matched. Conv 8243.</span>
    </p>

    <h3 style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#807548;font-weight:600;margin:24px 0 10px;">Needs follow-up</h3>

    <!-- New action this run -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#8c3527;">failed-booking</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#ecc8c0;color:#8c3527;border-radius:999px;font-weight:600;">ACTION</span>
      <span style="margin-left:6px;font-size:11px;color:#8c3527;font-style:italic;">new this run</span>
      <br/>
      <span style="color:#3d3b35;">Conv <a href="https://www.rentsimple.ai/admin/conversations?conversationId=8341" style="color:#8a4a30;">#8341</a> — Jordan booked a 4pm tour at Foothills Crossing, manager cancelled, AI replied "let me know if you'd like to reschedule" and Jordan went silent. Call and rebook.</span>
    </p>

    <!-- Carried over from prior run, still open -->
    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#8a4a30;">dropped-thread</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#f0d9cc;color:#8a4a30;border-radius:999px;font-weight:600;">ACTION</span>
      <span style="margin-left:6px;font-size:11px;color:#8a4a30;font-style:italic;">open 2 runs · flagged 18h ago</span>
      <br/>
      <span style="color:#3d3b35;">Conv <a href="https://www.rentsimple.ai/admin/conversations?conversationId=8302" style="color:#8a4a30;">#8302</a> — Sara asked twice about the $200 deposit on unit 4B, AI talked about pet policy instead. She hasn't replied since Tuesday.</span>
    </p>

    <!-- Resolved-this-run footer, only if any flipped to resolved on this run -->
    <p style="margin:16px 0 0;font-size:12px;color:#807548;font-style:italic;">
      Resolved this run: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">virtual-tours-disabled-flag</span> (30 clean runs); action <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">unanswered-question</span> on conv #8270 (prospect replied after follow-up).
    </p>

    <!-- Scan footer — always present, confirms Step 4 ran -->
    <p style="margin:12px 0 0;font-size:12px;color:#807548;font-style:italic;">
      Scanned the remaining conversations — nothing else worth flagging.
    </p>

  </div>
</div>
```

**Activity strip rules:**

- Render under the customer name, before the Known issues heading.
- Bullet separator (`·`) between counts. Whitespace around it.
- Omit any count that is zero or trivially small.
- If the customer had no activity at all, replace the strip with `no activity in window`.
- Strip is one line, 12px, olive `#807548`.

**Sub-tag (small italic, immediately after the status pill):**

Every issue line gets a small italicised sub-tag for what happened *this run*, separate from the long-running status pill:

- **`{N} caught`** — issue fired this run with N discrete instances. Use the count of distinct example IDs.
- **`firing`** — issue fired via a state-based signal (ratio, threshold). No discrete instance count makes sense.
- **`clean run`** — signal did NOT fire this run. Followed by the long-running countdown text.
- **`sighting {Streak}/3`** — monitoring row sighted this run.
- **`no sighting`** — monitoring row not sighted this run.

Sub-tag colour matches the pill text colour. 11px italic.

**Pill / detail-line table (driven by status + severity + fired):**

| status | severity | fired | Pill | Detail line |
|---|---|---|---|---|
| monitoring | medium | yes | MONITORING (`#f4e5c4` bg, `#7a5d1c` text) | examples on next line + `sighting {streak}/3` |
| monitoring | medium | no | MONITORING muted (`#f0e9d8` bg, `#9a8a5a` text) | `no sighting · {days remaining} to dismissal` |
| open | medium | yes | OPEN (`#f0d9cc` bg, `#8a4a30` text) | examples on next line |
| open | medium | no | QUIET (`#ede8d8` bg, `#807548` text) | `{clean_runs} runs clean · {30 - clean_runs} more to resolved` |
| any active | high | yes | HIGH ALERT (`#b54a3a` bg, white text) | examples on next line |
| any active | high | no | HIGH ALERT muted (`#fbe5dc` bg, `#b54a3a` text) | `{clean_runs} runs clean · {10 - clean_runs} more before step-down` |
| resolved | any | no | omitted entirely | — |
| resolved | any | yes (regression) | OPEN with italic regression note | examples + `(regressed after {N} clean runs)` |

**Auto-resolution transition:** if `status = 'open'`, `clean_runs >= 30`, and signal absent → flip to `resolved`. Do NOT render in the Known issues section. Render once in the "Resolved this run" footer (one-shot), then disappear from future emails.

**Resolved-this-run footer:**

- Only render if at least one issue flipped to `resolved` on this run.
- Small italic muted text. Lists the slugs with their final clean-run count.
- Issues already `resolved` on prior runs do not appear here — they're invisible until they regress.

**Scan footer — always render, one short italic line per customer:**

Confirms Step 4 actually ran, even when nothing new came out of it.

- If new patterns *were* found: `"Also flagged 1 new pattern above."` (no need to list them again — they're already in the Known issues block as `MONITORING`).
- If nothing new: vary the phrasing slightly so it doesn't read like a robotic boilerplate line every run. Examples:
  - "Scanned the remaining conversations — nothing else worth flagging."
  - "Rest of the window looked normal."
  - "Reviewed the other N conversations — no new patterns."
  - "Nothing else stood out in the scan."
- Use the actual conversation count from the activity strip when it adds context.
- Same styling as Resolved footer: 12px italic, olive `#807548`.
- Render even when the customer had no activity in the window — in that case: `"No conversations in window — nothing to scan."`

**Tag rules:**

- Issue `kind` rendered in monospace, never bold.
- No `<b>`, no `<strong>`, no underlines anywhere in the body.

**Layout rules:**

- One blank-line gap between issues (12px margin), wider gap before a new section heading (24px).
- Each customer separated by a thin top border (`#e3decf`) and 32px bottom margin.
- Opening line is greyer (`#3d3b35`) and smaller — sets tone without competing.
- Section headings are small uppercase olive (`#807548`).
- Customer name in Georgia serif — the one place a different font is used, to anchor the section.

**Conditional rendering:**

- If a customer has no `open` action items (and none surfaced this run), omit the `Needs follow-up` heading entirely.
- If all known issues are QUIET / muted, no new patterns, AND no action items, render only the customer name and one muted line: `<p style="margin:0;font-size:13px;color:#807548;">Nothing firing this run.</p>`
- If all watched customers are quiet, the whole body is the opening line + one customer block each saying "Nothing firing this run." Don't skip customers entirely — the operator needs to know they were checked.

**Action-section ordering:**

Render `Needs follow-up` *after* `Known issues`. Within the section, sort by: new-this-run first, then carried-over (open from prior runs) by `first_flagged` desc (oldest at the bottom so the freshest items lead). HIGH-stakes kinds (`failed-booking`, `wrong-bedroom-or-unit`, `frustrated-prospect`) get the solid `#ecc8c0` / `#8c3527` ACTION pill; the rest get the lighter `#f0d9cc` / `#8a4a30` ACTION pill.

**Action sub-tag:**

- **`new this run`** — `first_flagged = now`. Solid pill if a high-stakes kind, otherwise standard.
- **`open N runs · flagged Xh ago`** — carried over. `N` = how many runs since `first_flagged` (count `customer-watch` runs in the window between then and now). `Xh` is wall-clock age — hours up to 48h, days after that.

**Hard rules for the email:**

- Never describe what the skill is doing internally. No mention of `cs_issues`, `state_query`, no DB bookkeeping.
- Never propose fixes, file tickets, or recommend next steps. This skill reports; it doesn't direct.
- No PII. Conversation IDs only. No customer staff names if you can avoid it, though first names attached to a conv ID are OK ("Olivia, Panorama→Foothills").
- No emojis. No bold-text headings inside paragraphs except the issue `kind` at the start.

# Step 6 — Writeback

All writes go through `state_query`. Order: upsert companies, then upsert issues, then close the run.

## 6a. Upsert companies

For every watched company resolved in Step 1, ensure the `companies` row exists. `admin_id` is the prod `Company.id`; `slug` is a kebab-case handle of the name:

```sql
INSERT INTO companies (slug, name, admin_id)
VALUES ('briarlane', 'Briarlane', 76)
ON CONFLICT (slug) DO UPDATE
  SET name = excluded.name, admin_id = excluded.admin_id;
```

## 6b. New issues (Step 4 new patterns)

For each new pattern, insert it as `monitoring`. Resolve `company_id` from the slug in the same statement:

```sql
INSERT INTO cs_issues (company_id, kind, status, severity, streak, clean_runs,
                       summary, detection_signal, sample_convs, first_sighted, last_sighted)
SELECT c.id, 'wrong-city-cross-sell', 'monitoring', 'medium', 1, 0,
       'AI offered a property in a different region from the prospect''s inquired property.',
       'Any AI message where the listing referenced is in a different region from the prospect''s inquired property.',
       '["8243"]'::jsonb, now(), now()
FROM companies c WHERE c.slug = 'riverside-langley'
ON CONFLICT (company_id, kind) DO UPDATE
  SET streak = cs_issues.streak + 1, clean_runs = 0, last_sighted = now(),
      sample_convs = excluded.sample_convs
  WHERE cs_issues.status <> 'dismissed';
```

`summary` and `detection_signal` are written once and **never rewritten** on later runs. The `WHERE cs_issues.status <> 'dismissed'` guard ensures a re-detected pattern can never silently reopen an issue the operator dismissed. New patterns insert with the default `origin = 'customer-watch'` — never set `origin` yourself.

## 6c. Existing issues

For each known issue, apply the Step 3 transition by `id`:

```sql
UPDATE cs_issues
SET status = 'open', severity = 'medium', streak = 4, clean_runs = 0,
    last_sighted = now(), sample_convs = '["8224","8083"]'::jsonb,
    notes = 'sighted this run; 2 examples'
WHERE id = 42;
```

For an auto-resolve, also set `resolved_at = now()` and a `notes` rationale (trigger rule, first/last-sighted dates, days clean). For a regression, set `resolved_at = NULL`, `status = 'open'`, `streak = 1`, `clean_runs = 0`, and a `notes` rationale.

- Update only the rows that changed this run. An untouched issue (not sighted, no transition) still needs `clean_runs += 1` — apply that.
- **`kind`, `summary`, `detection_signal` are stable** — never rewrite them once set.
- Do not set `updated_at` — the DB trigger maintains it.

## 6d. CS actions

For each new action item from Step 4.5, insert. For each existing `open` item that was re-flagged this run, bump `last_flagged`. For auto-resolves and age-outs, update the row.

```sql
-- New action this run
INSERT INTO cs_actions (company_id, conversation_id, action_kind, summary, sample_evidence)
SELECT c.id, 8341, 'failed-booking',
       'Jordan booked a 4pm tour at Foothills Crossing, manager cancelled, AI offered to reschedule and Jordan went silent.',
       '[{"message_id":91204},{"appointment_id":2218}]'::jsonb
FROM companies c WHERE c.slug = 'foothills-crossing'
ON CONFLICT (conversation_id, action_kind) DO UPDATE
  SET last_flagged = now()
  WHERE cs_actions.status = 'open';

-- Auto-resolve
UPDATE cs_actions
SET status = 'resolved', resolved_at = now(),
    notes = 'auto-resolved — manager replied at 2026-05-24T18:02Z, prospect replied at 2026-05-24T19:11Z'
WHERE id = 88;

-- Age-out
UPDATE cs_actions
SET status = 'dismissed',
    notes = 'aged out — stale for 14+ days, first_flagged 2026-05-09'
WHERE id = 73;
```

`summary` and `action_kind` are stable on insert — never rewrite them on later runs. `notes` is the operator-owned field except when this skill writes a transition rationale; never overwrite an operator-set `notes`.

## 6e. Close the run

```sql
UPDATE runs
SET status = 'succeeded', finished_at = now(),
    summary = '3 watched customers; 2 of 5 known issues fired; 1 new pattern; 2 action items.',
    stats = '{"watched":3,"sighted":2,"new":1,"resolved":0,"processed":42,
             "actions_new":2,"actions_open":3,"actions_resolved":1}'::jsonb
WHERE id = <run_id>;
```

If the run failed before this point, leave the row `running` (or set it to `failed` with a summary if you can).

# Hard rules

- Read-only on the prod DB (`query`). Reads and writes only to the watch-state DB (`state_query`), and only `cs_issues`, `cs_actions`, `companies`, `runs`.
- **Read message-level data, not summaries.** Every check reads actual `ConversationMessage` rows (NOT `Message` — different table). `Conversation.summary` is unreliable; orientation hint only.
- **Customer-watch is isolated.** This skill never touches `issues`, `clusters`, or `cluster_snapshots`. Those belong to conversation-watch / daily-pulse.
- No PII or email-thread quotes in the email body.
- No emojis.
- Watched-customer list is source of truth. Don't expand or shrink it based on today's signal.
- The skill reports. It does not propose, recommend, suggest, prioritize, file, or escalate.
- `status` writes must be exactly `open`, `monitoring`, `resolved`, or `dismissed`; `severity` exactly `low`, `medium`, or `high`. The DB domains reject anything else.
- **`detection_signal` must be mechanical** — describe the pattern in terms of message content, property/building involvement, error codes, or state metrics. NEVER reference `Conversation.summary`.
- **Never reopen a `dismissed` issue**, and never re-insert a dismissed `(company, kind)` as new. Dismissal is the operator's call; only an operator un-dismisses.
- **`operator_note` is operator-owned** — read it as guidance for the run, never write or clear it. **`origin` is set at creation** — never change it; new patterns this skill creates keep the default `customer-watch`.
- **Every resolve requires a rationale in `notes`** — trigger rule, first-sighted date, last-sighted date, days clean. If you can't construct one (e.g. monitoring row first sighted <7 days ago), do NOT resolve — leave the issue in its current status.

# Chat report-back

Short, free-form. One line each:

- Watched customers (names + admin IDs)
- Email sent to (recipients)
- `cs_issues` rows written (rough count: N updated + M created)
- `cs_actions` this run: K new · J open carried · R auto-resolved · D aged out
- `dismissed` suppressions if any
- Anything weird worth flagging (state_query write failures, domain rejections, prod query slowness, etc.)
