-- 0002_cluster_category.sql — failure-mode category tier above clusters.
-- Groups the ~47 clusters into 7 top-level failure modes so the dashboard and
-- reports can be scanned by category instead of cluster-by-cluster.
-- category is nullable: a cluster created before this tier existed, or one
-- created by a future run that hasn't assigned a category yet, surfaces as
-- "Uncategorized" rather than blocking the insert.

create domain issue_category as text check (value in (
  'fabrication',
  'stale-or-wrong-data',
  'unbacked-action-claims',
  'tool-and-pipeline-failures',
  'context-and-identity-loss',
  'dropped-or-blocked-conversations',
  'policy-and-safety-violations'
));

alter table clusters add column category issue_category;

-- Backfill the existing clusters by id (taxonomy approved 2026-05-22).
update clusters set category = 'fabrication'
  where id in (11, 13, 42, 44, 45);
update clusters set category = 'stale-or-wrong-data'
  where id in (2, 4, 6, 8, 16, 18, 19, 28, 34, 35, 43);
update clusters set category = 'unbacked-action-claims'
  where id in (5, 7, 17, 20, 26);
update clusters set category = 'tool-and-pipeline-failures'
  where id in (3, 9, 21, 23, 27, 29, 30, 31, 41, 47);
update clusters set category = 'context-and-identity-loss'
  where id in (10, 32, 36);
update clusters set category = 'dropped-or-blocked-conversations'
  where id in (14, 24, 25, 37, 38, 39, 40);
update clusters set category = 'policy-and-safety-violations'
  where id in (1, 12, 15, 22, 33, 46);

-- Rebuild v_clusters with category appended (create-or-replace allows
-- new columns only at the end of the select list).
create or replace view v_clusters as
select cl.id, cl.slug, cl.status, cl.severity, cl.streak, cl.inactive_runs,
       cl.description, cl.fix_rationale, cl.sample_convs, cl.attributes,
       count(i.id) as issue_count,
       count(distinct i.company_id) as company_count,
       coalesce(jsonb_agg(distinct co.name)
                filter (where co.name is not null), '[]'::jsonb) as companies,
       cl.resolved_at, cl.created_at, cl.updated_at,
       cl.category
from clusters cl
left join issues i on i.cluster_id = cl.id and i.status in ('open','monitoring')
left join companies co on co.id = i.company_id
group by cl.id;
