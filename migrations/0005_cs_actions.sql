-- 0005_cs_actions.sql — per-conversation CS action queue for customer-watch.
-- Distinct from cs_issues (which tracks recurring patterns): each row here is
-- a one-shot recovery the operator should personally take on a specific
-- prospect / conversation. Status lives in the DB so the operator can mark
-- items resolved/dismissed and the email stops re-flagging them.

create domain cs_action_status as text check (value in ('open','resolved','dismissed'));

create table cs_actions (
  id              bigint generated always as identity primary key,
  company_id      bigint not null references companies(id),
  conversation_id integer not null,                    -- prod Conversation.id
  action_kind     text not null,                       -- failed-booking / dropped-thread / ai-confusion / unanswered-question / etc.
  summary         text not null,                       -- one sentence: what happened, what to do
  status          cs_action_status not null default 'open',
  sample_evidence jsonb not null default '[]'::jsonb,  -- relevant message IDs, appointment IDs, etc.
  notes           text,                                -- operator-owned commentary; this skill reads only
  first_flagged   timestamptz not null default now(),
  last_flagged    timestamptz not null default now(),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (conversation_id, action_kind)
);
create index on cs_actions (company_id, status);
create index on cs_actions (status, first_flagged desc);

create trigger trg_cs_actions_updated before update on cs_actions
  for each row execute function set_updated_at();

create view v_cs_actions as
select a.id, co.slug as company_slug, co.name as company,
       co.admin_id as company_admin_id, a.conversation_id, a.action_kind,
       a.summary, a.status, a.sample_evidence, a.notes,
       a.first_flagged, a.last_flagged, a.resolved_at, a.updated_at
from cs_actions a
join companies co on co.id = a.company_id;
