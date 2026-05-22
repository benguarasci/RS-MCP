# Watch Investigation Layer + Operator Feedback Loop — Design

Date: 2026-05-22
Status: approved design, pending implementation plan

## Goal

Turn the watch-system dashboard from a read-only digest into an **investigation
tool**: filter, drill into specifics, and feed operator judgment back to the
watcher skills. This is "Increment 1" of a larger effort to make the system
give a high-level sense of performance; Increments 2 (aggregate views) and 3
(per-customer scorecards) are out of scope here.

## Scope

**In scope**
- A two-pane dashboard shell (fixed left rail + content pane).
- Four read pages: overview, cluster detail, company detail, issue detail.
- Filtering, search, and sorting on the overview.
- Operator feedback loop: mark an issue a non-issue, attach commentary, and
  create operator-defined issues for the watchers to monitor.
- Skill changes so conversation-watch honors operator input.

**Out of scope (later increments)**
- System health score, inflow/resolution scoreboard, multi-week trend charts.
- Company grouping (the Prospero ×4 fragmentation) and per-customer scorecards.
- Trends and Companies nav items appear as disabled placeholders only.

## Architecture

Server-rendered, extending the existing Express app. No client build step.

- **Extract rendering into `views.js`.** `server.js` keeps routing + SQL;
  `views.js` owns all HTML. The Dockerfile must add `COPY views.js ./`.
- **Two-pane shell** rendered by a shared `layout()` helper:
  - Fixed **left rail**: "RS watch" brand; a `+ New issue` button; nav
    (Overview active; Trends and Companies as disabled "soon" placeholders);
    the 7 categories with live counts, each a category filter link; severity /
    status / search filter controls.
  - **Content pane**: page-specific content, with a breadcrumb bar on top.
- **`STYLES`** — one consolidated stylesheet constant, the existing warm palette
  (`#f5f4ed` bg, `#fbfaf4` cards, `#2c2b27` text, `#cc785c` accent, existing
  severity colors). Operator controls use a distinct green accent (`#6b8f5e`).
- **`href(path, params)`** helper — appends the auth token to every internal
  link. Auth is unchanged: `?token=` query param, validated against `AUTH_TOKEN`.
- Page renderers: `renderDashboard`, `renderCluster`, `renderCompany`,
  `renderIssue`, `renderNewIssueForm`, plus a `renderNotFound`.
- Body parsing: add `express.urlencoded({ extended: false })` for form POSTs.

## Data model change — migration `0003_issue_origin.sql`

The only schema change. `issues.status` (incl. `dismissed`) and `issues.notes`
already exist and need no migration.

- New domain `issue_origin as text check (value in ('watcher','operator'))`.
- `alter table issues add column origin issue_origin not null default 'watcher'`
  — existing rows backfill to `watcher` via the default.
- Rebuild `v_issues` to expose `origin` (appended after existing columns).

## Routes

All routes are token-authed. A missing record renders `renderNotFound` (404).

| Method & path | Purpose |
|---|---|
| `GET /dashboard` | Overview — health block + sortable cluster table. Filters via query params. |
| `GET /cluster/:id` | Cluster detail (`clusters.id`). |
| `GET /company/:slug` | Company detail (`companies.slug`). |
| `GET /issue/:id` | Issue detail (`issues.id`). |
| `GET /issue/new` | New-issue form. |
| `POST /issue` | Create an operator issue. |
| `POST /issue/:id/dismiss` | Mark issue a non-issue (`status = 'dismissed'`). |
| `POST /issue/:id/note` | Save operator commentary to `issues.notes`. |

POST handlers follow Post/Redirect/Get: on success, 302 back to the relevant
page so a refresh does not re-submit. Forms carry the token in a hidden field.

## Pages

### Overview (`/dashboard`)
- Health-score block at the top of the content pane (the existing
  conversation-health widget — unchanged).
- A summary line: cluster count, active issue count, customer count, current
  sort.
- A **dense sortable table**, one cluster per row. Columns: Cluster, Category,
  Severity, Status, Companies, Issues, Streak, 14-day mini-trend (sparkline from
  `cluster_snapshots`). Column headers sort. Each row links to `/cluster/:id`.
- Resolved clusters listed compactly below the active table.

### Cluster detail (`/cluster/:id`)
- Header: slug, severity/status/category pills, meta line (customers, active
  issues, streak, quiet runs), description.
- **Snapshot-history table** — recent `cluster_snapshots` rows (run date,
  status, customer count, issue count, history note).
- **Member-issues table** — every issue in the cluster: kind (links to
  `/issue/:id`), customer (links to `/company/:slug`), severity, streak,
  conversation links, `operator-added` badge where `origin = 'operator'`.
  Active issues first; resolved/dismissed collapsed.

### Company detail (`/company/:slug`)
- Same skeleton as cluster detail.
- Header: company name, admin deep-link, summary (active issues, high-severity
  count, cluster count, per-category mini-counts).
- That customer's issues in a table, grouped by category then cluster.

### Issue detail (`/issue/:id`)
- Breadcrumb with cross-links to its cluster and company.
- Identity: kind + company; status/severity pills; `operator-added` badge if
  applicable.
- Meta: streak, clean_runs, first/last sighted, age, resolved_at.
- `summary`, `detection_signal`, `notes`.
- `sample_convs` rendered as conversation deep-links
  (`/admin/conversations?conversationId=`).
- **Operator review panel** (green-accented): a one-click `Mark as non-issue`
  button, a commentary textarea, and a `Save note` button.

### New-issue form (`/issue/new`)
- Fields: company (select), kind (slug text), summary (textarea), severity
  (select), example conversations (comma-separated IDs).
- Submits to `POST /issue`.

## Filtering, search, sorting

Overview query params: `category`, `severity`, `status`, `company`, `q`, `sort`.
- `q` — free-text match across issue `kind` + `summary` and cluster `slug` +
  `description`.
- `sort` — one of the table columns; default by active issue count descending.
- Category filter is also driven by the rail's category list.
- Active filters are shown with a "clear" link. Filters apply server-side.

## Operator feedback loop

### Mark as non-issue
`POST /issue/:id/dismiss` sets `status = 'dismissed'`. One click, no reason
prompt — the commentary box covers any explanation the operator wants to add.

### Commentary
`POST /issue/:id/note` writes free text to `issues.notes`. This field is
**operator-owned**: conversation-watch reads it but never overwrites it.

### Operator-defined issues
`POST /issue` inserts a row with `origin = 'operator'`, `status = 'monitoring'`,
the given severity, and `sample_convs` parsed from the comma-separated input.
Identity is still `(company_id, kind)`; if that pair already exists the handler
rejects with a message linking to the existing issue.

## Skill changes

### conversation-watch
- **Dismissal is sticky.** When a run's findings match an issue whose
  `status = 'dismissed'`, do not reopen it — leave it dismissed. conversation-
  watch never writes `dismissed` itself and never auto-reopens it. Only an
  operator un-dismisses (a future affordance; not in this increment).
- **Read operator commentary.** Before judging a given company+kind, read the
  existing issue's `notes` and factor the operator's guidance into the call.
  Never overwrite `notes`.
- **Monitor operator-defined issues.** Treat `origin = 'operator'` issues as
  first-class members of the active set every run: actively look for that
  pattern, update `sample_convs` / `streak` / `last_sighted` when sighted,
  increment `clean_runs` when not. Never delete them. Do not change `origin`.

### daily-pulse
- No behavior change required — it already excludes `dismissed` issues and
  clusters everything else uniformly. Operator-origin issues cluster normally.
  Optionally tag operator-added issues in the email; not required here.

## Error handling

- 401 for a bad/missing token (existing pattern).
- 404 via `renderNotFound` for an unknown cluster id / company slug / issue id.
- 500 for DB errors (existing pattern).
- `POST /issue` conflict on `(company_id, kind)` → a clear message, not a 500.

## Verification

The project has no test harness; verification is pragmatic:
- `node --check server.js` and `node --check views.js`.
- Manual smoke of every GET route, including 404 and filter/sort combinations.
- Manual test of each POST: dismiss, save note, create issue (including the
  duplicate-kind conflict path).
- Migration `0003` applies cleanly via the deploy `release_command`.

## Build order

1. Migration `0003` + `v_issues` rebuild.
2. `views.js` extraction + shared shell/layout/helpers.
3. GET routes and the four pages + new-issue form.
4. POST routes and the operator feedback loop.
5. conversation-watch skill changes.
6. Dockerfile `COPY views.js`; deploy.
