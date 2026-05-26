---
description: Daily issue-cluster tracker. Reads per-customer issues from conversation-watch (Layer 0) in the watch-state DB, groups them into clusters (where one fix would close all issues in the cluster), and persists those clusters to the watch-state DB with snapshot history. The dashboard renders the cluster state and history. Never reads conversations directly.
---

You're the daily issue-tracker. conversation-watch (Layer 0) flags per-customer issues into the `issues` table of the watch-state Postgres DB. Your job each run: read those issues, group them into clusters where **one fix would close all issues in the cluster**, update the `clusters` table, and write a `cluster_snapshots` row per cluster so history accumulates across runs.

The output is the DB state, not an email. A separate dashboard reads `clusters` + `cluster_snapshots` and renders the status view (current pill, history annotation, customers affected, conversation deep-links). Keep all rendering concerns out of this skill — focus only on accurate clustering and snapshot writes.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, reads every prospect conversation, writes per-customer issues to the watch-state DB.
- **daily-pulse** (this one) — runs daily, reads `issues`, groups them into `clusters`, writes a `cluster_snapshots` row per cluster.
- **health-check** (Layer 2) — runs weekly, reads the same cluster history plus the underlying issues, writes a longer-form trend email.
- **customer-watch** — a separate, manually-curated watch over named at-risk customers; out of scope here, don't touch it.

# Required MCP tools

- **`state_query`** — read/write SQL against the watch-state Postgres DB (`issues`, `clusters`, `cluster_snapshots`, `runs`).

If `state_query` is missing, stop — there's no input or persistence without it.

This skill **never reads conversations** and never touches the prod DB. The watch-state DB is the sole input and the sole place state is kept.

# Scope

Every issue with `status` in `open` or `monitoring`. Resolved/dismissed issues are excluded — the dashboard reads `issues.resolved_at` directly for the resolved tail.

# Step 0 — Open the run

```sql
INSERT INTO runs (layer, status) VALUES ('daily-pulse', 'running') RETURNING id;
```

Keep that `run_id` for the snapshot rows and the close in Step 4.

# Step 1 — Read the state

All reads go through `state_query`. **Use compact text projections** (`string_agg`, `text` aggregations) — `jsonb` pretty-prints one element per line and overflows the output cap fast on 40+ clusters. Pre-aggregate per cluster in SQL whenever possible; don't pull per-issue rows you only need counts of.

## 1a. Per-cluster aggregate (for already-assigned issues)

```sql
SELECT cluster_id,
       COUNT(*) AS active_issues,
       COUNT(DISTINCT company) AS active_companies,
       string_agg(DISTINCT company, '|' ORDER BY company) AS companies,
       COUNT(*) FILTER (WHERE severity = 'high') AS hi,
       COUNT(*) FILTER (WHERE severity = 'medium') AS med,
       COUNT(*) FILTER (WHERE severity = 'low') AS lo,
       BOOL_OR(status = 'open') AS any_open
FROM v_issues
WHERE status IN ('open','monitoring') AND cluster_id IS NOT NULL
GROUP BY cluster_id
ORDER BY cluster_id;
```

This is all the per-cluster state Steps 2-3 need for already-assigned issues. No per-issue rows pulled into context.

## 1b. Unassigned issues (need semantic matching)

```sql
SELECT id, company, kind, severity, status
FROM v_issues
WHERE status IN ('open','monitoring') AND cluster_id IS NULL
ORDER BY company, kind;
```

These are the issues you'll match against existing clusters (Step 2a) or group into new ones (Step 2b). Pull `kind` because it's how you semantically match. Don't pull `summary` / `notes` / `attributes` / `sample_convs` — too verbose and rarely needed for the match decision.

## 1c. Existing clusters

```sql
SELECT id, slug, status, severity, streak, inactive_runs, category,
       description, fix_rationale, resolved_at
FROM clusters
ORDER BY id;
```

`description` and `fix_rationale` are needed for semantic matching of unassigned issues. Skip `attributes`, `sample_convs`, `created_at`, `updated_at` — unused here. Read `resolved` clusters too — a regression flips one back to active.

## 1d. Last snapshot per cluster (for diff)

```sql
SELECT DISTINCT ON (cluster_id) cluster_id, status, severity, streak,
       company_count, issue_count, companies, note
FROM cluster_snapshots
ORDER BY cluster_id, captured_at DESC;
```

Just the most recent snapshot per cluster — that's what you diff against to compute "+X / -Y customers" and "growing N runs" / "shrinking N runs". Pulling 14 days of history was overkill; the prior `streak` and `inactive_runs` on the cluster row already capture multi-run trajectory.

## 1e. Hard precondition

If any read fails, stop. Do not do a partial writeback — surface the failure in the chat report-back.

# Step 2 — Map issues to clusters

A **cluster** is a set of issues where, if you fixed the underlying cause, all the issues in the set would stop firing. That is the only test for what belongs in a cluster.

Examples (illustrative, not prescriptive):

- Briarlane `stale-slot-quoting` + Kelson `tour-times-then-rented-contradiction` + Prospero `stale-availability-contradiction` — all stem from the AI quoting/booking inventory that's already filled. One inventory-sync fix would close all of them. Same cluster.
- Itziar `garbled-company-name-greeting` + Woodsmere `company-name-mispronounced` — voice TTS isn't handling the customer's name correctly. One TTS-pronunciation fix closes both. Same cluster.
- Briarlane `no-response-literal-leaked` + Sanpra `agent-off-hours-no-response` — both involve the AI going silent, BUT the fixes are unrelated (one is a prompt-leak bug, one is an off-hours config bug). **Different clusters.** Do not merge just because the issues look similar — merge only when the same fix closes them.

## 2a. Match against existing clusters first

For each unassigned issue (from 1b), check each cluster's `description` / `fix_rationale` and decide whether the same fix would close it. Already-assigned issues stay where they are unless aging-out moves them. Be conservative: when in doubt, leave unclustered for one run rather than forcing a merge.

## 2b. Form new clusters from unmatched issues

After matching, group leftover unassigned issues among themselves using the same "one fix closes all" test:

- If two unassigned issues share a plausible fix → new cluster.
- If an issue doesn't fit with any other → leave as a singleton (1-customer cluster).

When you create a new cluster, give it a short stable `slug` (kebab-case, descriptive of the underlying mechanism). The cluster's surrogate `id` is the real continuity key, so even a slug rename wouldn't break history.

## 2c. Sanity check: don't over-merge

For each cluster, ask: "If I made one change to the system, would every one of these stop firing?" If you can't honestly answer yes, split. A signal you've over-merged: the cluster spans both voice and text channels, or both AI-behavior and backend-config bugs. Split.

## 2d. Aggressively minimize — dedupe and consolidate

**Default toward fewer, larger clusters.** Before finalizing:

1. **Issue-overlap merge.** For any two active clusters whose issue sets overlap by 50%+, merge them. Keep the older cluster (lower `id`); reassign the loser's issues to the winner; set the loser's `status = 'resolved'`, `resolved_at = now()`, and write a snapshot note "merged into {winner-slug}". One-way — the loser is never reused.
2. **Singleton absorption.** A singleton cluster (1 issue, 1 customer, streak 1) that plausibly fits an existing active cluster should be absorbed rather than persisted on its own.
3. **Empty clusters.** If a cluster has 0 active issues AND 0 recently-resolved issues, set it `resolved` with snapshot note "orphaned — no active issues."

**Bias toward "this is already a cluster" over "this is a new cluster."** New clusters should be the exception.

## 2e. Assign each new cluster a category

Every cluster carries a `category` — the failure-mode tier *above* clusters. Assign exactly one per cluster; when a cluster could fit two, pick the **primary** failure mode. The seven categories are the only valid values — the `issue_category` DB domain rejects anything else:

- **`fabrication`** — the AI states content with no backing data: invented prices, links, specs, names, or policies.
- **`stale-or-wrong-data`** — data existed but was outdated or mismatched, or the wrong record / listing / unit was selected.
- **`unbacked-action-claims`** — the AI claims an action is complete, or promises an outcome, with no successful tool call behind it.
- **`tool-and-pipeline-failures`** — a tool errored, failed silently, raced, or double-fired.
- **`context-and-identity-loss`** — the AI forgot known information or mixed up prospect / conversation records.
- **`dropped-or-blocked-conversations`** — the AI went silent, stalled, or never replied.
- **`policy-and-safety-violations`** — a boundary, disclosure rule, or funnel rule was crossed; internal content leaked.

`category` is **stable** — set once on creation; never overwritten. Existing clusters already have one. Only brand-new clusters need a category assigned this run.

# Step 3 — Update cluster state and write back

For each cluster (existing or new), compute:

1. **current issue set** — the active issues mapped to it this run (from 1a + reassignments)
2. **current customer set** — distinct companies among those issues
3. **status** — see rules below
4. **severity** — `MAX` across member issues (`high` > `medium` > `low`)
5. **streak** — consecutive runs the cluster has been active (had ≥1 issue mapped)
6. **inactive_runs** — consecutive runs with 0 active issues
7. **history annotation** — a short line describing this run vs the prior snapshot (1d)

## Status rules

Run in order:

1. **0 active issues AND prior status already `resolved`** → stay `resolved`. Skip the rest.
2. **0 active issues AND prior status active** → `inactive_runs += 1`. Flip to `resolved` only when BOTH hold: `inactive_runs >= 7` AND the most recent activity was 7+ days ago. Otherwise keep prior status — "quiet this run".
3. **≥1 active issue AND prior status `resolved`** → regression. Flip back to active; `streak = 1`; note "regressed after N runs resolved".
4. **≥1 active issue (normal)** → `status = 'open'` if any member issue is `open`, else `monitoring`. Reset `inactive_runs` to 0.

## 3a. Write the clusters

Upsert clusters by `slug`. `description`, `fix_rationale`, and `category` are stable — set on insert, never overwritten. **Write every cluster in one multi-row INSERT** — separate statements per cluster mean 40+ `state_query` round-trips and blow the wall-clock budget.

```sql
INSERT INTO clusters (slug, status, severity, streak, inactive_runs,
                      description, fix_rationale, category, resolved_at)
VALUES
  ('stale-inventory-sync', 'open', 'high', 3, 0,
   'AI quoting or booking units that have already been filled.',
   'A single inventory-sync fix would close every issue in this cluster.',
   'stale-or-wrong-data', NULL),
  ('off-hours-misconfig', 'open', 'high', 1, 0,
   'Off-hours response suppression firing during business hours.',
   'One fix to the off-hours rule closes the issue.',
   'dropped-or-blocked-conversations', NULL)
  -- ...one row per cluster
ON CONFLICT (slug) DO UPDATE SET
  status = excluded.status, severity = excluded.severity,
  streak = excluded.streak, inactive_runs = excluded.inactive_runs,
  resolved_at = excluded.resolved_at;
```

## 3b. Reassign issues to clusters

Reassign every issue in one statement — map `(issue_id, cluster_slug)` pairs through a `VALUES` list:

```sql
UPDATE issues AS i
SET cluster_id = c.id
FROM (VALUES
  (42, 'stale-inventory-sync'),
  (43, 'stale-inventory-sync'),
  (51, 'off-hours-misconfig')
) AS m(issue_id, slug)
JOIN clusters c ON c.slug = m.slug
WHERE i.id = m.issue_id;
```

For issues that left every cluster this run, one statement clears them all: `UPDATE issues SET cluster_id = NULL WHERE id IN (...)`.

## 3c. Write a snapshot per cluster

One `cluster_snapshots` row per cluster per run. **Insert them all in one statement**, joining a `VALUES` list to `clusters` by `slug` to resolve each `cluster_id`:

```sql
INSERT INTO cluster_snapshots (cluster_id, run_id, status, severity, streak,
                               company_count, issue_count, companies, note)
SELECT c.id, <run_id>, s.status, s.severity, s.streak,
       s.company_count, s.issue_count, s.companies, s.note
FROM (VALUES
  ('stale-inventory-sync', 'open'::text, 'high'::text, 3, 6, 8,
   '["Briarlane","Kelson","Mosaic","Prospero","Townline"]'::jsonb,
   '+Mosaic this run, streak 3'::text),
  ('off-hours-misconfig', 'open', 'high', 1, 1, 1,
   '["Sanpra"]'::jsonb, 'NEW today')
) AS s(slug, status, severity, streak, company_count, issue_count, companies, note)
JOIN clusters c ON c.slug = s.slug;
```

The `note` is the dashboard's primary signal for what changed this run. Write it well — see the annotation rules below.

Do not set `updated_at` on any table — the DB trigger maintains it.

## History annotation rules (for `cluster_snapshots.note`)

Compute by diffing the current customer set against the prior snapshot (1d). Pick the single most informative descriptor:

- **NEW today** — first run the cluster has appeared.
- **+X customer(s)** — cluster grew this run. Name customer(s) if 1-2, else just count.
- **−X customer(s)** — cluster shrank this run.
- **growing N runs** — gained customers across the last N consecutive runs.
- **shrinking N runs** — lost customers across the last N consecutive runs.
- **steady N runs** — same customer set across the last N consecutive runs.
- **regressed** — was resolved, now active again.
- **down from X customers on YYYY-MM-DD** — useful when the cluster peaked higher recently.

Combine concisely — e.g. `"+Townline; 4 issues (+1); streak 7"` or `"steady 9 runs"`.

# Step 4 — Close the run

```sql
UPDATE runs
SET status = 'succeeded', finished_at = now(),
    summary = 'Run 30 — 43 active clusters across 13 customers; +1 new, 1 resolved.',
    stats = '{"active_clusters":43,"active_issues":268,"customers":13,"high_alert":18,"new":1,"resolved":1,"reassigned":24,"merges":0}'::jsonb
WHERE id = <run_id>;
```

The dashboard may read `runs.stats` for at-a-glance counts, so keep these fields consistent run-to-run:

- `active_clusters`, `active_issues`, `customers` — totals.
- `high_alert` — count of clusters with `severity = 'high'`.
- `new`, `resolved` — clusters that flipped status this run.
- `reassigned` — issues that changed `cluster_id` this run (incl. newly-assigned).
- `merges` — overlap-merge count; trend this toward zero.

# Hard rules

- **No conversation reading, no prod DB.** This skill reads and writes only the watch-state DB via `state_query`.
- **Don't merge clusters just because their issues look related.** The merge test is "one fix closes all," not "same area."
- **`description` / `fix_rationale` / `category` are stable** — set once on cluster creation, never overwritten. Every new cluster must be assigned a `category` — one of the seven values in Step 2e.
- **This skill never writes `issues.status`, `issues.severity`, or any issue field except `cluster_id`.** Issue lifecycle belongs to conversation-watch.
- **`status` writes must be exactly `open`, `monitoring`, or `resolved`; `severity` exactly `low`, `medium`, `high`.** The DB domains reject anything else.
- **Every resolve requires a rationale** in the cluster's `cluster_snapshots.note` — trigger rule, last-active date, runs inactive, customer count at last activity. If you can't construct one (e.g. inactive <7 days), do NOT resolve — keep prior status.

# Chat report-back

Short. One line each:

- Active clusters: N (e.g. "1 HIGH ALERT, 2 OPEN, 3 MONITORING")
- Customers with active issues: K
- New clusters this run: list of slugs (or "none")
- Clusters resolved this run: list of slugs (or "none") — call out "merged into X" vs "all issues cleared" vs "orphaned" vs "inactive 7 runs"
- Merges done: list of "X → Y" (or "none")
- Singletons absorbed: count (or "none")
- Anything weird: state_query write failures, domain rejections, mapping ambiguity, etc.
