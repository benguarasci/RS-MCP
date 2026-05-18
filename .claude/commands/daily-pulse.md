---
description: Daily issue-cluster tracker. Reads per-customer issues from conversation-watch (Layer 0) in the watch-state DB, groups them into clusters (where one fix would close all issues in the cluster), persists those clusters to the watch-state DB with snapshot history, and emails a status view that shows every active cluster with its history baked in (new today, growing, shrinking, steady, resolved). Never reads conversations directly.
argument-hint: optional comma-separated email recipients (else uses $HEALTH_CHECK_RECIPIENTS or asks)
---

You're the daily issue-tracker. conversation-watch (Layer 0) flags per-customer issues into the `issues` table of the watch-state Postgres DB. Your job each run: read those issues, group them into clusters where **one fix would close all issues in the cluster**, update the `clusters` table (and write a `cluster_snapshots` row per cluster so history accumulates across runs), and email a status view of every active cluster — current state, with each entry annotated by what's happened to it over time.

This is a status view with memory, not a diff. Every active cluster appears in the brief. Each cluster line carries its own history inline so the reader can scan and see what's new, what's growing, what's shrinking, what's steady, and what's been resolved since the last run.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, reads every prospect conversation, writes per-customer issues to the watch-state DB.
- **daily-pulse** (this one) — runs daily, reads conversation-watch's `issues`, groups them into `clusters`, writes a `cluster_snapshots` history row per cluster, emails a status view with history.
- **health-check** (Layer 2) — runs weekly, reads the same cluster history plus the underlying issues, writes a longer-form trend email.
- **customer-watch** — a separate, manually-curated watch over named at-risk customers. Still Notion-based; don't touch it.

# Required MCP tools

- **`state_query`** — read/write SQL against the watch-state Postgres DB (`issues`, `clusters`, `cluster_snapshots`, `runs`).
- **`send_email`** — sends the daily brief.

If `state_query` is missing, stop — there's no input or persistence without it. If `send_email` is missing, write the report to stdout — but still do the `state_query` writeback.

This skill **never reads conversations** and never touches the prod DB. The watch-state DB is the sole input and the sole place state is kept.

# Configuration

- **Email recipients**: `$ARGUMENTS` if provided, else env var `$HEALTH_CHECK_RECIPIENTS`, else ask once.
- **Scope**: every issue with `status` in `open` or `monitoring`. Issues that are `resolved` or `dismissed` are excluded from clustering, though issues resolved within the last 7 days are still useful for the "Resolved" tail.

# Step 0 — Open the run

```sql
INSERT INTO runs (layer, status) VALUES ('daily-pulse', 'running') RETURNING id;
```

Keep that `run_id` for the snapshot rows and the close in Step 5.

# Step 1 — Read the state

All reads go through `state_query`.

## 1a. Active issues

```sql
SELECT * FROM v_issues
WHERE status IN ('open','monitoring')
   OR (status = 'resolved' AND resolved_at > now() - interval '7 days')
ORDER BY company, kind;
```

The `open`/`monitoring` rows are the active issues to cluster this run. The recently-`resolved` rows feed the "Resolved" tail and the aging-out logic.

## 1b. Existing clusters

```sql
SELECT * FROM v_clusters;
```

`v_clusters` gives each cluster with its live `issue_count`, `company_count`, and `companies` list (active issues only). Read `resolved` clusters too — a regression flips one back to active.

## 1c. Cluster history

For each existing cluster, read its recent snapshots — this is what powers the email's history annotation:

```sql
SELECT cluster_id, captured_at, status, severity, streak, company_count, issue_count, companies, note
FROM cluster_snapshots
WHERE captured_at > now() - interval '14 days'
ORDER BY cluster_id, captured_at DESC;
```

## 1d. Hard precondition

If any read fails, stop. Do not do a partial writeback — surface the failure in the chat report-back.

## 1e. Read the conversation-health ledger

conversation-watch logs every execution to `runs` with a `stats` jsonb. Pull the last 7 days:

```sql
SELECT started_at, stats
FROM runs
WHERE layer = 'conversation-watch' AND status = 'succeeded'
  AND started_at > now() - interval '7 days'
ORDER BY started_at DESC;
```

Each row's `stats` carries `processed` and `flagged` integers. If there are no rows (conversation-watch hasn't run, or `stats` is empty), skip the health score — Step 4 renders the no-data fallback. Do not stop the run; the cluster brief still goes out.

Otherwise, bucket the runs into 7 rolling 24-hour windows ending at now:

- Window 0 = `[now − 24h, now]`
- Window 1 = `[now − 48h, now − 24h]`
- ... through Window 6 = `[now − 168h, now − 144h]`

For each window, sum `processed` and `flagged` across every run whose `started_at` falls inside it. A window with no runs is a data gap — keep it null, do not treat it as zero.

Compute:

- **today's clean rate** — from Window 0: `clean_pct = round(100 × (processed − flagged) / processed)`. If Window 0's `processed` is 0 or the window is a gap, there is no score this run — render the no-data fallback.
- **yesterday's clean rate** — same formula on Window 1. If Window 1 is a gap or 0, omit the "yesterday" comparison.
- **flag rate per window** — for each of the 7 windows, `flag_rate = flagged / processed` (a fraction; null if the window is a gap or `processed` is 0). Used for the sparkline.

Hold these numbers for Step 4.

# Step 2 — Map issues to clusters

A **cluster** is a set of issues where, if you fixed the underlying cause, all the issues in the set would stop firing. That is the only test for what belongs in a cluster.

Examples (illustrative, not prescriptive):

- Briarlane `stale-slot-quoting` + Kelson `tour-times-then-rented-contradiction` + Prospero `stale-availability-contradiction` — all stem from the AI quoting/booking inventory that's already filled. One inventory-sync fix would close all of them. Same cluster.
- Itziar `garbled-company-name-greeting` + Woodsmere `company-name-mispronounced` — voice TTS isn't handling the customer's name correctly. One TTS-pronunciation fix closes both. Same cluster.
- Briarlane `no-response-literal-leaked` + Sanpra `agent-off-hours-no-response` — both involve the AI going silent, BUT the fixes are unrelated (one is a prompt-leak bug, one is an off-hours config bug). **Different clusters.** Do not merge just because the issues look similar — merge only when the same fix closes them.

## 2a. Match against existing clusters first

For each active issue, decide if it already belongs to a known cluster:

1. **Already assigned** — if the issue row's `cluster_id` is already set, that's its home unless aging-out or re-clustering moves it. Deterministic.
2. **Semantic match** — if `cluster_id` is null, read each cluster's `description` / `fix_rationale` and check whether the issue is plausibly fixed by the same change. If yes, assign it. Be conservative: when in doubt, leave the issue unclustered for one run rather than forcing a merge.

## 2b. Form new clusters from unmatched issues

After matching, group the leftover issues among themselves using the same "one fix closes all" test:

- If two unclustered issues share a plausible fix → new cluster
- If an issue doesn't fit with any other → leave as a singleton (a 1-customer cluster)

When you create a new cluster, give it a short stable `slug` (kebab-case, descriptive of the underlying mechanism). Once a cluster has a slug it keeps it — but note the cluster's surrogate `id` is the real continuity key, so even a slug rename wouldn't break history.

## 2c. Sanity check: don't over-merge

For each cluster, ask: "If I made one change to the system, would every one of these stop firing?" If you can't honestly answer yes, split the cluster. A signal you've over-merged: the cluster spans both voice and text channels, or both AI-behavior and backend-config bugs. Split.

## 2d. Aggressively minimize — dedupe and consolidate

**Default toward fewer, larger clusters.** Before finalizing:

1. **Issue-overlap merge.** For any two active clusters whose issue sets overlap by 50%+, merge them. Keep the older cluster (lower `id`); reassign the loser's issues to the winner; set the loser's `status = 'resolved'`, `resolved_at = now()`, and write a snapshot note "merged into {winner-slug}". One-way — the loser is never reused.
2. **Singleton absorption.** A singleton cluster (1 issue, 1 customer, streak 1) that plausibly fits an existing active cluster should be absorbed rather than persisted on its own.
3. **Empty clusters.** If a cluster has 0 active issues AND 0 recently-resolved issues, set it `resolved` with snapshot note "orphaned — no active issues."

**Bias toward "this is already a cluster" over "this is a new cluster."** New clusters should be the exception.

# Step 3 — Update cluster state and write back

For each cluster (existing or new), compute:

1. **current issue set** — the active issues mapped to it this run
2. **current customer set** — distinct companies among those issues
3. **status** — see rules below
4. **severity** — `MAX` across member issues (`high` > `medium` > `low`)
5. **streak** — consecutive runs the cluster has been active (had ≥1 issue mapped)
6. **inactive_runs** — consecutive runs with 0 active issues
7. **history annotation** — a short line describing this run vs prior snapshots (Step 1c)

## Status rules

Run in order:

1. **0 active issues AND prior status already `resolved`** → stay `resolved`. Skip the rest.
2. **0 active issues AND prior status active** → `inactive_runs += 1`. Flip to `resolved` only when BOTH hold: `inactive_runs >= 7` (≈7 days, this runs daily) AND the most recent activity was 7+ days ago. Otherwise keep prior status — it's just "quiet this run."
3. **≥1 active issue AND prior status `resolved`** → regression. Flip back to active; `streak = 1`; snapshot note records "regressed after N runs resolved."
4. **≥1 active issue (normal case)** → `status = 'open'` if any member issue is `open`, else `monitoring`. Reset `inactive_runs` to 0.

## Aging out

If a member issue is `dismissed` or `resolved` this run, it's no longer part of the cluster — it won't appear in the active-issue read (Step 1a). Recompute the cluster's issue set from the current active issues only. If that leaves 0 active issues, fall through to the inactive countdown above.

## 3a. Write the clusters

Upsert each cluster by `slug`. `description` and `fix_rationale` are stable — set on insert, never overwritten:

```sql
INSERT INTO clusters (slug, status, severity, streak, inactive_runs,
                      description, fix_rationale, sample_convs, resolved_at)
VALUES ('stale-inventory-sync', 'open', 'high', 3, 0,
        'AI quoting or booking units that have already been filled.',
        'A single inventory-sync fix would close every issue in this cluster.',
        '["12345","12350","12361"]'::jsonb, NULL)
ON CONFLICT (slug) DO UPDATE SET
  status = excluded.status, severity = excluded.severity,
  streak = excluded.streak, inactive_runs = excluded.inactive_runs,
  sample_convs = excluded.sample_convs, resolved_at = excluded.resolved_at;
```

## 3b. Reassign issues to clusters

```sql
UPDATE issues SET cluster_id = (SELECT id FROM clusters WHERE slug = 'stale-inventory-sync')
WHERE id IN (42, 43, 51);
```

For an issue that left every cluster this run: `UPDATE issues SET cluster_id = NULL WHERE id IN (...)`.

## 3c. Write a snapshot per cluster

One `cluster_snapshots` row per cluster per run — this is the canonical history:

```sql
INSERT INTO cluster_snapshots (cluster_id, run_id, status, severity, streak,
                               company_count, issue_count, companies, note)
SELECT id, <run_id>, 'open', 'high', 3, 6, 8,
       '["Briarlane","Kelson","Mosaic","Prospero","Townline"]'::jsonb,
       '+Mosaic this run, streak 3'
FROM clusters WHERE slug = 'stale-inventory-sync';
```

The `note` is the one-line history annotation (see "How to write the history annotation"). The `companies` jsonb is the frozen customer list — next run diffs against it to compute "+X / −Y".

Do not set `updated_at` on any table — the DB trigger maintains it.

# Step 4 — Compose the email

The brief is a status view of every currently-active cluster, plus a short "resolved this week" tail. Each cluster line shows current state and what's been happening to it.

**Pill mapping.** The DB stores `status` + `severity` separately; the email shows the familiar single pill. Map: `severity = high` → **HIGH ALERT** pill; else `status = open` → **OPEN**; else `status = monitoring` → **MONITORING**; `status = resolved` → **RESOLVED**.

## Subject

`RS daily pulse — {N} active clusters — YYYY-MM-DD`

Examples:

- `RS daily pulse — 6 active clusters — 2026-05-14`
- `RS daily pulse — quiet — 2026-05-14`

## Body structure

1. **Health score** — the conversation-health block, rendered above the topline. Shows today's clean rate as a large percentage, a detail line, and a 7-day sparkline. See "How to render the health block" below. If there is no ledger data (Step 1e), render the no-data fallback instead.
2. **Topline** — total active clusters, total active issues, total customers affected, any HIGH ALERT items called out
3. **Active clusters** — every cluster whose pill is `MONITORING`, `OPEN`, or `HIGH ALERT`. Each one shows: name, current customer count, current issue count, status pill, history annotation (NEW / +X / -Y / steady / growing / shrinking), one-sentence description, list of currently-affected customers.
4. **Resolved since last run** — any cluster that flipped to `resolved` this run. One line each. Disappears after one appearance.
5. **Footer** — generation time, source

## How to render the health block

The health block sits between the header and the topline. It answers, at a glance: what fraction of conversations went cleanly today?

**Score and color.** The big number is `clean_pct` from Step 1e, formatted `NN%`. Choose the `.score` color class:

- `clean_pct >= 97` → no class (green, the default `.score` color)
- `93 <= clean_pct < 97` → add class `warn`
- `clean_pct < 93` → add class `bad`

If there is at least one active HIGH ALERT cluster this run, never render green — use at minimum the `warn` class regardless of `clean_pct`. A high clean rate must not mask a serious cluster.

**Detail line.** One line, format:

`<flagged> of <processed> conversation checks flagged · <cluster posture> · yesterday <NN>%`

- Use `processed` and `flagged` from Window 0. The wording is "conversation checks", not "conversations" — a conversation updated twice in a day is checked by conversation-watch twice, so these are checks, not distinct threads. Do not change this wording.
- `<cluster posture>` — if any HIGH ALERT cluster exists: `N HIGH ALERT cluster(s)`; else if any OPEN: `N OPEN cluster(s)`; else `clusters steady`.
- Omit the `· yesterday NN%` segment if Window 1 had no data (Step 1e).

**Sparkline.** A 7-character run of Unicode block characters showing the flag-rate trend, oldest on the left, newest (Window 0) on the right. Block alphabet, index 0–7: `▁▂▃▄▅▆▇█`.

Algorithm:
1. Take the 7 `flag_rate` values from Step 1e, ordered Window 6 → Window 0 (oldest to newest).
2. From the non-null values, find `lo` (min) and `hi` (max).
3. For each window:
   - null (data gap) → render `·` (middle dot)
   - `hi == lo` (all equal) → render `▄`
   - otherwise → `idx = round(7 × (flag_rate − lo) / (hi − lo))`, render block alphabet `[idx]`
4. Concatenate the 7 characters. Taller block = higher flag rate = worse. The sparkline is relative (normalized to its own 7-day min/max) — the absolute number lives in the score, not here.

**No-data fallback.** If Step 1e produced no score (no ledger, or Window 0 empty/zero `processed`), render the fallback block instead of the full block — see the skeleton below.

## Ordering

Within Active clusters, sort by:

1. Pill (HIGH ALERT, then OPEN, then MONITORING)
2. Within that, NEW-today clusters first, then clusters that changed this run (grew or shrank), then steady clusters

No numeric prominence score. Just severity + recency-of-change.

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
  .health {
    background: #fbfaf4;
    border: 1px solid #e3decf;
    border-left: 3px solid #cc785c;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  .health .score {
    font-family: Georgia, serif;
    font-size: 34px;
    font-weight: 500;
    color: #3d5c2b;
    line-height: 1;
    vertical-align: middle;
  }
  .health .score.warn { color: #8a4a30; }
  .health .score.bad  { color: #8c3527; }
  .health .score-label {
    font-size: 14px;
    color: #3d3b35;
    margin-left: 8px;
    vertical-align: middle;
  }
  .health .health-detail {
    font-size: 12px;
    color: #6e6c64;
    margin-top: 6px;
  }
  .health .spark {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 16px;
    letter-spacing: 2px;
    color: #8a4a30;
    margin-top: 8px;
  }
  .health .spark-cap {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11px;
    letter-spacing: 0;
    color: #a09b8e;
    font-style: italic;
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
  .meta {
    font-size: 12px;
    color: #6e6c64;
    margin: 0 0 8px;
  }
  .meta .change {
    color: #8a4a30;
    font-style: italic;
  }
  .meta .change.new {
    color: #8c3527;
    font-weight: 600;
  }
  .meta .change.growing {
    color: #8c3527;
  }
  .meta .change.shrinking {
    color: #3d5c2b;
  }
  .meta .change.steady {
    color: #6e6c64;
  }
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
  .desc {
    font-size: 14px;
    color: #3d3b35;
    margin: 4px 0 8px;
  }
  .customers {
    font-size: 13px;
    color: #3d3b35;
  }
  .resolved-list {
    margin: 6px 0 0;
    padding-left: 20px;
    font-size: 13px;
    color: #3d3b35;
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

Header + health + topline:

```html
<div class="wrap">
  <div class="header">
    <h1>RS daily pulse — YYYY-MM-DD</h1>
    <div class="sub">Active issue clusters across all customers · status with history</div>
  </div>
  <div class="health">
    <span class="score">96%</span>
    <span class="score-label">conversations clean today</span>
    <div class="health-detail">77 of 1,847 conversation checks flagged · 1 HIGH ALERT cluster · yesterday 94%</div>
    <div class="spark">▂▃▅▂▄▆▇ <span class="spark-cap">flag rate · last 7 days · newest right · relative scale</span></div>
  </div>
  <div class="topline">
    <b>Active:</b> N clusters · M issues across K customers · H HIGH ALERT
  </div>
```

Health block — no-data fallback (use when Step 1e produced no score):

```html
<div class="health">
  <div class="health-detail">Conversation-health score unavailable — no conversation-watch runs in the last 24h.</div>
</div>
```

Cluster card (one per active cluster):

```html
<h2 class="section">Active clusters</h2>

<div class="cluster">
  <span class="cluster-name">stale-inventory-sync</span>
  <p class="meta">
    <span class="status-pill open">OPEN</span>
    6 customers · 8 issues ·
    <span class="change steady">steady 3 runs</span>
  </p>
  <p class="desc">AI quoting or booking units that have already been filled. One inventory-sync fix would close all issues in this cluster.</p>
  <p class="customers">
    <a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a>,
    <a href="https://www.rentsimple.ai/admin/companies/12">Kelson</a>,
    <a href="https://www.rentsimple.ai/admin/companies/22">Mosaic</a>,
    <a href="https://www.rentsimple.ai/admin/companies/27">Prospero (×3)</a>,
    <a href="https://www.rentsimple.ai/admin/companies/57">Townline</a>
  </p>
</div>

<div class="cluster">
  <span class="cluster-name">off-hours-misconfig</span>
  <p class="meta">
    <span class="status-pill high-alert">HIGH ALERT</span>
    1 customer · 1 issue ·
    <span class="change new">NEW today</span>
  </p>
  <p class="desc">Off-hours response suppression is firing during normal business hours. Single fix to the off-hours rule closes the issue.</p>
  <p class="customers">
    <a href="https://www.rentsimple.ai/admin/companies/4">Sanpra</a> (8 conversations affected today)
  </p>
</div>

<div class="cluster">
  <span class="cluster-name">wrong-unit-specs</span>
  <p class="meta">
    <span class="status-pill monitoring">MONITORING</span>
    3 customers · 4 issues ·
    <span class="change shrinking">down from 5 customers on 2026-05-12</span>
  </p>
  <p class="desc">AI confirming the wrong bedroom or bath count. Likely a prompt/template fix.</p>
  <p class="customers">
    <a href="https://www.rentsimple.ai/admin/companies/76">Briarlane</a>,
    <a href="https://www.rentsimple.ai/admin/companies/22">Mosaic</a>,
    <a href="https://www.rentsimple.ai/admin/companies/57">Townline</a>
  </p>
</div>
```

Resolved since last run (only if any flipped this run):

```html
<h2 class="section">Resolved since last run</h2>
<ul class="resolved-list">
  <li>
    <span class="status-pill resolved">Resolved</span>
    <b>duplicate-replies</b> — last seen at Mosaic and Prospero 56; 0 active issues across 7 quiet runs.
  </li>
</ul>
```

Quiet day fallback:

```html
<div class="quiet">
  No active clusters. Nothing fired in any customer's conversations since the last run.
</div>
```

Footer:

```html
  <div class="footer">Source: .claude/commands/daily-pulse.md · generated YYYY-MM-DDTHH:MM UTC</div>
</div>
```

## How to write the history annotation

The little italic line after the status pill is the key piece — it carries the history. Compute it by diffing the current customer set against the most recent `cluster_snapshots` rows (Step 1c). Each cluster gets one descriptor:

- **NEW today** — first run the cluster has appeared. Red, attention-grabbing.
- **+X customer(s)** — cluster grew this run. Name the customer(s) if 1-2, else just count.
- **−X customer(s)** — cluster shrank this run.
- **growing N runs** — gained customers across the last N consecutive runs.
- **shrinking N runs** — lost customers across the last N consecutive runs.
- **steady N runs** — same customer set across the last N consecutive runs.
- **regressed** — was resolved, now active again.
- **down from X customers on YYYY-MM-DD** — useful when the cluster peaked higher recently.

Pick the single most informative descriptor for that cluster's recent trajectory. Write the same line into the snapshot's `note` (Step 3c).

## Customer links

Customer names link to admin: `<a href="https://www.rentsimple.ai/admin/companies/{admin_id}">Name</a>`. The `admin_id` is on each issue row from `v_issues` (`company_admin_id`). Use `$APP_BASE_URL` if set; default `https://www.rentsimple.ai`.

# Step 5 — Send and close the run

Call `send_email` with `subject` and the HTML body. If the call fails, retry once. If still failing, write full HTML to stdout.

Then close the run regardless of email outcome:

```sql
UPDATE runs
SET status = 'succeeded', finished_at = now(),
    summary = 'Run 8 — 12 active clusters across 9 customers; +1 new, 1 resolved.',
    stats = '{"active_clusters":12,"customers":9,"new":1,"resolved":1}'::jsonb
WHERE id = <run_id>;
```

The `state_query` writeback in Step 3 must happen regardless of email — state persistence is more important than email delivery.

# Hard rules

- **No conversation reading, no prod DB.** This skill reads and writes only the watch-state DB via `state_query`.
- **No PII** in the email body. Customer names and conversation IDs are fine; prospect names, emails, phone numbers are not.
- **No emojis.**
- **No code anchors** or file:line citations — health-check handles that.
- **Don't merge clusters just because their issues look related.** The merge test is "one fix closes all," not "same area."
- **`description` / `fix_rationale` are stable** — set once on cluster creation, never overwritten.
- **This skill never writes `issues.status`, `issues.severity`, or any issue field except `cluster_id`.** Issue lifecycle belongs to conversation-watch. daily-pulse only assigns issues to clusters.
- **`status` writes must be exactly `open`, `monitoring`, or `resolved`; `severity` exactly `low`, `medium`, `high`.** The DB domains reject anything else.
- **Every resolve requires a rationale** in the cluster's final `cluster_snapshots.note` — trigger rule, last-active date, runs inactive, customer count at last activity. If you can't construct one (e.g. inactive <7 days), do NOT resolve — keep prior status.

# Chat report-back

Short. One line each:

- Sent to: recipient(s)
- Active clusters: N (with counts by pill — e.g. "1 HIGH ALERT, 2 OPEN, 3 MONITORING")
- Customers with active issues: K
- New clusters this run: list of slugs (or "none")
- Clusters resolved this run: list of slugs (or "none") — call out "merged into X" vs "all issues cleared" vs "orphaned" vs "inactive 7 runs"
- Merges done: list of "X → Y" (or "none") — the dedupe signal; over time you want this to trend toward zero
- Singletons absorbed: count (or "none")
- Anything weird: state_query write failures, domain rejections, mapping ambiguity, etc.
