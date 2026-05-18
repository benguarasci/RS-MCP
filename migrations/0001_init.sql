-- 0001_init.sql — watch-system state schema
-- (the schema_migrations tracking table is created by migrate.js, not here)

-- Centralized value definitions so they can't drift between tables.
create domain severity_level as text check (value in ('low','medium','high'));
create domain issue_status   as text check (value in ('open','monitoring','resolved','dismissed'));
create domain cluster_status as text check (value in ('open','monitoring','resolved'));

-- Shared updated_at trigger — app discipline is not relied on.
create function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- Companies: normalized so a free-text name can't fragment into duplicates.
create table companies (
  id         bigint generated always as identity primary key,
  slug       text not null unique,                  -- briarlane
  name       text not null,                         -- Briarlane
  admin_id   integer unique,                        -- /admin/companies/{admin_id}, 1:1
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per skill execution. "Last run" = MAX(started_at) WHERE status='succeeded'.
create table runs (
  id          bigint generated always as identity primary key,
  layer       text not null
                check (layer in ('conversation-watch','daily-pulse','health-check')),
  status      text not null default 'running'
                check (status in ('running','succeeded','failed')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  summary     text,
  stats       jsonb not null default '{}'::jsonb
);
create index on runs (layer, status, started_at desc);

-- Clusters: "one fix closes all" groupings (daily-pulse output).
-- slug is the stable identity, assigned once and immutable. Semantic dedup of
-- near-identical clusters is daily-pulse's job (Step 2d) — not enforceable in SQL.
create table clusters (
  id            bigint generated always as identity primary key,
  slug          text not null unique,                -- stale-inventory-sync
  status        cluster_status not null default 'open',
  severity      severity_level not null default 'medium',
  streak        integer not null default 0,          -- consecutive active runs
  inactive_runs integer not null default 0,          -- consecutive runs with 0 active issues
  description   text not null,                       -- "what this cluster is"
  fix_rationale text not null,                       -- "why these issues group together"
  sample_convs  jsonb not null default '[]'::jsonb,
  attributes    jsonb not null default '{}'::jsonb,  -- channel, product area, etc.
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on clusters (status);

-- Issues: one row per per-customer issue (conversation-watch output).
-- Identity is (company_id, kind). Counters are canonical, set each run.
create table issues (
  id               bigint generated always as identity primary key,
  company_id       bigint not null references companies(id),
  kind             text not null,                   -- stale-slot-quoting
  cluster_id       bigint references clusters(id) on delete set null,
  status           issue_status not null default 'open',
  severity         severity_level not null default 'medium',
  streak           integer not null default 0,      -- consecutive runs sighted
  clean_runs       integer not null default 0,      -- consecutive clean runs since last sighting
  summary          text not null,                   -- human description
  detection_signal text,
  sample_convs     jsonb not null default '[]'::jsonb,
  attributes       jsonb not null default '{}'::jsonb,
  notes            text,
  first_sighted    timestamptz not null default now(),
  last_sighted     timestamptz not null default now(),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, kind)
);
create index on issues (status);
create index on issues (cluster_id);
create index on issues (kind);

-- One row per cluster per daily-pulse run. Canonical cluster history —
-- powers the email's history annotations and health-check trends.
create table cluster_snapshots (
  id            bigint generated always as identity primary key,
  cluster_id    bigint not null references clusters(id) on delete cascade,
  run_id        bigint references runs(id) on delete set null,
  captured_at   timestamptz not null default now(),
  status        cluster_status not null,
  severity      severity_level not null,
  streak        integer not null,
  company_count integer not null,
  issue_count   integer not null,
  companies     jsonb not null default '[]'::jsonb,  -- frozen company list for this run
  note          text                                 -- the one-line history annotation
);
create index on cluster_snapshots (cluster_id, captured_at desc);

create trigger trg_companies_updated before update on companies
  for each row execute function set_updated_at();
create trigger trg_clusters_updated before update on clusters
  for each row execute function set_updated_at();
create trigger trg_issues_updated before update on issues
  for each row execute function set_updated_at();

-- Denormalized read models: write to base tables, read from these.
create view v_issues as
select i.id, co.slug as company_slug, co.name as company,
       co.admin_id as company_admin_id, i.kind, i.status, i.severity,
       i.streak, i.clean_runs, i.summary, i.detection_signal,
       i.sample_convs, i.attributes, i.notes,
       cl.slug as cluster, i.cluster_id,
       i.first_sighted, i.last_sighted, i.resolved_at, i.updated_at
from issues i
join companies co on co.id = i.company_id
left join clusters cl on cl.id = i.cluster_id;

create view v_clusters as
select cl.id, cl.slug, cl.status, cl.severity, cl.streak, cl.inactive_runs,
       cl.description, cl.fix_rationale, cl.sample_convs, cl.attributes,
       count(i.id) as issue_count,
       count(distinct i.company_id) as company_count,
       coalesce(jsonb_agg(distinct co.name)
                filter (where co.name is not null), '[]'::jsonb) as companies,
       cl.resolved_at, cl.created_at, cl.updated_at
from clusters cl
left join issues i on i.cluster_id = cl.id and i.status in ('open','monitoring')
left join companies co on co.id = i.company_id
group by cl.id;
