---
description: Weekly trend report across all customers. Reads the two Notion records — conversation-watch's symptom record and daily-pulse's cluster record — identifies accumulating patterns, tracks regression/resolution, and emails an exec summary. Never reads conversations or DB directly — Notion is the input. The top-layer view.
argument-hint: optional comma-separated email recipients (else uses $HEALTH_CHECK_RECIPIENTS or asks)
---

You're the weekly strategist. Your input is two Notion records: `cw-state` (every symptom conversation-watch has flagged) and `cl-state` (every cluster daily-pulse maintains, with its history). Your job: zoom out over the past week, find what's getting worse vs better, surface what needs a decision, and send one clean exec summary email. You don't read conversations. You don't query Postgres. Notion is your source of truth.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, writes per-customer flags to Notion.
- **daily-pulse** (Layer 1) — runs daily, clusters flags across customers, emails a brief.
- **health-check** (this one, Layer 2) — runs weekly, reads all of it, identifies trends over time, emails exec summary.
- **customer-watch** — manually-curated focused-attention tool for named at-risk customers. Separate from this system.

# Required MCP tools

- Notion MCP `notion-query-database-view` (primary lookup), `notion-fetch` (body reads)
- RS-DB MCP `send_email` — delivery

If Notion is missing, stop — there's no input. If email is missing, write to stdout.

This skill **never touches Postgres**. No conversation reading, no DB queries.

# Configuration

- **Email recipients**: `$ARGUMENTS` if provided, else env var `$HEALTH_CHECK_RECIPIENTS`, else ask once.
- **Window**: the last 7 days. Use the dated entries inside each record (issue "Last sighted" / cluster "History") to tell what was active this week vs prior weeks.

# Step 1 — Read the two records

## 1a. Locate the records

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the `system-watch-lookup` view. Find two rows by exact Name and note their page_ids:

- `cw-state` — conversation-watch's symptom record
- `cl-state` — daily-pulse's cluster record

If either is missing, note it in report-back and continue with whatever exists. If both are missing, stop — there's nothing to summarize.

Ignore every other row. `cs-*` belongs to customer-watch. Obsolete `cw-{company}-{issue}` rows from an old design are not input — if you see a pile of them, note it so the operator can clean up.

## 1b. Read both record bodies

`notion-fetch` each record. Parse:

**From `cw-state`:** the header (run count, last run) and every issue under `## Active issues` and `## Resolved issues` — each with Status, Streak, Customer, Last sighted, Detection signal, Issue description, Notes.

**From `cl-state`:** the header and every cluster under `## Clusters` and `## Resolved clusters` — each with Status, Streak, Customers, Symptoms list, description, and the dated **History** entries. The History is the spine of the trend story — it's where you see a cluster grow, shrink, or hold steady across the week.

## 1c. Build the weekly picture

From the parsed records, group:

- **Active clusters** — `cl-state` clusters with Status MONITORING, OPEN, or HIGH ALERT
- **Resolved this week** — clusters or issues that moved to RESOLVED with a dated entry in the last 7 days
- **Long-running** — clusters with Streak >= 10 (active many consecutive runs)
- **Escalating** — clusters whose History shows customer count rising across the week
- **Cooling** — clusters whose History shows customer count falling across the week
- **Active symptoms** — `cw-state` active issues, used to size each cluster and spot brand-new patterns

The cluster History entries already encode most of the trend — lean on them rather than re-deriving from scratch.

# Step 2 — Identify weekly trends

Look across the rows for the story of the week. Ask:

**What got worse?**
- Issues that moved from MONITORING → OPEN this week
- OPEN issues whose Streak increased significantly
- New MONITORING flags that didn't exist last week
- Any issue that moved to HIGH ALERT

**What got better?**
- Issues that moved to RESOLVED this week
- OPEN issues with declining Streak (were hot, now cooling)
- Customers who had multiple active issues and are now clean

**What's stuck?**
- OPEN issues with Streak >= 15 — still firing after many runs with no resolution
- HIGH ALERT issues that haven't moved
- Same issue slug appearing at more companies over time (spreading pattern)

**What's the biggest risk right now?**
- Cluster of same issue across 3+ companies
- Any HIGH ALERT item
- Customer with 3+ active issues simultaneously

# Step 3 — Compose the email

Clean HTML. Exec-readable in under 2 minutes. Not a firehose — this is the weekly review, not a daily flag dump.

## Subject

`RS weekly health check — YYYY-MM-DD — {one-line headline}`

Examples:
- `RS weekly health check — 2026-05-14 — 2 issues resolved, 1 new pattern spreading`
- `RS weekly health check — 2026-05-14 — quiet week, nothing urgent`

## Email structure

1. **Topline numbers** — active issues total, companies affected, issues resolved this week, issues opened this week
2. **The week in brief** — 3-5 bullet narrative of what actually changed. Concrete, past-tense. Not a status dump.
3. **Needs attention** — issues that require a decision or action: HIGH ALERT items, stuck long-runners, spreading patterns
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
    <b>This week:</b> N active issues across M companies · K resolved · J opened · H HIGH ALERT items
  </div>
```

The week in brief (narrative bullets — what actually changed):

```html
<h2 class="section">The week in brief</h2>
<div class="brief">
  <ul>
    <li>wrong-bedroom pattern spread from 2 to 4 companies — now BROAD tier.</li>
    <li>cross-region-leads resolved at Kelson after 14 runs — clean since 2026-05-10.</li>
    <li>3 new MONITORING flags appeared at Briarlane this week, 2 of which are now OPEN.</li>
    <li>Quiet week for Mosaic and Prospero — no new flags, existing OPEN issues holding steady.</li>
  </ul>
</div>
```

Needs attention (one card per item — HIGH ALERT, stuck, or spreading):

```html
<h2 class="section">Needs attention</h2>
<div class="attention">
  <span class="tag high-alert">High alert</span>
  <span class="attention-name">
    <a href="https://www.rentsimple.ai/admin/companies/12">Kelson</a> — cross-region-leads
    <span class="chip">streak 14</span>
  </span>
  <span class="attention-desc">AI sending prospects to out-of-region properties. Escalated manually. Watching for resolution — 10 clean runs needed to step down to OPEN.</span>
</div>
<div class="attention">
  <span class="tag open">Stuck — open 18 runs</span>
  <span class="attention-name">
    <a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a> — stale-availability
    <span class="chip">streak 18</span>
  </span>
  <span class="attention-desc">Still firing after 18 runs with no resolution. May need manual investigation or NON ISSUE if expected behavior.</span>
</div>
```

Resolved this week:

```html
<h2 class="section">Resolved this week</h2>
<ul class="resolved-list">
  <li>
    <span class="tag resolved">Resolved</span>
    <a href="https://www.rentsimple.ai/admin/companies/22">Mosaic</a> — tour-booking-fail
    (OPEN, streak 9 → resolved after 30 clean runs)
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
  Quiet week. No new HIGH ALERT escalations, no significant streak changes, no new spreading patterns. Active issue count is stable.
</div>
```

Footer:

```html
  <div class="footer">Source: .claude/commands/health-check.md · generated YYYY-MM-DDTHH:MM</div>
</div>
```

## Clickable links

Every company name links to admin: `<a href="https://www.rentsimple.ai/admin/companies/{id}">Name</a>`

Use `$APP_BASE_URL` if set; default `https://www.rentsimple.ai`.

# Step 4 — Send

Call RS-DB MCP `send_email`. Pass `to`, `subject`, HTML body. If it fails, retry once. If still fails, write the full content to stdout and stop.

# Hard rules

- **No Postgres queries.** This skill reads Notion only.
- **No conversation reading.** That's Layer 0's job.
- No PII in email.
- No emojis.
- No Notion writes. This skill is read-only on Notion.
- No code anchors or file:line citations — this is an operational summary, not an engineering audit.
- The "week in brief" must describe real changes this week. Never pad with static descriptions of long-running issues.
- If nothing changed, say so in one sentence. Don't fabricate trend narrative.

# Chat report-back

Very short. One line each:

- Sent to: recipient(s)
- Active issues this week: N across M companies
- Resolved this week: K
- HIGH ALERT items: list each slug + company, or "none"
- Biggest change this week: one sentence

Nothing else.
