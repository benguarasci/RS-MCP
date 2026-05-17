---
description: Daily issue-cluster tracker. Reads the conversation-watch record of per-customer symptoms, groups them into clusters (where one fix would close all symptoms in the cluster), maintains one Notion record of those clusters with history, and emails a status view showing every active cluster annotated by what's happened to it over time (new, growing, shrinking, steady, resolved). Never reads conversations directly.
argument-hint: optional comma-separated email recipients (else uses $HEALTH_CHECK_RECIPIENTS or asks)
---

You're the daily issue-tracker. conversation-watch (Layer 0) keeps one Notion record of per-customer symptom flags. Your job each run: read that record, group the symptoms into clusters where **one fix would close all symptoms in the cluster**, maintain your own one Notion record of those clusters (so they accumulate history), and email a status view of every active cluster — current state, each annotated by its history.

This is a status view with memory, not a diff. Every active cluster appears in the brief, each line carrying its own history so the reader can scan and see what's new, growing, shrinking, steady, or resolved.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, maintains the `cw-state` record of per-customer symptoms.
- **daily-pulse** (this one) — runs daily, reads `cw-state`, maintains the `cl-state` record of clusters, emails a status view.
- **health-check** (Layer 2) — weekly, reads both records, emails a longer trend summary.
- **customer-watch** — separate, manually-curated watch over named at-risk customers (`cs-` rows). Untouched by this skill.

# The one-record model

Two records are involved, both single Notion pages:

- **`cw-state`** — conversation-watch's record. You **read** it. Never write it.
- **`cl-state`** — this skill's record. You **read and rewrite** it. All cluster tracking lives in its body as structured Markdown.

One fetch of each, one rewrite of `cl-state`. No row-per-cluster, no round-trip storm.

# Required MCP tools

- Notion MCP — `notion-query-database-view` (locate the two records), `notion-fetch` (read their bodies), `notion-update-page` (rewrite `cl-state`), `notion-create-pages` (first run only)
- RS-DB MCP — `send_email`

If Notion is missing, stop. If email is missing, write the report to stdout — but still do the `cl-state` writeback.

This skill **never touches Postgres**. No conversation reading. Notion is the sole input and the sole place state is kept.

# Configuration

- **Email recipients**: `$ARGUMENTS` if provided, else env var `$HEALTH_CHECK_RECIPIENTS`, else ask once.

# Step 1 — Read the two records

## 1a. Locate both records

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the `system-watch-lookup` view. Find two rows by exact Name:

- `cw-state` — conversation-watch's record. Note its page_id.
- `cl-state` — this skill's record. Note its page_id (may not exist yet — first run).

If `cw-state` doesn't exist, stop: there's no input. Report it.

Ignore every other row — `cs-*` belongs to customer-watch; obsolete `cw-{company}-{issue}` rows from an old design are not input.

## 1b. Read `cw-state`

`notion-fetch` the `cw-state` page. Parse its body. You want the **Active issues** section — every `### cw-{company}-{issue}` entry with its Status, Customer, Sample convs, Detection signal, Issue description. These are the symptoms you cluster. Ignore the Resolved section except to note a symptom that just resolved (it should leave its cluster).

## 1c. Read `cl-state`

If `cl-state` exists, `notion-fetch` it and parse the **Clusters** section — every `### cl-{cluster-slug}` entry with its Status, Streak, Customers, Symptoms list, Description, and History.

If `cl-state` doesn't exist, this is the first run — there are no prior clusters. You'll create the record in Step 3.

# Step 2 — Map symptoms to clusters

A **cluster** is a set of symptoms where, if you fixed the underlying cause, all of them would stop firing. That is the only test for what belongs together.

Examples (illustrative):

- `cw-briarlane-stale-slot-quoting` + `cw-kelson-tour-times-then-rented-contradiction` — both stem from the AI quoting inventory already filled. One inventory-sync fix closes both. Same cluster.
- `cw-itziar-garbled-company-name-greeting` + `cw-woodsmere-company-name-mispronounced` — voice TTS mishandling customer names. One fix. Same cluster.
- `cw-briarlane-no-response-literal-leaked` + `cw-sanpra-agent-off-hours-no-response` — both look like "AI went silent" but the fixes are unrelated (prompt-leak bug vs off-hours config). **Different clusters.** Merge only when the same fix closes them.

## 2a. Match against existing clusters first

For each active symptom, decide if it belongs to a known cluster:

1. **Identifier match** — if the symptom's `cw-...` identifier is already in some cluster's Symptoms list, that's its home.
2. **Semantic match** — if not, check whether the symptom is plausibly closed by the same fix as an existing cluster. If yes, add it. Be conservative — when in doubt, don't force a match.

## 2b. Form new clusters from unmatched symptoms

Group the leftover symptoms among themselves with the same "one fix closes all" test. A symptom that fits nothing else becomes a singleton (1-customer cluster). Give each new cluster a short stable kebab-case slug — it keeps that slug forever.

## 2c. Don't over-merge

For each cluster ask: "If I made one change, would every symptom here stop firing?" If you can't honestly say yes, split. Red flag for over-merge: the cluster spans voice and text channels, or AI-behavior and backend-config bugs, or prompt and integration issues.

## 2d. Aggressively minimize — dedupe and consolidate

**Default toward fewer, larger clusters.** Every extra cluster is more to read and rewrite each run. Before finalizing:

1. **Overlap merge** — two active clusters with 50%+ symptom overlap merge into one. Keep the older slug; migrate symptoms in; mark the loser `RESOLVED` with History note "merged into cl-{winner}".
2. **Singleton absorption** — a singleton that plausibly fits an existing cluster gets absorbed rather than kept on its own. A singleton that survives 3+ runs alone with no peers — re-check whether it can be absorbed.
3. **Stale cleanup** — a cluster `RESOLVED` for 30+ days gets dropped from the record entirely. Its history is no longer needed.
4. **Orphans** — a cluster with 0 active symptoms goes `RESOLVED` immediately.

**Bias toward "this is already a cluster" over "this is new."** New clusters are the exception.

# Step 3 — Update cluster state and rewrite `cl-state`

For each cluster (existing or new), compute:

1. **Symptom list** — active `cw-...` identifiers that mapped to it this run. Drop any symptom whose `cw-state` Status is now `RESOLVED` or `NON ISSUE` — don't drag dead symptoms along.
2. **Customer list** — customers with at least one active symptom in the cluster.
3. **Status** — run these in order:
   - 0 active symptoms AND prior Status already `RESOLVED` → stay `RESOLVED`.
   - 0 active symptoms AND prior Status active → increment consecutive-inactive count in History. At 3 consecutive inactive runs → `RESOLVED`. Else keep prior Status (quiet this run).
   - >=1 active symptom AND prior Status `RESOLVED` → regression: reactivate, History note "regressed after N runs".
   - >=1 active symptom (normal) → Status = max severity across underlying symptoms (`HIGH ALERT` > `OPEN` > `MONITORING`); reset consecutive-inactive to 0.
4. **Streak** — consecutive runs the cluster has been active (had >=1 symptom). New cluster = 1. Active again = +1. Resolved = reset to 0.
5. **History annotation** — a one-line descriptor of this run vs prior runs (see "History annotation" below), derived from the cluster's prior History entries.

## 3a. Rewrite the record

Build the full new `cl-state` body and write it in **one** `notion-update-page` call with `command: replace_content`. If `cl-state` didn't exist, `notion-create-pages` it instead, with parent `{"type": "data_source_id", "data_source_id": "35f9fe3f-af42-80ba-bf81-000b602adf12"}`.

## Record body template

```markdown
# daily-pulse cluster state

- **Last run:** {now, exact UTC ISO to the second}
- **Run count:** {prior + 1}
- **Last run summary:** {N} active clusters; {new} new, {merged} merged, {resolved} resolved.

## Clusters

### cl-{cluster-slug}
- **Status:** OPEN
- **Streak:** 3
- **Customers:** Briarlane, Kelson, Mosaic, Townline
- **Symptoms:** cw-briarlane-stale-slot-quoting, cw-kelson-tour-times-then-rented-contradiction, ...
- **What it is:** {one sentence — the underlying mechanism}
- **One fix that would close it:** {one sentence — what the shared fix addresses}
- **History:**
  - 2026-05-15: 4 customers, +Mosaic, streak 3
  - 2026-05-14: 3 customers, steady, streak 2
  - 2026-05-13: 3 customers, NEW, streak 1

### cl-{next-cluster}
...

## Resolved clusters

_Kept for regression detection. Dropped after 30 days resolved._

### cl-{cluster-slug}
- **Status:** RESOLVED
- **Resolved on:** {ISO datetime}
- **What it is:** {one sentence}
- **History:** {final note — "all symptoms cleared" / "merged into cl-X" / "orphaned" / "inactive 3 runs"}
```

Cap each cluster's History at the most recent 7 entries.

## Record properties

On the `cl-state` row:

- **Name** (title): `cl-state`
- **Issue Type** (select): `System`
- **Status** (select): `OPEN` (schema placeholder)
- **Run date** (datetime): exact UTC writeback time, to the second. Never round.
- **Companies count** (number): total customers with at least one active symptom
- **Notes** (text): the one-line run summary

# Step 4 — Compose the email

A status view of every active cluster, plus a short "resolved since last run" tail.

## Subject

`RS daily pulse — {N} active clusters — YYYY-MM-DD`  (or `RS daily pulse — quiet — YYYY-MM-DD`)

## Body structure

1. **Topline** — active cluster count, total symptoms, total customers affected, HIGH ALERT count
2. **Active clusters** — every `MONITORING` / `OPEN` / `HIGH ALERT` cluster. Each: name, customer count, symptom count, status pill, history annotation, one-sentence description, affected-customer list.
3. **Resolved since last run** — clusters that flipped `RESOLVED` this run. One line each. Shown once, then gone.
4. **Footer** — generation time, source.

## Ordering

Within Active clusters: by Status (`HIGH ALERT`, then `OPEN`, then `MONITORING`); within Status, NEW-today first, then changed-this-run, then steady. No numeric score.

## History annotation

The italic descriptor after the status pill carries the history. Pick the one most informative for that cluster:

- **NEW today** — first run the cluster appeared
- **+X customer(s)** / **−X customer(s)** — grew or shrank this run
- **growing N runs** / **shrinking N runs** — sustained trend
- **steady N runs** — same customer set N runs running
- **regressed** — was RESOLVED, now active again
- **down from X customers on YYYY-MM-DD** — when the cluster peaked higher recently

One descriptor per cluster.

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
  .wrap { max-width: 620px; margin: 0 auto; }
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
  .header .sub { color: #827e76; font-size: 12px; }
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
  .cluster {
    background: #fbfaf4;
    border: 1px solid #e3decf;
    border-radius: 10px;
    padding: 16px 18px;
    margin: 14px 0;
  }
  .cluster-name {
    display: block;
    font-family: Georgia, serif;
    font-size: 16px;
    font-weight: 500;
    color: #1f1e1c;
    line-height: 1.35;
    margin-bottom: 4px;
  }
  .meta { font-size: 12px; color: #6e6c64; margin: 0 0 8px; }
  .meta .change { font-style: italic; }
  .meta .change.new { color: #8c3527; font-weight: 600; }
  .meta .change.growing { color: #8c3527; }
  .meta .change.shrinking { color: #3d5c2b; }
  .meta .change.steady { color: #6e6c64; }
  .status-pill {
    display: inline-block;
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
    white-space: nowrap;
    margin-right: 6px;
  }
  .status-pill.high-alert { background: #ecc8c0; color: #8c3527; }
  .status-pill.open       { background: #f0d9cc; color: #8a4a30; }
  .status-pill.monitoring { background: #ede8d8; color: #807548; }
  .status-pill.resolved   { background: #dfecd5; color: #3d5c2b; }
  .desc { font-size: 14px; color: #3d3b35; margin: 4px 0 8px; }
  .customers { font-size: 13px; color: #3d3b35; }
  .resolved-list { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: #3d3b35; }
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
    <h1>RS daily pulse — YYYY-MM-DD</h1>
    <div class="sub">Active issue clusters across all customers · status with history</div>
  </div>
  <div class="topline">
    <b>Active:</b> N clusters · M symptoms across K customers · H HIGH ALERT
  </div>
```

Cluster card:

```html
<h2 class="section">Active clusters</h2>
<div class="cluster">
  <span class="cluster-name">stale-inventory-sync</span>
  <p class="meta">
    <span class="status-pill open">OPEN</span>
    4 customers · 6 symptoms ·
    <span class="change steady">steady 3 runs</span>
  </p>
  <p class="desc">AI quoting or booking units already filled. One inventory-sync fix would close every symptom here.</p>
  <p class="customers">
    <a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a>,
    <a href="https://www.rentsimple.ai/admin/companies/12">Kelson</a>,
    <a href="https://www.rentsimple.ai/admin/companies/22">Mosaic</a>,
    <a href="https://www.rentsimple.ai/admin/companies/57">Townline</a>
  </p>
</div>
```

Resolved since last run (only if any):

```html
<h2 class="section">Resolved since last run</h2>
<ul class="resolved-list">
  <li><span class="status-pill resolved">Resolved</span> <b>duplicate-replies</b> — 0 active symptoms across 3 clean runs.</li>
</ul>
```

Quiet day:

```html
<div class="quiet">No active clusters. Nothing fired in any customer's conversations since the last run.</div>
```

Footer:

```html
  <div class="footer">Source: .claude/commands/daily-pulse.md · generated YYYY-MM-DDTHH:MM UTC</div>
</div>
```

## Customer links

Customer names link to admin: `<a href="https://www.rentsimple.ai/admin/companies/{id}">Name</a>`. Use `$APP_BASE_URL` if set; default `https://www.rentsimple.ai`.

# Step 5 — Send

Call RS-DB `send_email` with `to`, `subject`, HTML body. Retry once on failure. If still failing, write the HTML to stdout. The `cl-state` writeback in Step 3 must happen regardless — persistence matters more than delivery.

# Hard rules

- **No Postgres queries.** Notion only.
- **No conversation reading.** That's Layer 0.
- **Two records only.** Read `cw-state`, read+rewrite `cl-state`. Never create per-cluster rows. Never write `cw-state` or any `cs-*` row.
- **No PII** in the email — customer names and conversation IDs only; no prospect names, emails, phone numbers.
- **No emojis.** No code anchors.
- **Cluster slugs are stable forever.** If a cluster's meaning shifts, resolve the old slug and start a new one — don't reuse.
- **Don't merge clusters on shared symptom — merge on shared fix.**
- **Run date is the exact UTC writeback time**, to the second. Never round.

# Chat report-back

Short. One line each:

- Sent to: recipient(s)
- Active clusters: N (counts by status)
- Customers with active symptoms: K
- New clusters this run: slugs (or "none")
- Clusters resolved this run: slugs, with reason each ("merged into cl-X" / "all symptoms cleared" / "orphaned" / "inactive 3 runs")
- Merges done: "cl-X → cl-Y" list (or "none") — should trend toward zero as the set stabilizes
- Anything weird: Notion write failures, mapping ambiguity, missing `cw-state`, etc.
