-- 0004_customer_watch.sql — customer-watch state in the watch-state DB.
-- Moves customer-watch off Notion. Customer-watch's per-issue state lives
-- in its own table (cs_issues) so its (company_id, kind) identity doesn't
-- collide with conversation-watch's. The runs table is shared.

alter table runs drop constraint runs_layer_check;
alter table runs add constraint runs_layer_check
  check (layer in ('conversation-watch','daily-pulse','health-check','customer-watch'));

create table cs_issues (
  id               bigint generated always as identity primary key,
  company_id       bigint not null references companies(id),
  kind             text not null,                       -- stable kebab-case slug
  status           issue_status not null default 'monitoring',
  severity         severity_level not null default 'medium',
  streak           integer not null default 0,          -- consecutive runs sighted
  clean_runs       integer not null default 0,          -- consecutive clean runs since last sighting
  summary          text not null,                       -- one-sentence customer-facing description
  detection_signal text,                                -- mechanical re-detection rule
  sample_convs     jsonb not null default '[]'::jsonb,  -- up to 3 example conv IDs (most recent)
  notes            text,                                -- short rationale for this run's transition
  origin           text not null default 'customer-watch'
                   check (origin in ('customer-watch','operator')),
  operator_note    text,                                -- operator-owned commentary for the next run
  first_sighted    timestamptz not null default now(),
  last_sighted     timestamptz not null default now(),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, kind)
);
create index on cs_issues (company_id);
create index on cs_issues (status);

create trigger trg_cs_issues_updated before update on cs_issues
  for each row execute function set_updated_at();

-- Denormalized read model. Write to cs_issues; read from v_cs_issues.
create view v_cs_issues as
select i.id, co.slug as company_slug, co.name as company,
       co.admin_id as company_admin_id, i.kind, i.status, i.severity,
       i.streak, i.clean_runs, i.summary, i.detection_signal,
       i.sample_convs, i.notes, i.origin, i.operator_note,
       i.first_sighted, i.last_sighted, i.resolved_at, i.updated_at
from cs_issues i
join companies co on co.id = i.company_id;
