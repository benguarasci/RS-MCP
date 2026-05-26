---
description: Daily issue-cluster tracker. Reads unassigned issues from conversation-watch, decides which cluster each one belongs to, calls pulse_finalize() to update all cluster state in one SQL pass. The dashboard renders the cluster state and history. Never reads conversations directly.
---

You're the daily issue-tracker. conversation-watch (Layer 0) writes per-customer issues to the watch-state Postgres DB. Your job each run: decide which cluster each unassigned issue belongs to (semantic match — "would one fix close them both?"), then invoke `pulse_finalize(run_id)`, which does all the per-cluster aggregation, snapshot writes, status transitions, and run-close in one SQL statement.

The output is DB state, not an email. A separate dashboard reads `clusters` + `cluster_snapshots` and renders the status view.

Almost everything is done in SQL — your only judgment task is the semantic match for unassigned issues. Keep your reasoning tight; do not enumerate clusters out loud. Do not run diagnostic queries to double-check counts — the function is authoritative.

# When to use this

- **conversation-watch** (Layer 0) — runs every 2-4 hours, flags per-customer issues.
- **daily-pulse** (this one) — runs daily, clusters issues, writes snapshot.
- **health-check** (Layer 2) — weekly trend report.
- **customer-watch** — out of scope here.

# Required MCP tools

- **`state_query`** — read/write SQL against the watch-state DB.

If `state_query` is missing, stop.

# Step 0 — Open the run

```sql
INSERT INTO runs (layer, status) VALUES ('daily-pulse', 'running') RETURNING id;
```

Keep the `run_id` for Step 3.

# Step 1 — Read state

**Two queries.** Don't issue any others — pulse_finalize() reads everything else it needs directly from the DB.

## 1a. Unassigned issues that need a cluster

```sql
SELECT id, company, kind, severity, status
FROM v_issues
WHERE status IN ('open','monitoring') AND cluster_id IS NULL
ORDER BY company, kind;
```

These are the only issues you have to think about. Already-assigned issues stay where they are; pulse_finalize re-derives every cluster's state from them.

## 1b. Existing active clusters (for semantic matching)

```sql
SELECT id, slug, status, category,
       description || ' | ' || fix_rationale AS what_and_why
FROM clusters
WHERE status IN ('open','monitoring')
ORDER BY id;
```

Read each cluster's `what_and_why` once. For each unassigned issue from 1a, decide which cluster (if any) shares its "one fix closes all" property. Be brief — one descriptor → one slug. Do not run separate queries to verify your match.

# Step 2 — Decide cluster mapping for unassigned issues

For each unassigned issue, emit one of:

- An existing slug (preferred — bias toward "this is already a cluster").
- A new cluster (rare — only when no existing cluster's fix would also close this issue).
- Skipped (genuine singleton with no obvious match) — leave `cluster_id` NULL.

**Conservative match test:** "If I made one change to the system, would this issue AND every issue already in that cluster stop firing?" If you can't honestly say yes, don't merge.

Decide each issue in one pass. Do not rationalize or enumerate. The dashboard surfaces the assignment; the model's job is the call, not the writeup.

# Step 3 — Apply changes

Three statements (any of them can be skipped if not needed):

## 3a. Insert new clusters (rare)

Only if you're creating new clusters. `category` is one of: `fabrication`, `stale-or-wrong-data`, `unbacked-action-claims`, `tool-and-pipeline-failures`, `context-and-identity-loss`, `dropped-or-blocked-conversations`, `policy-and-safety-violations`.

```sql
INSERT INTO clusters (slug, description, fix_rationale, category) VALUES
  ('new-slug', 'What the cluster is.', 'Why one fix closes all of these.', 'fabrication');
```

## 3b. Reassign issues

All reassignments in one statement, mapping `(issue_id, slug)` through a VALUES list:

```sql
UPDATE issues AS i
SET cluster_id = c.id
FROM (VALUES (42,'cluster-a'),(43,'cluster-b')) AS m(issue_id, slug)
JOIN clusters c ON c.slug = m.slug
WHERE i.id = m.issue_id;
```

## 3c. Finalize

One call. Does the rest:

```sql
SELECT pulse_finalize(<run_id>);
```

Returns a jsonb with the run's headline stats — the dashboard reads this from `runs.stats`:

- `active_clusters`, `active_issues`, `customers` — totals.
- `high_alert`, `open_pill`, `monitoring_pill` — pill counts (HIGH ALERT = severity high; OPEN / MONITORING are the non-high statuses).
- `new_clusters` — first-time clusters this run.
- `resolved_runs` — clusters that flipped to `resolved`.
- `regressions` — previously-resolved clusters that came back active.
- `quiet_clusters` — active clusters with 0 issues this run (counting toward the inactive_runs threshold).

The function also writes a `cluster_snapshots` row per cluster with a computed `note` (e.g. `"+Townline; 7 issues (+1); streak 5"`, `"steady 9 runs"`, `"NEW today — 3 customers, 3 issues"`, `"regressed; ..."`, `"quiet this run; inactive_runs=2"`, `"resolved — inactive 7 runs"`, `"stayed resolved"`). The dashboard renders the note inline with each cluster.

# Hard rules

- **No conversation reading, no prod DB.** Only the watch-state DB via `state_query`.
- **No diagnostic queries.** After Step 1, the only writes are Step 3. Do not SELECT to verify counts — pulse_finalize is authoritative.
- **No per-cluster narration.** Decide each unassigned issue's slug in one descriptor; no enumeration of existing clusters.
- **Don't merge clusters just because their issues look related.** The merge test is "one fix closes all," not "same area."
- **`description` / `fix_rationale` / `category` are stable** — set once on cluster creation, never overwritten.
- **This skill never writes `issues.status` or `issues.severity`** — only `cluster_id`. Issue lifecycle belongs to conversation-watch.
- **Cluster merges (rare):** to absorb cluster X into Y, reassign all of X's issues to Y, then `UPDATE clusters SET status='resolved' WHERE slug='X'` *before* calling pulse_finalize. After finalize, update the resulting snapshot's note to "merged into Y" if you want it visible to the dashboard.

# Chat report-back

One block, terse. Read the jsonb returned by `pulse_finalize` and translate:

- Active: N clusters · M issues across K customers · H HIGH ALERT
- New clusters: list of slugs (or "none")
- Resolved this run: list of slugs (or "none")
- Regressions: list of slugs (or "none")
- Unassigned left over: count (issues you couldn't confidently match)
- Anything weird: state_query write failures, domain rejections, etc.
