---
description: Scans data since the last run for a small named list of customers and reports which known issues are still firing, with example conversation IDs. Also surfaces any new patterns noticed in the conversations. Doesn't propose fixes — just shows what's happening. Runs as often as you want; state keyed off the last run, not the calendar.
argument-hint: comma-separated company IDs to watch (required), then optional comma-separated email recipients
---

You're the operator's daily scan. For each watched customer: check whether each known issue is still happening, give example conv IDs, and flag anything new you noticed in the data. Don't propose fixes. Don't recommend tickets. Just report what's there.

# When to use this

- **daily-pulse** — Tue–Fri portfolio sweep, AI failure patterns across all customers
- **customer-watch** (this one) — per-run scan of a fixed list of customers, known-issue updates + new pattern detection
- **health-check** — weekly, full report

# Required MCP tools

- Postgres MCP (read-only DB)
- RS-DB MCP `send_email`
- Notion MCP `notion-query-database-view` (primary lookup, Step 1), `notion-fetch` (body reads), `notion-search` (fallback only), `notion-update-page` + `notion-create-pages` (writeback) on `Self learning db` (`collection://35f9fe3f-af42-80ba-bf81-000b602adf12`)

If Postgres or RS-DB email is missing, stop and report. If Notion is missing, send the email anyway and skip the writeback, note "(Notion unavailable this run)".

# Configuration

- **Watched companies**: first arg — comma-separated numeric company IDs, e.g. `22,57,76`. Required. If not provided, stop and ask.
- **Email recipients**: second arg, else env `$HEALTH_CHECK_RECIPIENTS`, else ask once.

# Step 1 — Read Notion known issues

**This step uses a deterministic view query, not semantic search.** `notion-search` is unreliable for exact-title lookup because results are ranked and capped at 25 — the exact-named row can fall outside the top 25 and cause Step 7 to either skip the update or create a duplicate. The view query returns every Customer-type row in a defined order, paginated reliably.

## 1a. Query the lookup view

Call `notion-query-database-view` once:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=3609fe3faf428049bc99000cd69e28a3`

This view is pre-configured to filter `Type = Customer` and sort by `Run date` desc. The result is the full list of customer-watch rows across all customers — no ranking, no cap.

If the call returns paginated results (more rows than fit in one page), iterate through all pages until exhausted. Don't stop at the first page.

If the view query fails entirely, fall back to `notion-search` with `data_source_url: collection://35f9fe3f-af42-80ba-bf81-000b602adf12` and exhaust pagination. Note "(view query failed, fell back to search)" in chat report-back so the operator can investigate.

## 1b. Filter to watched customers' rows

From the returned rows, keep only those whose `Name` matches one of these patterns for a watched company slug (case-sensitive, exact):

- `cs-{slug}` → summary row
- `cs-{slug}-{issue-slug}` → per-issue row

Ignore any row whose Name doesn't match a pattern exactly for a watched customer. Other customers' rows in the view are not relevant to this run.

## 1c. Deduplicate by exact Name

For each exact Name with 2+ rows (duplicates from past runs), keep the most recent by `Run date` (ties: createdTime) as canonical. Surface duplicate counts in chat report-back so the operator can clean up manually.

Final maps:

- `summary[company] → {page_id, properties, body}` — exact-Name `cs-{slug}`
- `issues[company] → {exact_name → {page_id, properties, body}}` — exact-Name `cs-{slug}-{issue-slug}`

`notion-fetch` each canonical per-issue row's body to extract:

- **Detection signal** — how to detect the issue mechanically
- **Status** — `OPEN`, `QUIET`, `RESOLVED`, or `NON ISSUE`

## 1d. Filter NON ISSUE

For each canonical Name, check its `Status`. If `NON ISSUE`, drop that Name entirely — no signal check, no mention in email, no writeback. Count distinct dropped Names for chat report-back. Most recent verdict per Name wins.

## 1e. Hard precondition for Step 7

Before any writeback runs: the Step 1 maps must exist. If Step 1 returned zero rows total across all watched customers AND the view query did not fail, that's a real state — proceed normally (everything is a NEW). But if the view query failed AND the fallback search also returned nothing, abort writeback and surface the failure in chat — don't "best-effort create" rows that might duplicate something the lookup missed.

# Step 2 — Determine the window

Window start = the most recent `Run date` property value across all watched customers' canonical summary rows. Window end = now. If no prior summary rows, default to 24h.

**Strict rules — read carefully, this has caused short-window bugs:**

- Use ONLY the `Run date` property. Never use `Last edited time`, `Created time`, or any other timestamp Notion returns. Those reflect when properties were modified, not when the prior run happened.
- If `Run date` is a date-only value (no time), treat it as midnight UTC of that date. So `Run date: 2026-05-13` means window start = `2026-05-13T00:00:00.000Z`.
- If `Run date` is a datetime value, use it verbatim.
- When you WRITE `Run date` at the end of each run (Step 6 writeback), always write it as a **datetime** (ISO with time component, e.g. `2026-05-14T22:15:00.000Z`) — not a date-only value. This ensures the next run can compute a precise window without falling back on other timestamps.

# Step 2.5 — Top-line activity numbers

For each watched customer, pull a small set of activity counts for the window. These render as a one-line strip under the customer name so the operator has context for the issue updates (e.g. "0 examples of X" means very different things if the customer had 4 conversations vs 400).

Numbers to collect (per customer, since window start):

- **Conversations** — `Conversation.companyId = X AND createdAt >= window_start`
- **Low-rated conversations** — same, plus `adminRating <= 2`
- **Tours booked** — `Appointment` via `Manager.companyId`, `status IN ('Confirmed', 'ManagerConfirmed')`, not deleted
- **Tours completed** — same, `status = 'Completed'`
- **Tours cancelled** — same, `status IN ('ManagerCancelled', 'ProspectCancelled')`
- **Prospects** — `Prospect.companyId = X AND createdAt >= window_start`

Keep the strip short — only render the numbers that are non-zero or particularly interesting. Don't show "0 conversations · 0 prospects · 0 tours" — that's noise. If a customer is completely silent in the window, render just one phrase: "no activity in window."

# Step 3 — Check each known issue

For every per-issue row that survived the NON ISSUE filter:

1. Re-run the issue's detection signal against the window. **Read the actual `Message` rows for each conversation, not just `Conversation.summary`** — summaries are generated post-hoc and often miss what actually happened. Pull messages via `Message.conversationId` joined to conversations in the window. Read both directions (AI and prospect). The detection signal stored in the row body should be evaluated against message content, not against the summary string.
2. Collect up to 3 example conversation/property/error IDs.
3. Compute today's **fired** state — a per-run boolean, not a stored status:
   - `fired = true` if signal fires at least once in the window. Email renders as **OPEN** with examples.
   - `fired = false` if no signal in the window. Email renders as **QUIET** (display-only label — no signal this window).

## Stored Status — the lifecycle, not this run

The Notion `Status` property is the issue's **lifecycle state**, not its per-run signal. Valid values match the Notion select schema:

- **MONITORING** — probationary state. New patterns from Step 4 start here. Streak counts sightings; auto-escalates to OPEN at 3 sightings, auto-dismisses to RESOLVED after 3 consecutive clean runs. See Step 4 for full details.
- **OPEN** — default state for a tracked issue. Stays OPEN whether or not the signal fires on any given run. Streak counts consecutive clean runs.
- **RESOLVED** — auto-flipped after 30 consecutive clean runs from OPEN. Or auto-dismissed from MONITORING after 3 clean runs. Means we're not actively watching anymore.
- **HIGH ALERT** — manual operator flag. Same as OPEN but: (a) always rendered in the email even on quiet runs, (b) **auto-steps-down to OPEN after 10 consecutive clean runs** (Streak preserved). Once stepped down to OPEN, it follows normal OPEN rules and will continue toward auto-resolve at Streak 30.
- **NON ISSUE** — manual operator flag. Dropped entirely in Step 1d.

## Streak counter — consecutive clean runs

`Streak` = number of consecutive runs in which the signal did **not** fire. This drives the resolution countdown.

- Signal fires this run → `Streak = 0`.
- Signal absent this run → `Streak = prior Streak + 1`.
- New issue created this run → `Streak = 0` (signal just fired).

## Auto-resolution and auto-step-down

Two automatic Status transitions, evaluated in this order each run:

1. **HIGH ALERT → OPEN** (step-down). If `Status == HIGH ALERT` and signal is absent this run and `Streak >= 10` (going into this run, before incrementing), flip Status to `OPEN`. Streak preserved — don't reset. Once on OPEN, the next rule applies normally.
2. **OPEN → RESOLVED** (auto-resolve). If `Status == OPEN` and signal is absent this run and `Streak >= 30` (going into this run, before incrementing), flip Status to `RESOLVED`.

Both transitions happen automatically. Manual operator flips (HIGH ALERT, NON ISSUE) are sticky against signal-driven transitions but not against each other — operator can always override.

## Regression detection

If prior `Status == RESOLVED` and signal fires this run, flip Status back to `OPEN` and reset Streak to 0. Render in the email with an italicized trailing note: `(regressed after {N} clean runs)`.

## Rendering rules in the email

- `OPEN` + fired this run → render with OPEN pill, examples below
- `OPEN` + not fired this run → render with QUIET pill, `{Streak} runs clean · {30 - Streak} more to resolved`
- `HIGH ALERT` + fired this run → render with ALERT pill (use OPEN styling, but pill text says "HIGH ALERT"), examples below
- `HIGH ALERT` + not fired this run → render with HIGH ALERT muted pill, `{Streak} runs clean` (no countdown — no auto-resolution)
- `RESOLVED` + not fired → omit from email
- `RESOLVED` + fired this run (regression) → render with OPEN pill plus italic `(regressed after {N} clean runs)`
- The run that flips to RESOLVED: render once in a small "Resolved this run" footer line, then disappears on subsequent runs.

# Step 4 — Scan every conversation for new issues

Read **every** conversation in the window for each watched customer, not just low-rated ones. Don't filter by `adminRating`.

**Read message by message, not the summary.** The `Conversation.summary` field is generated post-hoc by another process and is often incomplete or misleading — it's fine for a quick orientation but cannot be the source of truth. For each conversation in the window, fetch its `Message` rows ordered by `id` (or `createdAt`) and read what was actually said. AI side and prospect side. Then judge.

The window is short — a single instance of something wrong is enough to flag.

For each conversation, ask: **does this show the AI doing something obviously wrong?** Examples of "obviously wrong":

- AI quoted a price that doesn't match listing data
- AI offered a property in the wrong city / way out of region
- AI agreed to something it can't deliver (a tour at a time without availability, a unit type that doesn't exist)
- AI dropped the close-loop — confirmed nothing after a long exchange
- AI gave clearly hallucinated information (made-up building names, fabricated policies)
- AI handed off to a human when it shouldn't have, or *didn't* hand off when it should have
- AI repeated itself / got stuck in a loop
- Tour booking failed silently
- Stale availability quoted from prior context
- Anything that would make the operator wince

Also still look at:

- Integration error spikes by `xPropertyId`
- Funnel/appointment anomalies you'd notice without being told to look

**Single instance is enough.** Don't require 2+ matches. The window is too short for that threshold. If you see one weird thing, flag it — it'll go to MONITORING (see below) and escalate naturally if it repeats.

For each flagged item:

- Write a one-sentence description of what's wrong (from customer's perspective)
- Note the conv ID (1 is fine; 2-3 if multiple matched)
- Form a stable kebab-case slug (e.g. `wrong-city-cross-sell`, `quoted-price-mismatch`)

These become new per-issue rows in Step 6 with **Status = MONITORING**.

## The MONITORING status

`MONITORING` is a probationary state for issues that haven't earned full tracking yet. A new flag enters as MONITORING; if it shows up again on subsequent runs, it escalates. If it doesn't, it gets dismissed quietly.

You need to add `MONITORING` to the Notion `Status` Select options — same place you added the others. Once that's done:

**Streak semantics for MONITORING** (different from OPEN/RESOLVED/HIGH ALERT):

- For MONITORING rows, `Streak` counts **sightings** — number of consecutive runs the signal has appeared.
- First time detected: Streak = 1.
- Same pattern detected again next run: Streak = 2. Etc.
- A run where the signal does NOT appear: Streak stays the same (don't increment), but increment a separate count of "clean runs since last sighting" tracked in `Notes` (e.g. `"sighting 2, 1 clean since"`).

**Auto-escalation: MONITORING → OPEN**

When a MONITORING issue is sighted on this run and Streak >= 3 (so this is the 3rd sighting), flip Status to `OPEN` on this run. Reset Streak to 0 (now counts clean runs per the OPEN rule).

**Auto-dismissal: MONITORING → RESOLVED**

When a MONITORING issue has been clean for 3 consecutive runs without further sightings, flip Status to `RESOLVED` with Notes "dismissed before escalation — false alarm or one-off." It disappears from email like any other RESOLVED row.

**Manual operator action:**

Operator can flip MONITORING → HIGH ALERT directly in Notion to skip the probation and prioritize immediately. Same rules as a regular HIGH ALERT from then on.

# Step 5 — Email

Short HTML. Should scan on a phone in under 30 seconds. Mobile email clients are inconsistent — use inline styles, no flexbox, no grid, no JS, no external CSS.

## Subject

`Customer watch — {N} customers — YYYY-MM-DD HH:MM`

Use timestamp because runs can happen multiple times a day.

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

    <!-- OPEN issue (no fire this run): muted, sub-tag says clean run, streak + countdown -->
    <p style="margin:0 0 8px;font-size:13px;color:#807548;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">date-confusion-on-tour-booking</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#ede8d8;color:#807548;border-radius:999px;font-weight:600;">OPEN</span>
      <span style="margin-left:6px;font-size:11px;color:#807548;font-style:italic;">clean run</span>
      <span style="margin-left:8px;font-size:12px;">12 runs clean · 18 more to resolved</span>
    </p>

    <!-- HIGH ALERT firing this run -->
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
      <span style="margin-left:8px;font-size:12px;">8 runs clean · 2 more before step-down to OPEN</span>
    </p>

    <h3 style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#807548;font-weight:600;margin:24px 0 10px;">New patterns noticed</h3>

    <p style="margin:0 0 12px;font-size:14px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#8a4a30;">riverside-no-langley-inventory</span>
      <span style="display:inline-block;margin-left:6px;padding:2px 8px;font-size:10px;letter-spacing:0.04em;background:#fbf3ed;color:#cc785c;border-radius:999px;font-weight:600;">NEW</span>
      <br/>
      <span style="color:#3d3b35;">Sara at Riverside Gardens Langley requested a 3-bed, AI tried intra-region cross-sell but no Langley/Aldergrove inventory matched. Single conv 8243 — keep watching.</span>
    </p>

    <!-- Resolved-this-run footer, only if any flipped to RESOLVED on this run -->
    <p style="margin:16px 0 0;font-size:12px;color:#807548;font-style:italic;">
      Resolved this run: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">virtual-tours-disabled-flag</span> (30 clean runs).
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
- Omit any count that is zero or trivially small (e.g. "0 cancelled" — drop it).
- If the customer had no activity at all, replace the strip with a single muted phrase: `no activity in window`.
- Strip is one line, 12px, olive `#807548`. Visually quieter than headings.

**Sub-tag (small italic, immediately after the status pill):**

Every issue line gets a small italicised sub-tag that tells the operator at a glance what happened *this run*, separate from the long-running Status pill:

- **`{N} caught`** — issue fired this run with N discrete instances (conv IDs / property IDs / error events). Use the count of distinct example IDs you'd cite below.
- **`firing`** — issue fired this run via a state-based signal (e.g. a ratio over a 30d rolling window, a count threshold). No discrete instance count makes sense.
- **`clean run`** — signal did NOT fire this run. Streak increments. Followed by the long-running streak + countdown text.

Sub-tag colour matches the pill text colour. 11px italic. Sits between the pill and the streak/countdown text (or between the pill and the line break before examples).

**Pill selection (driven by Status + fired-this-run):**

| Stored Status | Fired this run? | Pill | Detail line |
|---|---|---|---|
| MONITORING | yes | MONITORING (amber `#f4e5c4` bg, `#7a5d1c` text) | examples on next line + `sighting {Streak}/3` |
| MONITORING | no | MONITORING muted (beige `#f0e9d8` bg, `#9a8a5a` text) | `no sighting · {3 - clean} more clean runs to dismiss` |
| OPEN | yes | OPEN (peach `#f0d9cc`) | examples on next line |
| OPEN | no | QUIET (beige `#ede8d8`) | `{Streak} runs clean · {30 - Streak} more to resolved` |
| HIGH ALERT | yes | HIGH ALERT (solid `#b54a3a` bg, white text) | examples on next line |
| HIGH ALERT | no | HIGH ALERT muted (`#fbe5dc` bg, `#b54a3a` text) | `{Streak} runs clean · {10 - Streak} more before step-down to OPEN` |
| RESOLVED | no | omitted from email entirely | — |
| RESOLVED | yes (regression) | OPEN with italic regression note | examples + `(regressed after {N} clean runs)` |

**MONITORING rendering:** Render in the **same section as known issues** (not under "New patterns noticed" anymore — that section is gone). The amber pill visually distinguishes probationary issues from established OPEN ones. On the run where Streak hits 3 and it auto-escalates to OPEN, render it once with both transition info — `MONITORING → OPEN (3rd sighting, now tracking)` — then it appears as a normal OPEN issue going forward.

**Auto-resolution transition:**

If `Status == OPEN` and `Streak >= 30` going into this run and signal is absent → flip to RESOLVED. Do NOT render in the Known issues section. Render once in the "Resolved this run" footer (one-shot visibility), then disappear from future emails.

**Resolved-this-run footer:**

- Only render if at least one issue flipped to RESOLVED on this run.
- Small italic muted text. Lists the slugs with their final clean-run count.
- Issues already RESOLVED on prior runs do not appear here — they're invisible until they regress.

**Scan footer — always render, one short italic line per customer:**

Confirms Step 4 actually ran, even when nothing new came out of it. Reassures the operator the scan wasn't skipped.

- If new patterns *were* found: a brief reference like `"Also flagged 1 new pattern above."` (no need to list them again — they're already in the New patterns block).
- If nothing new: vary the phrasing slightly so it doesn't read like a robotic boilerplate line every run. Examples:
  - "Scanned the remaining conversations — nothing else worth flagging."
  - "Rest of the window looked normal."
  - "Reviewed the other N conversations — no new patterns."
  - "Nothing else stood out in the scan."
- Use the actual conversation count from the activity strip when it adds context (e.g. "Reviewed the other 6 conversations — clean").
- Same styling as Resolved footer: 12px italic, olive `#807548`.
- Render even when the customer had no activity in the window — in that case: `"No conversations in window — nothing to scan."`

**Status writes — schema enforcement:**

The Notion `Status` Select schema accepts only: `OPEN`, `RESOLVED`, `NON ISSUE`, `HIGH ALERT`. Never write any other value. `QUIET` is a display label only — never persisted to the Status property. If you find yourself wanting to write a status not in this list, that's a bug — skip the write and surface in chat report-back.

**Tag rules:**

- `OPEN` pill — peach background `#f0d9cc`, text `#8a4a30`. Issue slug rendered in the same brown color so the eye groups them.
- `QUIET` pill — beige background `#ede8d8`, text `#807548`. Whole row uses that muted color and slightly smaller font so it visually recedes.
- `NEW` pill (new patterns only) — light peach background `#fbf3ed`, text `#cc785c`. Same brown slug color as OPEN — these need attention.
- Issue slug is always monospace, never bold.
- No `<b>`, no `<strong>`, no underlines anywhere in the body.

**Layout rules:**

- One blank-line gap between issues (12px margin), wider gap before a new section heading (24px).
- Each customer separated by a thin top border (`#e3decf`) and 32px bottom margin.
- Opening line is greyer (`#3d3b35`) and smaller — sets tone without competing.
- Section headings are small uppercase olive (`#807548`) — quiet but clearly delimit sections.
- Customer name in Georgia serif — the one place a different font is used, to anchor the section.

**Conditional rendering:**

- If a customer has no new patterns, omit the `New patterns noticed` heading entirely.
- If all known issues are QUIET and no new patterns, render only the customer name and one muted line: `<p style="margin:0;font-size:13px;color:#807548;">Nothing firing this run.</p>`
- If all watched customers are quiet, the whole body is the opening line + one customer block each saying "Nothing firing this run." Don't skip customers entirely — operator needs to know they were checked.

**Hard rules for the email:**

- Never describe what the skill is doing internally. No "creating a new row this run", no "flipping the canonical", no "archive-dup cleanup", no mention of Notion bookkeeping at all.
- Never propose fixes, file tickets, or recommend next steps. This skill reports; it doesn't direct.
- No PII. Conversation IDs only. No customer staff names if you can avoid it, though first names attached to a conv ID are OK ("Olivia, Panorama→Foothills").
- No emojis. No bold-text headings inside paragraphs except the issue slug at the start.

# Step 6 — Notion writeback

Upsert by exact Name. Never create duplicates.

For each known per-issue row + each new pattern from Step 4 + the summary row per customer:

1. Look up the page_id in the Step 1 map using the exact Name string.
2. **If page_id exists:** `notion-update-page` with `command: update_properties` — overwrite Status (one of `OPEN`/`RESOLVED`/`HIGH ALERT`/`NON ISSUE` per Step 3 transitions; never paraphrase), Run date (now), Sample Convs (today's examples if signal fired, else empty), Streak (clean-run count from Step 3), Notes (one short line). Body stays intact.
3. **If no page_id in the map** (new pattern only): `notion-create-pages` with parent `{"type": "data_source_id", "data_source_id": "35f9fe3f-af42-80ba-bf81-000b602adf12"}` and the body template below.

**Hard rules against duplicates:**

- Never call `notion-create-pages` for a Name that exists as an exact-title key in the Step 1 map.
- Never call `notion-create-pages` because a search "didn't return" something — only because the Step 1 map genuinely has no entry for that exact Name.
- If Step 1 surfaced multiple rows for the same Name, do NOT create another. Update the canonical, leave the dupes for manual cleanup.
- The Name string for create must match the slug pattern exactly: `cs-{company-slug}` or `cs-{company-slug}-{issue-slug}`. No suffixes, no timestamps.

## Properties

Both row types:

- **Run date** (date): now, ISO
- **Companies** (text): customer name
- **Companies count** (number): 1
- **Type** (select): `Customer`

Summary row (`cs-{slug}`):

- **Name** (title): `cs-{company-slug}`
- **Status** (select): always `OPEN` (the summary represents an actively-watched customer)
- **Sample Convs** (text): up to 3 conv IDs from today
- **Streak** (number): total runs this customer has been watched (prior + 1)
- **Notes** (text): one short line — e.g. "2 of 4 known issues fired; 1 new pattern noticed"

Per-issue row (`cs-{slug}-{issue-slug}`):

- **Name** (title): `cs-{company-slug}-{issue-slug}`, stable across runs
- **Status** (select): from Step 3 — `OPEN`, `RESOLVED`, `HIGH ALERT`, or `NON ISSUE`. Never `QUIET` (that's display-only).
- **Sample Convs** (text): up to 3 example IDs from this run if signal fired; empty otherwise
- **Streak** (number): consecutive runs in which the signal did NOT fire (the clean-run counter from Step 3). Reset to 0 on a run where the signal fires.
- **Notes** (text): one short line — e.g. "fired: 2 examples", "clean run 12/30", "stepped down from HIGH ALERT"

## New per-issue body template

```markdown
**Issue:** <one sentence — what's going wrong from customer's perspective>

**Detection signal:** <mechanical — describe the pattern in terms of message content (what the AI said, what the prospect said), property/building involvement, error codes, or state metrics. NEVER write a detection signal that depends on `Conversation.summary` — summaries are unreliable. Future runs will read message rows and judge against this signal.>

**Examples on first detection:**

- {conv_id} — {one-line context}
- {conv_id} — {one-line context}
```

Detection signals must be mechanical AND must reference message content (not summaries). Good: `"AI message body contains a price quote AND the prospect's listing's published price differs by >$200"`, or `"Any message where AI references a property in a different region from the prospect's inquired property"`. Bad: `"prospects complain about Williams pricing"` (too fuzzy), `LOWER(c.summary) LIKE '%williams%'` (depends on unreliable summary).

If a writeback call fails, retry once. If still failing, include the failed payload in chat report-back; don't abort the run.

# Hard rules

- Read-only on the DB.
- **Read message-level data, not summaries.** Every conversation check (Step 3, Step 4) must read the actual `Message` rows for each conversation in the window — both AI and prospect sides. `Conversation.summary` is a post-hoc rollup that often misses or misrepresents what actually happened. Use it only as a quick orientation hint, never as the source of truth for whether a signal fired.
- No PII or email-thread quotes in the email body.
- No emojis.
- Watched-customer list is source of truth. Don't expand or shrink it based on today's signal.
- The skill reports. It does not propose, recommend, suggest, prioritize, file, or escalate.

# Chat report-back

Short, free-form. Cover:

- Watched customers (names + IDs)
- Email sent to (recipients)
- Notion rows written (rough count: N updated + M created)
- NON ISSUE suppressions if any
- **Duplicate rows detected** in Notion (Name → count) for manual cleanup
- Anything weird worth flagging (Notion lookup failed, writeback retry needed, etc.)
