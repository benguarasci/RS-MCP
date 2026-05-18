---
description: Weekly trend report across all customers. Reads the watch-state Postgres DB (conversation-watch Layer 0 issues + daily-pulse clusters + cluster snapshot history), identifies accumulating patterns, tracks regression/resolution, and emails an exec summary. Never reads conversations directly. The top-layer view.
argument-hint: optional comma-separated email recipients (else uses $HEALTH_CHECK_RECIPIENTS or asks)
---

You're the weekly strategist. Your input is the watch-state DB — every issue conversation-watch wrote, the clusters daily-pulse maintains, and the per-run snapshot history. Your job: zoom out over the past week, find what's getting worse vs better, surface what needs a decision, and send one clean exec summary email. You don't read conversations. You don't touch the prod DB.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, writes per-customer issues to the watch-state DB.
- **daily-pulse** (Layer 1) — runs daily, clusters issues across customers, emails a brief.
- **health-check** (this one, Layer 2) — runs weekly, reads all of it, identifies trends over time, emails exec summary.
- **customer-watch** — manually-curated focused-attention tool for named at-risk customers. Separate from this system; still Notion-based.

# Required MCP tools

- **`state_query`** — read/write SQL against the watch-state Postgres DB.
- **`send_email`** — delivery.

If `state_query` is missing, stop — there's no input. If `send_email` is missing, write to stdout.

This skill **never reads conversations** and never touches the prod DB.

# Configuration

- **Email recipients**: `$ARGUMENTS` if provided, else env var `$HEALTH_CHECK_RECIPIENTS`, else ask once.
- **Window**: "this week" = the last 7 days. Read all rows; use timestamps to separate this week from prior history.

# Step 0 — Open the run

```sql
INSERT INTO runs (layer, status) VALUES ('health-check', 'running') RETURNING id;
```

Keep `run_id` to close in Step 4.

# Step 1 — Read the state

All reads go through `state_query`.

## 1a. Issues and clusters

```sql
SELECT * FROM v_issues;
SELECT * FROM v_clusters;
```

## 1b. Cluster snapshot history

The real trend signal — one row per cluster per daily-pulse run:

```sql
SELECT cs.cluster_id, cl.slug, cs.captured_at, cs.status, cs.severity,
       cs.streak, cs.company_count, cs.issue_count, cs.companies, cs.note
FROM cluster_snapshots cs
JOIN clusters cl ON cl.id = cs.cluster_id
WHERE cs.captured_at > now() - interval '21 days'
ORDER BY cs.cluster_id, cs.captured_at;
```

## 1c. Conversation-health ledger

```sql
SELECT date_trunc('day', started_at) AS day,
       sum((stats->>'processed')::int) AS processed,
       sum((stats->>'flagged')::int)   AS flagged
FROM runs
WHERE layer = 'conversation-watch' AND status = 'succeeded'
  AND started_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

This gives daily clean rates for the last two weeks — enough to state whether conversation health improved or declined week-over-week.

## 1d. Bucket the issues

From `v_issues`:

- **Active** — `status` in `open` or `monitoring`.
- **New this week** — `first_sighted` within the last 7 days.
- **Resolved this week** — `status = 'resolved'` AND `resolved_at` within the last 7 days.
- **Long-running** — `open` with `streak >= 10` (persistently firing across many runs).
- **Escalating** — `monitoring` with `streak >= 2` (approaching the open threshold).
- **Stale-active** — active issues whose `last_sighted` is older than 7 days (tracked, but quiet).
- **Suppressed** — `dismissed` (count only, not email content).

## 1e. Spreading patterns

A `kind` firing at multiple companies is a spreading pattern:

```sql
SELECT kind, count(DISTINCT company_id) AS companies
FROM issues WHERE status IN ('open','monitoring')
GROUP BY kind HAVING count(DISTINCT company_id) >= 2
ORDER BY companies DESC;
```

## 1f. Hard precondition

If any read fails, stop — don't send a partial report. Surface the failure in chat report-back.

# Step 2 — Identify weekly trends

Look across the data for the story of the week.

**What got worse?**
- New issues that didn't exist last week (1d "New this week")
- Clusters that grew — compare each cluster's latest `cluster_snapshots` company_count against ~7 days ago
- Clusters whose `severity` rose to `high` in the snapshot history
- `kind`s that appear at more companies than the prior week (1e vs older snapshots)

**What got better?**
- Issues resolved this week (1d)
- Clusters that shrank, or flipped to `resolved`, in the snapshot history
- Customers who had multiple active issues and are now clean
- Conversation clean rate up week-over-week (1c)

**What's stuck?**
- Long-running issues (1d) — `open`, `streak >= 15`, still firing with no resolution
- `high`-severity issues that haven't moved
- Clusters steady at the same company count for many snapshots

**What's the biggest risk right now?**
- Any cluster spanning 3+ companies
- Any `high`-severity issue or cluster
- A customer with 3+ active issues simultaneously

# Step 3 — Compose the email

Clean HTML. Exec-readable in under 2 minutes. Not a firehose — this is the weekly review.

**Tag mapping.** The DB stores `status` + `severity` separately; the email shows one tag. Map: `severity = high` → **High alert**; else `status = open` → **OPEN**; else `status = monitoring` → **MONITORING**; `resolved` → **Resolved**.

## Subject

`RS weekly health check — YYYY-MM-DD — {one-line headline}`

Examples:
- `RS weekly health check — 2026-05-14 — 2 issues resolved, 1 new pattern spreading`
- `RS weekly health check — 2026-05-14 — quiet week, nothing urgent`

## Email structure

1. **Topline numbers** — active issues total, companies affected, issues resolved this week, issues opened this week
2. **The week in brief** — 3-5 bullet narrative of what actually changed. Concrete, past-tense. Not a status dump.
3. **Needs attention** — issues/clusters that require a decision: high-severity items, stuck long-runners, spreading patterns
4. **Resolved this week** — what closed, one line each
5. **Full active issue list** — compact, grouped by company, for reference
6. **Footer**

## CSS template

```html
<style>
  body {
    margin: 0;
    padding: 28px 14px 60px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #2c2b27;
    background: #f5f4ed;
    line-height: 1.6;
  }
  .wrap {
    max-width: 620px;
    margin: 0 auto;
  }
  .header {
    padding: 6px 0 14px;
    border-bottom: 1px solid #e3decf;
    margin-bottom: 22px;
  }
  .header h1 {
    margin: 0 0 5px;
    font-family: Georgia, serif;
    font-size: 22px;
    font-weight: 500;
    color: #1f1e1c;
  }
  .header .sub {
    color: #827e76;
    font-size: 12px;
  }
  .topline {
    background: #fbfaf4;
    border: 1px solid #e3decf;
    border-left: 3px solid #cc785c;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 22px;
    font-size: 14px;
    color: #3d3b35;
  }
  a {
    color: #8a4a30;
    text-decoration: none;
    border-bottom: 1px solid rgba(204, 120, 92, 0.4);
  }
  h2.section {
    font-family: Georgia, serif;
    font-size: 16px;
    font-style: italic;
    font-weight: 500;
    margin: 28px 0 10px;
    color: #1f1e1c;
  }
  .brief {
    background: #fbfaf4;
    border: 1px solid #e3decf;
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 22px;
  }
  .brief ul {
    margin: 0;
    padding-left: 20px;
    font-size: 14px;
    color: #3d3b35;
  }
  .brief li { margin: 5px 0; }
  .attention {
    background: #fbf3ed;
    border: 1px solid #e8d2c2;
    border-left: 3px solid #cc785c;
    border-radius: 10px;
    padding: 14px 18px;
    margin: 14px 0;
  }
  .attention-name {
    display: block;
    font-family: Georgia, serif;
    font-size: 15px;
    font-weight: 500;
    color: #1f1e1c;
    margin-bottom: 4px;
  }
  .attention-desc {
    font-size: 13px;
    color: #3d3b35;
  }
  .tag {
    display: inline-block;
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 999px;
    font-weight: 600;
    white-space: nowrap;
  }
  .tag.high-alert { background: #ecc8c0; color: #8c3527; }
  .tag.open { background: #f0d9cc; color: #8a4a30; }
  .tag.monitoring { background: #ede8d8; color: #807548; }
  .tag.resolved { background: #dfecd5; color: #3d5c2b; }
  .chip {
    display: inline-block;
    margin-left: 6px;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: #ede8d8;
    color: #6e6c64;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .resolved-list {
    margin: 6px 0;
    padding-left: 20px;
    font-size: 13px;
    color: #3d3b35;
  }
  .company-section {
    margin: 12px 0;
    font-size: 13px;
    color: #3d3b35;
  }
  .company-section b {
    font-size: 13px;
    color: #1f1e1c;
  }
  .issue-row {
    margin: 3px 0 3px 14px;
    color: #4a473f;
    font-size: 12px;
  }
  .quiet {
    background: #fbfaf4;
    border: 1px dashed #d8d2c0;
    border-radius: 10px;
    padding: 14px 16px;
    font-size: 14px;
    color: #6e6c64;
    font-style: italic;
  }
  .footer {
    margin-top: 44px;
    padding-top: 12px;
    border-top: 1px solid #e3decf;
    font-size: 11px;
    color: #a09b8e;
    font-style: italic;
  }
</style>
```

## Section skeletons

Header + topline:

```html
<div class="wrap">
  <div class="header">
    <h1>RS weekly health check — YYYY-MM-DD</h1>
    <div class="sub">Week ending YYYY-MM-DD · Layer 2 summary</div>
  </div>
  <div class="topline">
    <b>This week:</b> N active issues across M companies · K resolved · J opened · H high-alert items
  </div>
```

The week in brief (narrative bullets — what actually changed):

```html
<h2 class="section">The week in brief</h2>
<div class="brief">
  <ul>
    <li>wrong-bedroom pattern spread from 2 to 4 companies this week.</li>
    <li>cross-region-leads resolved at Kelson after 14 runs — clean since 2026-05-10.</li>
    <li>3 new monitoring flags appeared at Briarlane this week, 2 of which are now open.</li>
    <li>Conversation clean rate held at ~96%, flat week-over-week.</li>
  </ul>
</div>
```

Needs attention (one card per item — high-alert, stuck, or spreading):

```html
<h2 class="section">Needs attention</h2>
<div class="attention">
  <span class="tag high-alert">High alert</span>
  <span class="attention-name">
    <a href="https://www.rentsimple.ai/admin/companies/12">Kelson</a> — cross-region-leads
    <span class="chip">streak 14</span>
  </span>
  <span class="attention-desc">AI sending prospects to out-of-region properties. High severity. Watching for resolution — 10 clean runs steps severity down.</span>
</div>
<div class="attention">
  <span class="tag open">Stuck — open, streak 18</span>
  <span class="attention-name">
    <a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a> — stale-availability
    <span class="chip">streak 18</span>
  </span>
  <span class="attention-desc">Still firing after 18 runs with no resolution. May need manual investigation, or dismissal if it's expected behavior.</span>
</div>
```

Resolved this week:

```html
<h2 class="section">Resolved this week</h2>
<ul class="resolved-list">
  <li>
    <span class="tag resolved">Resolved</span>
    <a href="https://www.rentsimple.ai/admin/companies/22">Mosaic</a> — tour-booking-fail
    (was open, streak 9 → resolved after 30 clean runs)
  </li>
</ul>
```

Full active issue list (compact, for reference):

```html
<h2 class="section">All active issues</h2>
<div class="company-section">
  <b><a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a></b>
  <div class="issue-row"><span class="tag open">OPEN</span> wrong-bedroom · streak 7</div>
  <div class="issue-row"><span class="tag open">OPEN</span> stale-availability · streak 18</div>
  <div class="issue-row"><span class="tag monitoring">MONITORING</span> close-loop-fail · streak 2</div>
</div>
<div class="company-section">
  <b><a href="https://www.rentsimple.ai/admin/companies/12">Kelson</a></b>
  <div class="issue-row"><span class="tag high-alert">HIGH ALERT</span> cross-region-leads · streak 14</div>
</div>
```

Quiet week fallback (if nothing notable changed):

```html
<div class="quiet">
  Quiet week. No new high-alert escalations, no significant streak changes, no new spreading patterns. Active issue count is stable.
</div>
```

Footer:

```html
  <div class="footer">Source: .claude/commands/health-check.md · generated YYYY-MM-DDTHH:MM</div>
</div>
```

## Clickable links

Every company name links to admin: `<a href="https://www.rentsimple.ai/admin/companies/{admin_id}">Name</a>` — `admin_id` is on each `v_issues` row (`company_admin_id`). Use `$APP_BASE_URL` if set; default `https://www.rentsimple.ai`.

# Step 4 — Send and close the run

Call `send_email` with `subject` and the HTML body. If it fails, retry once. If still failing, write the full content to stdout.

Then close the run:

```sql
UPDATE runs
SET status = 'succeeded', finished_at = now(),
    summary = 'Weekly: N active across M companies; K resolved, J opened.'
WHERE id = <run_id>;
```

# Hard rules

- **No conversation reading, no prod DB.** This skill reads the watch-state DB via `state_query`.
- This skill **does not modify `issues` or `clusters`** — it only reads them, and writes its own `runs` row. Issue/cluster lifecycle belongs to conversation-watch and daily-pulse.
- No PII in email.
- No emojis.
- No code anchors or file:line citations — this is an operational summary, not an engineering audit.
- The "week in brief" must describe real changes this week. Never pad with static descriptions of long-running issues.
- If nothing changed, say so in one sentence. Don't fabricate trend narrative.

# Chat report-back

Very short. One line each:

- Sent to: recipient(s)
- Active issues this week: N across M companies
- Resolved this week: K
- High-alert items: list each `kind` + company, or "none"
- Biggest change this week: one sentence

Nothing else.
