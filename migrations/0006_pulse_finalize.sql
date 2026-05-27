-- 0006_pulse_finalize.sql — push daily-pulse aggregation into SQL.
--
-- Before: the skill computed per-cluster (status, severity, streak,
-- inactive_runs, companies, note) in chat and emitted a 50-cluster
-- multi-row INSERT for cluster_snapshots. The VALUES list alone was tens
-- of thousands of tokens of model output per run.
--
-- After: the model reassigns unassigned issues (the only thing it can do)
-- and calls pulse_finalize(run_id). The function reads the current state
-- from issues + companies, diffs it against the last snapshot per cluster,
-- writes the new cluster state, inserts one snapshot row per cluster with
-- a computed history annotation, and closes the run. Returns a stats jsonb
-- the dashboard reads as runs.stats.

create or replace function pulse_finalize(p_run_id bigint) returns jsonb as $$
declare
  v_stats jsonb;
begin
  with curr as (
    -- Per-cluster current state, computed from active issues.
    select
      cl.id                                                                   as cluster_id,
      cl.slug,
      cl.status                                                               as prev_status,
      cl.severity                                                             as prev_sev,
      cl.streak                                                               as prev_streak,
      cl.inactive_runs                                                        as prev_inact,
      cl.resolved_at                                                          as prev_resolved_at,
      count(i.id)             filter (where i.status in ('open','monitoring')) as issue_count,
      count(distinct i.company_id)
                              filter (where i.status in ('open','monitoring')) as company_count,
      coalesce(
        jsonb_agg(distinct co.name order by co.name)
          filter (where co.name is not null and i.status in ('open','monitoring')),
        '[]'::jsonb
      )                                                                       as companies,
      coalesce(bool_or(i.severity = 'high')
                              filter (where i.status in ('open','monitoring')), false) as has_high,
      coalesce(bool_or(i.severity = 'medium')
                              filter (where i.status in ('open','monitoring')), false) as has_medium,
      coalesce(bool_or(i.status = 'open'), false)                              as has_open
    from clusters cl
    left join issues    i  on i.cluster_id = cl.id
    left join companies co on co.id = i.company_id
    group by cl.id
  ),
  last_snap as (
    -- Most recent snapshot per cluster — what we diff against for the note.
    select distinct on (cluster_id) cluster_id, companies as prev_companies
    from cluster_snapshots
    order by cluster_id, captured_at desc
  ),
  computed as (
    select
      c.*,
      ls.prev_companies,
      case
        when c.issue_count = 0 and c.prev_status <> 'resolved' then c.prev_inact + 1
        else 0
      end as new_inact
    from curr c
    left join last_snap ls on ls.cluster_id = c.cluster_id
  ),
  derived as (
    select
      cmp.*,
      case
        when cmp.issue_count = 0 and cmp.prev_status = 'resolved' then 'resolved'
        when cmp.issue_count = 0 and cmp.new_inact >= 7            then 'resolved'
        when cmp.issue_count = 0                                   then cmp.prev_status
        when cmp.has_open                                          then 'open'
        else                                                            'monitoring'
      end as new_status,
      case
        when cmp.issue_count = 0   then cmp.prev_sev
        when cmp.has_high          then 'high'
        when cmp.has_medium        then 'medium'
        else                            'low'
      end as new_severity,
      case
        when cmp.issue_count = 0          then cmp.prev_streak
        when cmp.prev_status = 'resolved' then 1
        else                                   cmp.prev_streak + 1
      end as new_streak,
      (
        select coalesce(array_agg(x order by x), '{}'::text[])
        from (
          select jsonb_array_elements_text(cmp.companies) as x
          except
          select jsonb_array_elements_text(coalesce(cmp.prev_companies, '[]'::jsonb))
        ) j
      ) as joined,
      (
        select coalesce(array_agg(x order by x), '{}'::text[])
        from (
          select jsonb_array_elements_text(coalesce(cmp.prev_companies, '[]'::jsonb)) as x
          except
          select jsonb_array_elements_text(cmp.companies)
        ) d
      ) as departed
    from computed cmp
  ),
  with_note as (
    select
      d.*,
      case
        when d.prev_companies is null and d.issue_count > 0 then
          'NEW today — ' || d.company_count || ' customers, ' || d.issue_count || ' issues'
        when d.issue_count = 0 and d.prev_status = 'resolved' then
          'stayed resolved'
        when d.issue_count = 0 and d.new_status = 'resolved' then
          'resolved — inactive ' || d.new_inact || ' runs'
        when d.issue_count = 0 then
          'quiet this run; inactive_runs=' || d.new_inact
        when d.prev_status = 'resolved' then
          'regressed; ' || d.company_count || ' customers, ' || d.issue_count || ' issues'
        when cardinality(d.joined) = 0 and cardinality(d.departed) = 0 then
          'steady ' || d.new_streak || ' runs'
        when cardinality(d.joined) > 0 and cardinality(d.departed) = 0 then
          '+' || array_to_string(d.joined, ', ') ||
          '; ' || d.issue_count || ' issues; streak ' || d.new_streak
        when cardinality(d.joined) = 0 and cardinality(d.departed) > 0 then
          '-' || array_to_string(d.departed, ', ') ||
          '; ' || d.issue_count || ' issues; streak ' || d.new_streak
        else
          '+' || array_to_string(d.joined, ', ') ||
          ' -' || array_to_string(d.departed, ', ') ||
          '; ' || d.issue_count || ' issues; streak ' || d.new_streak
      end as note
    from derived d
  ),
  do_update as (
    update clusters cl
    set status        = wn.new_status::cluster_status,
        severity      = wn.new_severity::severity_level,
        streak        = wn.new_streak,
        inactive_runs = wn.new_inact,
        resolved_at   = case
          when wn.new_status = 'resolved' and cl.resolved_at is null then now()
          when wn.new_status <> 'resolved'                           then null
          else cl.resolved_at
        end
    from with_note wn
    where cl.id = wn.cluster_id
    returning 1
  ),
  do_insert as (
    insert into cluster_snapshots (cluster_id, run_id, status, severity, streak,
                                    company_count, issue_count, companies, note)
    select wn.cluster_id, p_run_id, wn.new_status::cluster_status,
           wn.new_severity::severity_level, wn.new_streak,
           wn.company_count, wn.issue_count, wn.companies, wn.note
    from with_note wn
    returning 1
  )
  select jsonb_build_object(
    'active_clusters',  count(*) filter (where issue_count > 0),
    'active_issues',    coalesce(sum(issue_count) filter (where issue_count > 0), 0),
    'customers',        (select count(distinct co.name)
                         from issues i join companies co on co.id = i.company_id
                         where i.status in ('open','monitoring')),
    'high_alert',       count(*) filter (where new_severity = 'high' and issue_count > 0),
    'open_pill',        count(*) filter (where new_status = 'open'
                                         and issue_count > 0
                                         and new_severity <> 'high'),
    'monitoring_pill',  count(*) filter (where new_status = 'monitoring'
                                         and issue_count > 0
                                         and new_severity <> 'high'),
    'new_clusters',     count(*) filter (where prev_companies is null and issue_count > 0),
    'resolved_runs',    count(*) filter (where new_status = 'resolved'
                                         and prev_status <> 'resolved'),
    'regressions',      count(*) filter (where prev_status = 'resolved' and issue_count > 0),
    'quiet_clusters',   count(*) filter (where issue_count = 0 and prev_status <> 'resolved'),
    'updated_rows',     (select count(*) from do_update),
    'inserted_rows',    (select count(*) from do_insert)
  )
  into v_stats
  from with_note;

  update runs
  set status      = 'succeeded',
      finished_at = now(),
      summary     = 'Run ' || p_run_id || ': ' ||
                    (v_stats->>'active_clusters') || ' active clusters, ' ||
                    (v_stats->>'high_alert') || ' HIGH ALERT, ' ||
                    (v_stats->>'new_clusters') || ' new, ' ||
                    (v_stats->>'resolved_runs') || ' resolved',
      stats       = v_stats
  where id = p_run_id;

  return v_stats;
end;
$$ language plpgsql;
