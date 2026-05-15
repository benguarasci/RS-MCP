---
description: Daily issue-cluster tracker. Reads per-customer symptom flags from conversation-watch (Layer 0), groups them into clusters (where one fix would close all symptoms in the cluster), persists those clusters to Notion with history, and emails a status view that shows every active cluster with its history baked in (new today, growing, shrinking, steady, resolved). Never reads conversations directly.
argument-hint: optional comma-separated email recipients (else uses $HEALTH_CHECK_RECIPIENTS or asks)
---

You're the daily issue-tracker. conversation-watch (Layer 0) flags per-customer symptoms in Notion. Your job each run: read those symptom flags, group them into clusters where **one fix would close all symptoms in the cluster**, update the persistent cluster records in Notion (so they accumulate history across runs), and email a status view of every active cluster — current state, with each entry annotated by what's happened to it over time.

This is a status view with memory, not a diff. Every active cluster appears in the brief. Each cluster line carries its own history inline so the reader can scan and see what's new, what's growing, what's shrinking, what's steady, and what's been resolved since the last run.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, reads every prospect conversation, writes per-customer `cw-` symptom rows to Notion.
- **daily-pulse** (this one) — runs daily, reads the active `cw-` rows, groups them into `cl-` cluster rows in Notion, emails a status view with history.
- **health-check** (Layer 2) — runs weekly, reads the same cluster history plus the underlying symptom rows, writes a longer-form trend email.
- **customer-watch** — a separate, manually-curated watch over named at-risk customers. Lives in the `cs-` namespace. Don't touch its rows.

# Required MCP tools

- Notion MCP — `notion-query-database-view`, `notion-fetch`, `notion-update-page`, `notion-create-pages`
- RS-DB MCP — `send_email`

If Notion is missing, stop. There's no input or persistence without it. If email is missing, write the report to stdout — but still do the Notion writeback.

This skill **never touches Postgres**. No conversation reading, no DB queries. Notion is the sole input and the sole place state is kept.

# Configuration

- **Email recipients**: `$ARGUMENTS` if provided, else env var `$HEALTH_CHECK_RECIPIENTS`, else ask once.
- **Scope**: every `cw-` symptom row with Status in `MONITORING`, `OPEN`, or `HIGH ALERT`. Anything in `NON ISSUE` or `RESOLVED` is excluded from current clustering, though `RESOLVED` rows from the last 7 days are still useful for showing recently-closed work in the brief.

# Step 1 — Read the Notion data

## 1a. Query the system-watch view

Call `notion-query-database-view`:

- `view_url: https://www.notion.so/rentsimple/35f9fe3faf4280c69197f5c4d390650a?v=35f9fe3faf4280328b21000c3d59b65d`

This is the `system-watch-lookup` view, pre-filtered to `Issue Type = System`. It returns both kinds of rows this skill cares about: per-customer symptoms (`cw-*`) and cluster rows (`cl-*`). Iterate pagination until exhausted.

## 1b. Sort rows into two buckets

For each row, decide which bucket it goes in by Name prefix:

- **Symptom rows** — Name starts with `cw-{customer-slug}-{symptom-slug}`. These come from conversation-watch.
- **Cluster rows** — Name starts with `cl-{cluster-slug}`. These come from prior runs of this skill.
- **Skip** anything else:
  - `cs-*` rows belong to customer-watch — not this skill's namespace
  - `cw-heartbeat` is operational state, not a symptom
  - Any malformed name

Within symptom rows, keep only those with Status `MONITORING`, `OPEN`, or `HIGH ALERT`. Also separately keep symptoms with Status `RESOLVED` AND a `Run date` in the last 7 days — useful for the "Resolved this week" section.

Within cluster rows, read all of them, regardless of Status. RESOLVED clusters that regress (a new symptom matches them) need to flip back to active.

## 1c. Fetch bodies where useful

For each cluster row, `notion-fetch` the body to read its current symptom list (the body lists which `cw-` slugs belong to that cluster). For symptom rows, fetch a body only if a row is brand-new this run and you need the detection signal to decide where it clusters.

## 1d. Hard precondition

If the view query fails, stop. Do not do partial writebacks. If only some pages came back, you cannot trust the cluster mapping and would create duplicates. Surface the failure in chat report-back.

# Step 2 — Map symptoms to clusters

A **cluster** is a set of symptoms where, if you fixed the underlying cause, all the symptoms in the set would stop firing. That is the only test for what belongs in a cluster.

Examples (illustrative, not prescriptive):

- `cw-briarlane-stale-slot-quoting` + `cw-kelson-tour-times-then-rented-contradiction` + `cw-prospero-27-stale-availability-contradiction` — all stem from the AI quoting/booking inventory that's already filled. One inventory-sync fix would close all of them. Same cluster.
- `cw-itziar-garbled-company-name-greeting` + `cw-woodsmere-company-name-mispronounced` — voice TTS isn't handling the customer's name correctly. One TTS-pronunciation fix closes both. Same cluster.
- `cw-briarlane-no-response-literal-leaked` + `cw-sanpra-agent-off-hours-no-response` — both involve the AI going silent, BUT the fixes are unrelated (one is a prompt-leak bug, one is an off-hours config bug). **Different clusters.** Do not merge just because the symptoms look similar — merge only when the same fix closes them.

## 2a. Match against existing clusters first

For each active symptom row, decide if it already belongs to a known cluster:

1. **Slug match** — if the symptom's `cw-{customer}-{symptom-slug}` is already listed in some cluster's body, that's its home. Deterministic, no ambiguity.
2. **Semantic match** — if no slug match, read the cluster's description and check whether the symptom is plausibly fixed by the same change. If yes, assign it. Be conservative: when in doubt, do not force a match — it's better to leave a symptom unclustered for one run than to merge clusters that should stay separate.

## 2b. Form new clusters from unmatched symptoms

After matching, you'll have a set of symptoms that didn't fit any existing cluster. Group those among themselves using the same "one fix closes all" test:

- If two unclustered symptoms share a plausible fix → new cluster
- If a symptom doesn't fit with any other → leave as a singleton (it becomes a 1-customer cluster)

When you create a new cluster, give it a short stable slug (kebab-case, descriptive of the underlying mechanism if you can name it, otherwise the dominant symptom). Once a cluster has a slug, it keeps that slug forever — that's how this skill builds history.

## 2c. Sanity check: don't over-merge

Before finalizing, look at each cluster's symptom list. Ask: "If I made one change to the system, would every one of these stop firing?" If you can't honestly answer yes, split the cluster.

A good signal that you've over-merged: the cluster spans both voice and text channels, or both AI-behavior and backend-config bugs, or both prompt issues and integration issues. Split.

## 2d. Aggressively minimize — dedupe and consolidate

**Default toward fewer, larger clusters.** Every extra cluster row is more state to read, longer emails, more token cost on every future run. Before finalizing the cluster set, do an explicit dedupe pass:

1. **Symptom-overlap merge.** For any two active clusters whose symptom lists overlap by 50% or more, merge them. Keep the older cluster slug (or the one with the broader fix-scope description); migrate the loser's symptoms into the winner; mark the loser cluster `RESOLVED` with Notes "merged into cl-{winner-slug}". The merge is a one-way operation — the loser stays in Notion as a RESOLVED record but never gets reused.
2. **Singleton absorption.** A singleton cluster (1 symptom, 1 customer, Streak 1) that plausibly fits an existing active cluster should be absorbed into the existing cluster rather than persisted on its own. Only keep a singleton as its own cluster if it genuinely doesn't fit any existing one — and even then, watch it: if it stays a singleton for 3+ runs with no peers, ask again whether it could be absorbed.
3. **Stale cluster cleanup.** If a cluster has been `RESOLVED` for 30+ days with no regression, mark its Notes with "archived — safe to delete from view" so an operator can prune by hand. Don't delete from Notion programmatically; the operator owns destructive cleanup.
4. **Empty clusters.** If a cluster row has 0 active symptoms AND 0 recently-resolved symptoms, it's an orphan. Set it to `RESOLVED` immediately with Notes "orphaned — no active symptoms."

**Bias toward "this is already a cluster" over "this is a new cluster."** The default move when a new symptom appears is to find its home, not to invent a new bucket. New clusters should be the exception.

# Step 3 — Update cluster state and write back

For each cluster (existing or new):

1. Compute its **current symptom list** (the active `cw-` rows that mapped to it this run)
2. Compute its **current customer list** (customers with at least one active symptom in the cluster)
3. Compute its **Status** using the rules below
4. Compute its **Streak** — consecutive runs the cluster has been Active (had at least one symptom mapped). Track consecutive-inactive runs in Notes between snapshot lines.
5. Compute the **history annotation** — a short natural-language line describing what changed this run vs prior runs. Pull from the cluster's existing Notes field (which carries the last few snapshots).

## Status rules

A cluster's Status is derived, not stored independently. Run these checks in order:

1. **Has 0 currently-active symptoms AND its prior Status was already RESOLVED** → stay `RESOLVED`. Skip the rest.
2. **Has 0 currently-active symptoms AND prior Status was active** → increment the consecutive-inactive counter in Notes. If consecutive-inactive >= 3, flip to `RESOLVED`. Otherwise keep prior Status — it's just "quiet this run."
3. **Has >=1 currently-active symptom AND prior Status was RESOLVED** → regression. Flip back to whatever the max-severity rule says. Note in Notes: "regressed after N runs RESOLVED."
4. **Has >=1 currently-active symptom (normal case)** → Status = max severity across underlying symptoms. `HIGH ALERT` > `OPEN` > `MONITORING`. Reset consecutive-inactive counter to 0.

## Aging out

Symptoms can age out underneath a cluster. If an underlying `cw-` row has Status `NON ISSUE` or `RESOLVED` this run, drop it from the cluster's symptom list. Don't drag dead symptoms along forever — they make the cluster look bigger than it is and bloat token usage on every subsequent read.

If after dropping all dead symptoms the cluster has 0 active symptoms, fall through to the consecutive-inactive countdown above.

## 3a. Write each cluster's properties

For each cluster, upsert by exact Name:

- If a `cl-{slug}` row exists in Step 1's data, `notion-update-page` it
- If no `cl-{slug}` row exists, `notion-create-pages` it

Properties to set:

- **Name** (title): `cl-{cluster-slug}` — never change after first creation
- **Issue Type** (select): `System`
- **Status** (select): `MONITORING`, `OPEN`, `HIGH ALERT`, or `RESOLVED` per Step 3 step 3
- **Streak** (number): per Step 3 step 4
- **Companies** (text): comma-separated current customer names
- **Companies count** (number): count of current customers
- **Sample Convs** (text): up to 3 example conversation IDs pulled from the underlying symptom rows
- **Run date** (datetime): **exact UTC time of this writeback to the second** — same rule as conversation-watch. Do not round.
- **Notes** (text): rolling history. Each run, prepend a one-line snapshot describing this run's state of the cluster. Cap at the most recent 7 entries to keep the field readable. Example:
  - `2026-05-15: 6 customers, +Mosaic, streak 3`
  - `2026-05-14: 5 customers, steady, streak 2`
  - `2026-05-13: 5 customers, NEW, streak 1`

## 3b. Write the cluster body on creation

On first creation of a cluster row, write a body using this template:

```markdown
**What this cluster is:** <one sentence — the underlying mechanism, as best you can describe it>

**Why these symptoms group together:** <one sentence — what the shared fix would address>

**Symptoms in this cluster:**

- cw-{customer1}-{symptom1}
- cw-{customer2}-{symptom2}
- ...
```

On subsequent runs, **rewrite the Symptoms list** in the body to reflect the current set (symptoms can be added or removed across runs as they newly fire or get resolved). The top two lines stay stable unless the cluster genuinely changes meaning, in which case rewrite carefully.

## 3c. Resolved clusters stay in Notion

When a cluster flips to `RESOLVED`, leave its row in place — don't delete it. It carries the history of the issue. If it regresses (a new symptom fires that maps to it semantically), update the row in place: Status back to active, Streak resets to 1, history note records "regressed after N runs RESOLVED."

# Step 4 — Compose the email

The brief is a status view of every currently-active cluster, plus a short "resolved this week" tail. Each cluster line shows current state and what's been happening to it.

## Subject

`RS daily pulse — {N} active clusters — YYYY-MM-DD`

Examples:

- `RS daily pulse — 6 active clusters — 2026-05-14`
- `RS daily pulse — quiet — 2026-05-14`

## Body structure

1. **Topline** — total active clusters, total active symptom rows, total customers affected, any HIGH ALERT items called out
2. **Active clusters** — every cluster with Status `MONITORING`, `OPEN`, or `HIGH ALERT`. Each one shows: name, current customer count, current symptom count, status pill, history annotation (NEW / +X / -Y / steady / growing / shrinking), one-sentence description, list of currently-affected customers.
3. **Resolved since last run** — any cluster that flipped to `RESOLVED` this run. One line each. Disappears after one appearance.
4. **Footer** — generation time, source

## Ordering

Within Active clusters, sort by:

1. Status (HIGH ALERT, then OPEN, then MONITORING)
2. Within Status, NEW-today clusters first, then clusters that changed this run (grew or shrank), then steady clusters

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

Cluster card (one per active cluster):

```html
<h2 class="section">Active clusters</h2>

<div class="cluster">
  <span class="cluster-name">stale-inventory-sync</span>
  <p class="meta">
    <span class="status-pill open">OPEN</span>
    6 customers · 8 symptoms ·
    <span class="change steady">steady 3 runs</span>
  </p>
  <p class="desc">AI quoting or booking units that have already been filled. One inventory-sync fix would close all symptoms in this cluster.</p>
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
    1 customer · 1 symptom ·
    <span class="change new">NEW today</span>
  </p>
  <p class="desc">Off-hours response suppression is firing during normal business hours. Single fix to the off-hours rule closes the symptom.</p>
  <p class="customers">
    <a href="https://www.rentsimple.ai/admin/companies/4">Sanpra</a> (8 conversations affected today)
  </p>
</div>

<div class="cluster">
  <span class="cluster-name">wrong-unit-specs</span>
  <p class="meta">
    <span class="status-pill monitoring">MONITORING</span>
    3 customers · 4 symptoms ·
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
    <b>duplicate-replies</b> — last seen at Mosaic and Prospero 56; 0 active symptoms across 3 clean runs.
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

The little italic line after the status pill is the key piece — it carries the history. Each cluster gets one of these descriptors based on its Notes history field:

- **NEW today** — this is the first run the cluster has appeared. Red, attention-grabbing.
- **+X customer(s)** — cluster grew this run. Name the customer(s) if 1-2, else just count.
- **−X customer(s)** — cluster shrank this run.
- **growing N runs** — cluster has gained customers across the last N consecutive runs.
- **shrinking N runs** — cluster has lost customers across the last N consecutive runs.
- **steady N runs** — same customer set across the last N consecutive runs.
- **regressed** — was RESOLVED, now active again.
- **down from X customers on YYYY-MM-DD** — useful when the cluster peaked higher in the recent past.

Pick the descriptor that's most informative for that cluster's recent trajectory. Don't pile on multiple — one descriptor per cluster.

## Customer links

Customer names link to admin: `<a href="https://www.rentsimple.ai/admin/companies/{id}">Name</a>`. Use `$APP_BASE_URL` if set; default `https://www.rentsimple.ai`.

# Step 5 — Send

Call RS-DB MCP `send_email` with `to`, `subject`, HTML body. If the call fails, retry once. If still failing, write full HTML to stdout and stop. The Notion writeback in Step 3 must happen regardless — state persistence is more important than email delivery.

# Hard rules

- **No Postgres queries.** This skill reads Notion only.
- **No conversation reading.** That's Layer 0's job.
- **No PII** in the email body. Customer names and conversation IDs are fine; prospect names, emails, phone numbers are not.
- **No emojis.**
- **No code anchors** or file:line citations — health-check handles that.
- **Cluster slugs are stable forever** once created. If a cluster's meaning shifts substantially, mark the old one resolved and start a new slug — don't reuse.
- **Don't merge clusters just because their symptoms look related.** The merge test is "one fix closes all," not "they're about the same area."
- **Don't touch `cs-*` rows.** Those belong to customer-watch.
- **Don't touch `cw-*` rows.** Those belong to conversation-watch. This skill only reads them.
- **Run date must be the exact UTC time of writeback**, to the second. Never round.

# Chat report-back

Short. One line each:

- Sent to: recipient(s)
- Active clusters: N (with counts by status — e.g. "1 HIGH ALERT, 2 OPEN, 3 MONITORING")
- Customers with active symptoms: K
- New clusters this run: list of slugs (or "none")
- Clusters resolved this run: list of slugs (or "none") — call out which were "merged into cl-X" vs "all symptoms cleared" vs "orphaned" vs "inactive 3 runs"
- Merges done: list of "cl-X → cl-Y" (or "none") — this is the dedupe signal; over time you want this to trend toward zero as the cluster set stabilizes
- Singletons absorbed: count (or "none")
- Symptoms aged out: count of `cw-` rows dropped from clusters because they went RESOLVED/NON ISSUE
- Anything weird: Notion write failures, mapping ambiguity, etc.
