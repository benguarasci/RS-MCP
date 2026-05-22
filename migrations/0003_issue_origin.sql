-- 0003_issue_origin.sql — operator feedback loop columns on issues.
--   origin        — 'watcher' (conversation-watch detected) vs 'operator'
--                   (created by hand from the dashboard).
--   operator_note — free-text commentary the operator leaves for the next
--                   conversation-watch run. Kept separate from `notes` so it
--                   never collides with conversation-watch's own transition
--                   rationales: the watcher reads operator_note, never writes it.

create domain issue_origin as text check (value in ('watcher','operator'));

alter table issues
  add column origin issue_origin not null default 'watcher',
  add column operator_note text;

-- Rebuild v_issues to expose the new columns (appended after existing ones).
create or replace view v_issues as
select i.id, co.slug as company_slug, co.name as company,
       co.admin_id as company_admin_id, i.kind, i.status, i.severity,
       i.streak, i.clean_runs, i.summary, i.detection_signal,
       i.sample_convs, i.attributes, i.notes,
       cl.slug as cluster, i.cluster_id,
       i.first_sighted, i.last_sighted, i.resolved_at, i.updated_at,
       i.origin, i.operator_note
from issues i
join companies co on co.id = i.company_id
left join clusters cl on cl.id = i.cluster_id;
