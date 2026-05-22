// views.js — all HTML rendering for the watch-system investigation dashboard.
// server.js handles routing + SQL; this module is purely presentational.

const APP_BASE_URL = process.env.APP_BASE_URL || "https://www.rentsimple.ai";

export const SEV_RANK = { high: 0, medium: 1, low: 2 };

// Failure-mode categories — the tier above clusters. Keys match the
// issue_category domain in migration 0002.
export const CATEGORIES = [
  { key: "fabrication", label: "Fabrication" },
  { key: "stale-or-wrong-data", label: "Stale / wrong data" },
  { key: "unbacked-action-claims", label: "Unbacked claims" },
  { key: "tool-and-pipeline-failures", label: "Tool & pipeline" },
  { key: "context-and-identity-loss", label: "Context & identity" },
  { key: "dropped-or-blocked-conversations", label: "Dropped / blocked" },
  { key: "policy-and-safety-violations", label: "Policy & safety" },
];
const CATEGORY_LABEL = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.label]),
);

const HEALTH_BLOCKS = "▁▂▃▄▅▆▇█";

// ---- helpers ---------------------------------------------------------------

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function ageDays(value) {
  if (!value) return "—";
  const d = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  return d <= 0 ? "today" : `${d}d`;
}

// Build an internal URL carrying the auth token.
export function href(token, path, params = {}) {
  const q = new URLSearchParams();
  if (token) q.set("token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

function convLinks(convs) {
  if (!Array.isArray(convs) || !convs.length) return '<span class="muted">—</span>';
  return (
    '<span class="convs">' +
    convs
      .map(
        (c) =>
          `<a href="${APP_BASE_URL}/admin/conversations?conversationId=${encodeURIComponent(c)}">#${esc(c)}</a>`,
      )
      .join(" ") +
    "</span>"
  );
}

function sparkline(series) {
  const vals = (series || []).filter((v) => v != null);
  if (vals.length < 2) return '<span class="mini muted">·</span>';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const s = series
    .map((v) => {
      if (v == null) return "·";
      if (hi === lo) return "▄";
      return HEALTH_BLOCKS[Math.round((7 * (v - lo)) / (hi - lo))];
    })
    .join("");
  return `<span class="mini">${s}</span>`;
}

function sevDot(sev) {
  return `<span class="dot s-${esc(sev)}"></span>`;
}

function pill(kind, text) {
  return `<span class="pill p-${esc(kind)}">${esc(text)}</span>`;
}

function originBadge(origin) {
  return origin === "operator"
    ? '<span class="badge">operator-added</span>'
    : "";
}

// Conversation-health score — buckets conversation-watch run stats into 7
// rolling 24h windows. Returns null when today's window has no data.
function computeHealth(cwRuns) {
  const now = Date.now();
  const DAY = 86400000;
  const windows = [];
  for (let w = 0; w < 7; w++) {
    const hi = now - w * DAY;
    const lo = hi - DAY;
    let processed = 0;
    let flagged = 0;
    let hasRun = false;
    for (const r of cwRuns || []) {
      const t = new Date(r.started_at).getTime();
      if (t > lo && t <= hi) {
        hasRun = true;
        processed += Number(r.stats && r.stats.processed) || 0;
        flagged += Number(r.stats && r.stats.flagged) || 0;
      }
    }
    windows.push(hasRun ? { processed, flagged } : null);
  }
  const w0 = windows[0];
  if (!w0 || w0.processed === 0) return null;
  const cleanPct = Math.round(
    (100 * (w0.processed - w0.flagged)) / w0.processed,
  );
  const w1 = windows[1];
  const yesterdayPct =
    w1 && w1.processed > 0
      ? Math.round((100 * (w1.processed - w1.flagged)) / w1.processed)
      : null;
  const rates = [];
  for (let w = 6; w >= 0; w--) {
    const win = windows[w];
    rates.push(win && win.processed > 0 ? win.flagged / win.processed : null);
  }
  const nonNull = rates.filter((r) => r != null);
  const lo = Math.min(...nonNull);
  const hi = Math.max(...nonNull);
  const spark = rates
    .map((r) => {
      if (r == null) return "·";
      if (hi === lo) return "▄";
      return HEALTH_BLOCKS[Math.round((7 * (r - lo)) / (hi - lo))];
    })
    .join("");
  return {
    cleanPct,
    processed: w0.processed,
    flagged: w0.flagged,
    yesterdayPct,
    spark,
  };
}

// ---- stylesheet ------------------------------------------------------------

const STYLES = `
  * { box-sizing:border-box; }
  body { margin:0; background:#f5f4ed; color:#2c2b27;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         line-height:1.5; font-size:14px; }
  a { color:#8a4a30; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .muted { color:#908b7e; }
  .app { display:flex; align-items:flex-start; }

  .rail { width:194px; flex:none; background:#efece1; border-right:1px solid #e0dbc9;
          padding:16px 13px; min-height:100vh; position:sticky; top:0; }
  .brand { font-family:Georgia,serif; font-size:17px; margin-bottom:12px; }
  .newbtn { display:block; text-align:center; background:#2c2b27; color:#f5f4ed;
            font-size:12px; padding:7px; border-radius:6px; margin-bottom:14px; }
  .newbtn:hover { text-decoration:none; background:#000; }
  .nav { display:block; font-size:13px; padding:5px 8px; border-radius:5px;
         margin-bottom:2px; color:#5f5b52; }
  .nav.on { background:#2c2b27; color:#f5f4ed; }
  .nav.soon { color:#aaa493; }
  .rail-lbl { font-size:9px; letter-spacing:.07em; text-transform:uppercase;
              color:#a09a89; margin:15px 0 5px; }
  .cat { display:flex; justify-content:space-between; font-size:12px;
         padding:4px 8px; border-radius:4px; color:#5f5b52; }
  .cat:hover { background:#e6e1cf; text-decoration:none; }
  .cat.on { background:#e6e1cf; font-weight:600; color:#2c2b27; }
  .cat .n { color:#a09a89; }
  .filters select, .filters input { width:100%; margin-bottom:6px; font-size:12px;
            padding:4px 6px; background:#fbfaf4; border:1px solid #ddd7c5;
            border-radius:4px; color:#3d3b35; }
  .filters button { width:100%; font-size:12px; padding:5px; border-radius:5px;
            border:1px solid #2c2b27; background:#2c2b27; color:#f5f4ed; cursor:pointer; }
  .filters .clear { display:block; text-align:center; font-size:11px; margin-top:6px; }

  .content { flex:1; padding:20px 26px 70px; max-width:1000px; }
  .crumb { font-size:12px; margin-bottom:12px; }
  h1 { font-family:Georgia,serif; font-weight:500; font-size:21px; margin:0 0 3px; }
  h2 { font-family:Georgia,serif; font-style:italic; font-weight:500; font-size:15px;
       margin:26px 0 9px; }
  .sec-lbl { font-size:9px; letter-spacing:.06em; text-transform:uppercase;
             color:#a09a89; margin:20px 0 6px; }
  .sub { color:#908b7e; font-size:12px; margin-bottom:14px; }
  .desc { font-size:13px; color:#3d3b35; margin:8px 0; }

  .pill { font-size:9px; letter-spacing:.04em; text-transform:uppercase;
          padding:2px 8px; border-radius:999px; font-weight:600; margin-right:5px;
          display:inline-block; }
  .p-open { background:#f0d9cc; color:#8a4a30; }
  .p-monitoring { background:#ede8d8; color:#807548; }
  .p-resolved { background:#dfecd5; color:#3d5c2b; }
  .p-dismissed { background:#e6e3da; color:#908b7e; }
  .p-high { background:#ecc8c0; color:#8c3527; }
  .p-medium { background:#f0d9cc; color:#8a4a30; }
  .p-low { background:#ede8d8; color:#807548; }
  .p-cat { background:#ece7d6; color:#807548; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%;
         margin-right:4px; vertical-align:middle; }
  .s-high { background:#8c3527; }
  .s-medium { background:#cc785c; }
  .s-low { background:#bdb48f; }
  .badge { font-size:8px; letter-spacing:.04em; text-transform:uppercase;
           background:#dce6ec; color:#3a5666; padding:1px 6px; border-radius:999px;
           margin-left:5px; }

  table.tbl { width:100%; border-collapse:collapse; background:#fbfaf4;
              border:1px solid #e3decf; border-radius:8px; overflow:hidden; }
  .tbl th { text-align:left; font-size:9px; letter-spacing:.05em;
            text-transform:uppercase; color:#a09a89; padding:8px 10px;
            background:#f3f1e6; border-bottom:1px solid #e3decf; }
  .tbl th a { color:#a09a89; }
  .tbl th a.on { color:#cc785c; }
  .tbl td { font-size:12px; padding:8px 10px; border-bottom:1px solid #efebdd;
            color:#3d3b35; vertical-align:top; }
  .tbl tr:last-child td { border-bottom:0; }
  .tbl tr.row:hover td { background:#f3f1e6; }
  .name { font-family:Georgia,serif; font-size:13px; color:#1f1e1c; }
  .convs { font-family:Menlo,Consolas,monospace; font-size:11px; }
  .mini { font-family:Menlo,Consolas,monospace; font-size:11px; color:#b0aa98;
          letter-spacing:1px; }
  .collapsed { font-size:12px; color:#908b7e; font-style:italic; }

  .health { background:#fbfaf4; border:1px solid #e3decf; border-left:3px solid #cc785c;
            border-radius:8px; padding:13px 15px; margin-bottom:16px; }
  .health .score { font-family:Georgia,serif; font-size:31px; font-weight:500;
                   color:#3d5c2b; line-height:1; vertical-align:middle; }
  .health .score.warn { color:#8a4a30; }
  .health .score.bad { color:#8c3527; }
  .health .score-label { font-size:13px; color:#3d3b35; margin-left:7px;
                         vertical-align:middle; }
  .health .health-detail { font-size:12px; color:#6e6c64; margin-top:5px; }
  .health .spark { font-family:Menlo,Consolas,monospace; font-size:14px;
                   letter-spacing:2px; color:#8a4a30; margin-top:6px; }
  .health .spark-cap { font-size:10px; color:#a09b8e; font-style:italic;
                       letter-spacing:0; }

  .op { background:#f1ece0; border:1px solid #ddd4bd; border-left:3px solid #6b8f5e;
        border-radius:8px; padding:14px 16px; margin-top:20px; }
  .op-h { font-size:10px; letter-spacing:.06em; text-transform:uppercase;
          color:#5d7350; font-weight:700; margin-bottom:9px; }
  .op form { display:inline; }
  .op .row { display:flex; gap:10px; }
  .op .fld { flex:1; margin-bottom:9px; }
  .op label { display:block; font-size:9px; letter-spacing:.05em;
              text-transform:uppercase; color:#807c72; margin-bottom:3px; }
  .op input, .op select, .op textarea { width:100%; background:#fbfaf4;
        border:1px solid #ddd4bd; border-radius:5px; font-size:12px;
        padding:6px 8px; color:#3d3b35; font-family:inherit; }
  .op textarea { min-height:54px; resize:vertical; }
  .op .btn { font-size:12px; padding:6px 13px; border-radius:5px; cursor:pointer;
             border:1px solid #c9bfa3; background:#fbfaf4; color:#3d3b35; margin-top:4px; }
  .op .btn.go { background:#2c2b27; color:#f5f4ed; border-color:#2c2b27; }
  .op .btn.danger { border-color:#d3a99e; color:#8c3527; }
  .op-note { font-size:10px; color:#8a8576; font-style:italic; margin-top:7px; }
  .op-err { font-size:12px; color:#8c3527; margin-bottom:9px; }
  .kv { font-size:12px; color:#6e6c64; margin:3px 0; }
  .kv b { color:#3d3b35; font-weight:600; }
`;

// ---- shell -----------------------------------------------------------------

function layout({
  token,
  page = "",
  title = "RS watch",
  categoryCounts = {},
  totalClusters = 0,
  filters = {},
  breadcrumb = "",
  body = "",
}) {
  const lk = (path, params) => href(token, path, params);

  const catLink = (key, label, count) => {
    const on =
      (key === "" && !filters.category) || filters.category === key;
    return `<a class="cat${on ? " on" : ""}" href="${lk(
      "/dashboard",
      key ? { category: key } : {},
    )}">${esc(label)} <span class="n">${count}</span></a>`;
  };
  const catList = [catLink("", "All", totalClusters)]
    .concat(
      CATEGORIES.map((c) => catLink(c.key, c.label, categoryCounts[c.key] || 0)),
    )
    .join("");

  const sevOpts = ["", "high", "medium", "low"]
    .map(
      (v) =>
        `<option value="${v}"${filters.severity === v ? " selected" : ""}>${
          v || "any severity"
        }</option>`,
    )
    .join("");
  const statusOpts = ["", "open", "monitoring", "resolved", "dismissed"]
    .map(
      (v) =>
        `<option value="${v}"${filters.status === v ? " selected" : ""}>${
          v || "any status"
        }</option>`,
    )
    .join("");
  const anyFilter =
    filters.category ||
    filters.severity ||
    filters.status ||
    filters.company ||
    filters.q;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>${STYLES}</style></head>
<body><div class="app">
  <aside class="rail">
    <div class="brand">RS watch</div>
    <a class="newbtn" href="${lk("/issue/new")}">+ New issue</a>
    <a class="nav${page === "dashboard" ? " on" : ""}" href="${lk("/dashboard")}">Overview</a>
    <span class="nav soon">Trends &middot; soon</span>
    <span class="nav soon">Companies &middot; soon</span>
    <div class="rail-lbl">Categories</div>
    ${catList}
    <div class="rail-lbl">Filters</div>
    <form class="filters" method="get" action="/dashboard">
      <input type="hidden" name="token" value="${esc(token)}"/>
      <input type="hidden" name="category" value="${esc(filters.category || "")}"/>
      <select name="severity">${sevOpts}</select>
      <select name="status">${statusOpts}</select>
      <input type="text" name="q" placeholder="search kind / summary…" value="${esc(filters.q || "")}"/>
      <input type="text" name="company" placeholder="company slug…" value="${esc(filters.company || "")}"/>
      <button type="submit">Apply</button>
      ${anyFilter ? `<a class="clear" href="${lk("/dashboard")}">clear filters</a>` : ""}
    </form>
  </aside>
  <main class="content">
    ${breadcrumb ? `<div class="crumb">${breadcrumb}</div>` : ""}
    ${body}
  </main>
</div></body></html>`;
}

// ---- dashboard -------------------------------------------------------------

export function renderDashboard({
  token,
  clusters,
  resolved,
  cwRuns,
  snapshotSeries,
  categoryCounts,
  totalClusters,
  filters,
}) {
  const lk = (path, params) => href(token, path, params);
  const health = computeHealth(cwRuns);
  const highAlert = clusters.filter((c) => c.severity === "high").length;
  const openCount = clusters.filter((c) => c.status === "open").length;

  let healthBlock;
  if (!health) {
    healthBlock = `<div class="health"><div class="health-detail">Conversation-health score unavailable — no conversation-watch runs in the last 24h.</div></div>`;
  } else {
    let cls = "";
    if (health.cleanPct < 93) cls = "bad";
    else if (health.cleanPct < 97) cls = "warn";
    if (highAlert > 0 && cls === "") cls = "warn";
    const posture =
      highAlert > 0
        ? `${highAlert} HIGH ALERT cluster${highAlert > 1 ? "s" : ""}`
        : openCount > 0
          ? `${openCount} OPEN cluster${openCount > 1 ? "s" : ""}`
          : "clusters steady";
    const yest =
      health.yesterdayPct != null
        ? ` &middot; yesterday ${health.yesterdayPct}%`
        : "";
    healthBlock = `<div class="health">
      <span class="score${cls ? " " + cls : ""}">${health.cleanPct}%</span>
      <span class="score-label">conversations clean today</span>
      <div class="health-detail">${health.flagged} of ${health.processed} conversation checks flagged &middot; ${esc(posture)}${yest}</div>
      <div class="spark">${esc(health.spark)} <span class="spark-cap">flag rate &middot; last 7 days &middot; newest right</span></div>
    </div>`;
  }

  const issueTotal = clusters.reduce(
    (n, c) => n + Number(c.issue_count || 0),
    0,
  );
  const sortHead = (col, label) => {
    const on = (filters.sort || "issues") === col;
    return `<th><a class="${on ? "on" : ""}" href="${lk("/dashboard", {
      ...filters,
      sort: col,
    })}">${esc(label)}${on ? " ▾" : ""}</a></th>`;
  };

  const row = (c) => `
      <tr class="row" onclick="location='${lk("/cluster/" + c.id)}'" style="cursor:pointer">
        <td><a class="name" href="${lk("/cluster/" + c.id)}">${esc(c.slug)}</a></td>
        <td class="muted">${esc(CATEGORY_LABEL[c.category] || c.category || "—")}</td>
        <td>${sevDot(c.severity)}${esc(c.severity)}</td>
        <td>${pill(c.status, c.status)}</td>
        <td>${esc(c.company_count)}</td>
        <td><b>${esc(c.issue_count)}</b></td>
        <td>${esc(c.streak)}</td>
        <td>${sparkline(snapshotSeries[c.id])}</td>
      </tr>`;

  const table = clusters.length
    ? `<table class="tbl">
      <tr>
        ${sortHead("slug", "Cluster")}
        ${sortHead("category", "Category")}
        ${sortHead("severity", "Sev")}
        ${sortHead("status", "Status")}
        ${sortHead("companies", "Cos")}
        ${sortHead("issues", "Issues")}
        ${sortHead("streak", "Streak")}
        <th>14-day</th>
      </tr>
      ${clusters.map(row).join("")}
    </table>`
    : `<p class="sub">No clusters match these filters.</p>`;

  const resolvedList = resolved.length
    ? `<h2>Resolved clusters (${resolved.length})</h2>
       <table class="tbl">${resolved
         .map(
           (c) =>
             `<tr class="row"><td><a class="name" href="${lk("/cluster/" + c.id)}">${esc(c.slug)}</a></td><td class="muted">resolved ${fmtDate(c.resolved_at)}</td></tr>`,
         )
         .join("")}</table>`
    : "";

  const body = `
    <h1>Overview</h1>
    ${healthBlock}
    <div class="sub">${clusters.length} clusters &middot; ${issueTotal} active issues &middot; sorted by ${esc(filters.sort || "issues")}</div>
    ${table}
    ${resolvedList}`;

  return layout({
    token,
    page: "dashboard",
    title: "RS watch — overview",
    categoryCounts,
    totalClusters,
    filters,
    body,
  });
}

// ---- cluster detail --------------------------------------------------------

export function renderCluster({
  token,
  cluster,
  issues,
  snapshots,
  categoryCounts,
  totalClusters,
}) {
  const lk = (path, params) => href(token, path, params);
  const active = issues.filter(
    (i) => i.status === "open" || i.status === "monitoring",
  );
  const inactive = issues.filter(
    (i) => i.status !== "open" && i.status !== "monitoring",
  );

  const issueRow = (i) => `
      <tr class="row" onclick="location='${lk("/issue/" + i.id)}'" style="cursor:pointer">
        <td><a class="name" href="${lk("/issue/" + i.id)}">${esc(i.kind)}</a>${originBadge(i.origin)}</td>
        <td><a href="${lk("/company/" + i.company_slug)}">${esc(i.company)}</a></td>
        <td>${sevDot(i.severity)}${esc(i.severity)}</td>
        <td>${pill(i.status, i.status)}</td>
        <td>${esc(i.streak)}</td>
        <td>${convLinks(i.sample_convs)}</td>
      </tr>`;

  const snapRows = snapshots.length
    ? snapshots
        .map(
          (s) =>
            `<tr><td>${fmtDate(s.captured_at)}</td><td>${pill(s.status, s.status)}</td><td>${esc(s.company_count)}</td><td>${esc(s.issue_count)}</td><td class="muted">${esc(s.note || "—")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No snapshots yet.</td></tr>`;

  const body = `
    <h1>${esc(cluster.slug)}</h1>
    <div style="margin:6px 0 2px">
      ${pill(cluster.severity, cluster.severity)}
      ${pill(cluster.status, cluster.status)}
      ${pill("cat", CATEGORY_LABEL[cluster.category] || cluster.category || "uncategorized")}
    </div>
    <div class="kv">${esc(cluster.company_count)} customers &middot; ${esc(cluster.issue_count)} active issues &middot; streak ${esc(cluster.streak)} &middot; ${esc(cluster.inactive_runs)} quiet runs</div>
    <p class="desc">${esc(cluster.description)}</p>
    ${cluster.fix_rationale ? `<p class="desc muted">${esc(cluster.fix_rationale)}</p>` : ""}

    <div class="sec-lbl">Snapshot history</div>
    <table class="tbl">
      <tr><th>Run</th><th>Status</th><th>Customers</th><th>Issues</th><th>Note</th></tr>
      ${snapRows}
    </table>

    <div class="sec-lbl">Member issues — ${active.length} active</div>
    <table class="tbl">
      <tr><th>Issue</th><th>Customer</th><th>Sev</th><th>Status</th><th>Streak</th><th>Conversations</th></tr>
      ${active.map(issueRow).join("") || '<tr><td colspan="6" class="muted">No active issues.</td></tr>'}
      ${
        inactive.length
          ? inactive.map(issueRow).join("")
          : ""
      }
    </table>`;

  return layout({
    token,
    title: `cluster — ${cluster.slug}`,
    categoryCounts,
    totalClusters,
    filters: {},
    breadcrumb: `<a href="${lk("/dashboard")}">← Overview</a> / ${esc(
      CATEGORY_LABEL[cluster.category] || "cluster",
    )}`,
    body,
  });
}

// ---- company detail --------------------------------------------------------

export function renderCompany({
  token,
  company,
  issues,
  clusterMeta,
  categoryCounts,
  totalClusters,
}) {
  const lk = (path, params) => href(token, path, params);
  const active = issues.filter(
    (i) => i.status === "open" || i.status === "monitoring",
  );
  const highCount = active.filter((i) => i.severity === "high").length;

  // Group active issues by category (via their cluster).
  const groups = new Map();
  for (const i of active) {
    const meta = clusterMeta.get(i.cluster_id);
    const cat = meta ? meta.category : null;
    const label = CATEGORY_LABEL[cat] || "Unclustered";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  }

  const issueRow = (i) => `
      <tr class="row" onclick="location='${lk("/issue/" + i.id)}'" style="cursor:pointer">
        <td><a class="name" href="${lk("/issue/" + i.id)}">${esc(i.kind)}</a>${originBadge(i.origin)}</td>
        <td>${i.cluster ? `<a href="${lk("/cluster/" + i.cluster_id)}">${esc(i.cluster)}</a>` : '<span class="muted">—</span>'}</td>
        <td>${sevDot(i.severity)}${esc(i.severity)}</td>
        <td>${pill(i.status, i.status)}</td>
        <td>${convLinks(i.sample_convs)}</td>
      </tr>`;

  const sections = [...groups.entries()]
    .map(
      ([label, list]) => `
    <div class="sec-lbl">${esc(label)} — ${list.length}</div>
    <table class="tbl">
      <tr><th>Issue</th><th>Cluster</th><th>Sev</th><th>Status</th><th>Conversations</th></tr>
      ${list.map(issueRow).join("")}
    </table>`,
    )
    .join("");

  const adminLink = company.admin_id
    ? ` &middot; <a href="${APP_BASE_URL}/admin/companies/${esc(company.admin_id)}">admin ↗</a>`
    : "";

  const body = `
    <h1>${esc(company.name)}</h1>
    <div class="kv">${active.length} active issues &middot; ${highCount} high-severity${adminLink}</div>
    ${sections || '<p class="sub">No active issues for this customer.</p>'}`;

  return layout({
    token,
    title: `company — ${company.name}`,
    categoryCounts,
    totalClusters,
    filters: {},
    breadcrumb: `<a href="${lk("/dashboard")}">← Overview</a> / ${esc(company.name)}`,
    body,
  });
}

// ---- issue detail ----------------------------------------------------------

export function renderIssue({
  token,
  issue,
  categoryCounts,
  totalClusters,
}) {
  const lk = (path, params) => href(token, path, params);
  const dismissed = issue.status === "dismissed";

  const opPanel = `
    <div class="op">
      <div class="op-h">⬡ Operator review</div>
      ${
        dismissed
          ? `<p class="kv">This issue is marked a non-issue — conversation-watch will not re-open it.</p>`
          : `<form method="post" action="${lk("/issue/" + issue.id + "/dismiss")}">
               <button class="btn danger" type="submit">Mark as non-issue</button>
             </form>`
      }
      <form method="post" action="${lk("/issue/" + issue.id + "/note")}" style="display:block;margin-top:10px">
        <label>Commentary for the next conversation-watch run</label>
        <textarea name="operator_note" placeholder="Context, what to ignore, what to look closer at…">${esc(issue.operator_note || "")}</textarea>
        <button class="btn go" type="submit">Save note</button>
      </form>
      <div class="op-note">conversation-watch reads this commentary before its next pass.</div>
    </div>`;

  const body = `
    <h1>${esc(issue.kind)}${originBadge(issue.origin)}</h1>
    <div style="margin:6px 0 2px">
      ${pill(issue.severity, issue.severity)}
      ${pill(issue.status, issue.status)}
      <a href="${lk("/company/" + issue.company_slug)}">${esc(issue.company)}</a>
    </div>
    <div class="kv">streak ${esc(issue.streak)} &middot; ${esc(issue.clean_runs)} clean runs &middot; first sighted ${fmtDate(issue.first_sighted)} &middot; last sighted ${fmtDate(issue.last_sighted)} &middot; age ${ageDays(issue.first_sighted)}${issue.resolved_at ? ` &middot; resolved ${fmtDate(issue.resolved_at)}` : ""}</div>
    <div class="kv">cluster: ${issue.cluster ? `<a href="${lk("/cluster/" + issue.cluster_id)}">${esc(issue.cluster)}</a>` : '<span class="muted">unclustered</span>'} &middot; origin: ${esc(issue.origin)}</div>

    <div class="sec-lbl">Summary</div>
    <p class="desc">${esc(issue.summary)}</p>

    ${
      issue.detection_signal
        ? `<div class="sec-lbl">Detection signal</div><p class="desc">${esc(issue.detection_signal)}</p>`
        : ""
    }

    <div class="sec-lbl">Conversations</div>
    <p class="desc">${convLinks(issue.sample_convs)}</p>

    ${
      issue.notes
        ? `<div class="sec-lbl">Watcher log</div><p class="desc muted">${esc(issue.notes)}</p>`
        : ""
    }

    ${opPanel}`;

  const crumb =
    `<a href="${lk("/dashboard")}">← Overview</a>` +
    (issue.cluster
      ? ` / <a href="${lk("/cluster/" + issue.cluster_id)}">${esc(issue.cluster)}</a>`
      : "") +
    ` / <a href="${lk("/company/" + issue.company_slug)}">${esc(issue.company)}</a>`;

  return layout({
    token,
    title: `issue — ${issue.kind}`,
    categoryCounts,
    totalClusters,
    filters: {},
    breadcrumb: crumb,
    body,
  });
}

// ---- new-issue form --------------------------------------------------------

export function renderNewIssueForm({
  token,
  companies,
  categoryCounts,
  totalClusters,
  error,
  values = {},
}) {
  const lk = (path, params) => href(token, path, params);
  const companyOpts = companies
    .map(
      (c) =>
        `<option value="${esc(c.slug)}"${values.company === c.slug ? " selected" : ""}>${esc(c.name)}</option>`,
    )
    .join("");
  const sevOpts = ["medium", "high", "low"]
    .map(
      (v) =>
        `<option value="${v}"${values.severity === v ? " selected" : ""}>${v}</option>`,
    )
    .join("");

  const body = `
    <h1>Add an issue to monitor</h1>
    <p class="sub">conversation-watch will track whether this keeps firing on each run.</p>
    <div class="op">
      <div class="op-h">⬡ New operator issue</div>
      ${error ? `<div class="op-err">${esc(error)}</div>` : ""}
      <form method="post" action="${lk("/issue")}">
        <div class="row">
          <div class="fld"><label>Company</label><select name="company">${companyOpts}</select></div>
          <div class="fld"><label>Kind (slug)</label><input type="text" name="kind" value="${esc(values.kind || "")}" placeholder="missing-parking-disclosure"/></div>
        </div>
        <div class="fld"><label>Summary</label><textarea name="summary" placeholder="What the AI is doing wrong…">${esc(values.summary || "")}</textarea></div>
        <div class="row">
          <div class="fld"><label>Severity</label><select name="severity">${sevOpts}</select></div>
          <div class="fld"><label>Example conversations (comma-separated IDs)</label><input type="text" name="sample_convs" value="${esc(values.sample_convs || "")}" placeholder="8701, 8702"/></div>
        </div>
        <button class="btn go" type="submit">Create issue</button>
      </form>
      <div class="op-note">Tagged operator-added. Identity is company + kind — a duplicate is rejected.</div>
    </div>`;

  return layout({
    token,
    title: "RS watch — new issue",
    categoryCounts,
    totalClusters,
    filters: {},
    breadcrumb: `<a href="${lk("/dashboard")}">← Overview</a> / New issue`,
    body,
  });
}

// ---- not found -------------------------------------------------------------

export function renderNotFound({ token, what, categoryCounts, totalClusters }) {
  const lk = (path, params) => href(token, path, params);
  return layout({
    token,
    title: "RS watch — not found",
    categoryCounts: categoryCounts || {},
    totalClusters: totalClusters || 0,
    filters: {},
    breadcrumb: `<a href="${lk("/dashboard")}">← Overview</a>`,
    body: `<h1>Not found</h1><p class="sub">${esc(what || "That record does not exist.")}</p>`,
  });
}
