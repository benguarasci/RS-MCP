import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const STATE_DATABASE_URL = process.env.STATE_DATABASE_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PORT = Number(process.env.PORT) || 8080;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!AUTH_TOKEN) throw new Error("AUTH_TOKEN is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

// Separate pool for the watch-system state DB. Optional so the prod tools
// still boot if STATE_DATABASE_URL hasn't been wired up yet.
// ssl:false — Fly Postgres over the private .flycast network has no TLS.
const statePool = STATE_DATABASE_URL
  ? new Pool({
      connectionString: STATE_DATABASE_URL,
      ssl: false,
      max: 4,
    })
  : null;

const mailer =
  SMTP_HOST && SMTP_USER && SMTP_PASSWORD
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      })
    : null;

const INTERNAL_RECIPIENTS = [
  "ben@rentsimple.ai",
  "tarush@rentsimple.ai",
  "charlie@rentsimple.ai",
  "camus@rentsimple.ai",
];

function buildMcpServer() {
  const server = new McpServer({ name: "neon-postgres", version: "0.1.0" });

  server.registerTool(
    "query",
    {
      title: "Run a read-only SQL query",
      description:
        "Executes SQL inside a READ ONLY transaction against the Postgres database. Writes are rejected by the database. Returns rows as JSON.",
      inputSchema: { sql: z.string().describe("The SQL statement to run") },
    },
    async ({ sql }) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const result = await client.query(sql);
        await client.query("COMMIT");
        return {
          content: [
            { type: "text", text: JSON.stringify(result.rows, null, 2) },
          ],
        };
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch {}
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables in the database",
      description: "Returns user tables with their schema.",
      inputSchema: {},
    },
    async () => {
      const result = await pool.query(
        `SELECT table_schema, table_name
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name`,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an internal email",
      description:
        "Sends an email to the hardcoded internal team distribution list. Recipients are fixed in code and cannot be specified by the caller.",
      inputSchema: {
        subject: z.string().describe("Email subject"),
        text: z.string().optional().describe("Plain text body"),
        html: z.string().optional().describe("HTML body"),
      },
    },
    async ({ subject, text, html }) => {
      if (!mailer) {
        return {
          content: [
            {
              type: "text",
              text: "Error: email is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASSWORD).",
            },
          ],
          isError: true,
        };
      }
      if (!EMAIL_FROM) {
        return {
          content: [
            { type: "text", text: "Error: EMAIL_FROM env var is not set." },
          ],
          isError: true,
        };
      }
      if (!text && !html) {
        return {
          content: [
            { type: "text", text: "Error: provide `text` or `html` body." },
          ],
          isError: true,
        };
      }
      try {
        const info = await mailer.sendMail({
          from: EMAIL_FROM,
          to: INTERNAL_RECIPIENTS,
          subject,
          text,
          html,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { messageId: info.messageId, accepted: info.accepted },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "state_query",
    {
      title: "Query the watch-state database",
      description:
        "Executes SQL (reads and writes) against the watch-system state database — the issues, clusters, runs and snapshot tables. Separate from the read-only prod `query` tool. Runs inside a transaction and rolls back on error. Returns result rows as JSON.",
      inputSchema: { sql: z.string().describe("The SQL statement to run") },
    },
    async ({ sql }) => {
      if (!statePool) {
        return {
          content: [
            {
              type: "text",
              text: "Error: STATE_DATABASE_URL is not configured.",
            },
          ],
          isError: true,
        };
      }
      const client = await statePool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(sql);
        await client.query("COMMIT");
        const payload =
          result.rows && result.rows.length
            ? result.rows
            : { command: result.command, rowCount: result.rowCount };
        return {
          content: [
            { type: "text", text: JSON.stringify(payload, null, 2) },
          ],
        };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      } finally {
        client.release();
      }
    },
  );

  return server;
}

const SEV_RANK = { high: 0, medium: 1, low: 2 };

// Failure-mode categories — the top tier above clusters. Order here is the
// tab order on the dashboard. Keys match the issue_category domain in
// migration 0002. Clusters with a null/unknown category fall into an
// "Uncategorized" tab appended at runtime.
const CATEGORIES = [
  { key: "fabrication", label: "Fabrication" },
  { key: "stale-or-wrong-data", label: "Stale / wrong data" },
  { key: "unbacked-action-claims", label: "Unbacked claims" },
  { key: "tool-and-pipeline-failures", label: "Tool & pipeline" },
  { key: "context-and-identity-loss", label: "Context & identity" },
  { key: "dropped-or-blocked-conversations", label: "Dropped / blocked" },
  { key: "policy-and-safety-violations", label: "Policy & safety" },
];

// Base URL for admin deep-links (company + conversation pages).
const APP_BASE_URL = process.env.APP_BASE_URL || "https://www.rentsimple.ai";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(value) {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Conversation-health score — buckets conversation-watch run stats into 7
// rolling 24h windows, mirroring daily-pulse Step 1e. Returns null when
// today's window has no data (no score this render).
const HEALTH_BLOCKS = "▁▂▃▄▅▆▇█";

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
    for (const r of cwRuns) {
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
  // Flag rates oldest -> newest (window 6 -> window 0) for the sparkline.
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

function renderDashboard(clusters, issues, runs, cwRuns) {
  const issuesByCluster = new Map();
  const unclustered = [];
  for (const issue of issues) {
    if (issue.cluster_id == null) {
      if (issue.status !== "resolved" && issue.status !== "dismissed") {
        unclustered.push(issue);
      }
      continue;
    }
    if (!issuesByCluster.has(issue.cluster_id)) {
      issuesByCluster.set(issue.cluster_id, []);
    }
    issuesByCluster.get(issue.cluster_id).push(issue);
  }

  const bySeverity = (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity];
  const active = clusters
    .filter((c) => c.status !== "resolved")
    .sort(bySeverity);
  const resolved = clusters.filter((c) => c.status === "resolved");

  // Group active clusters into category tabs. Anything with a null or unknown
  // category lands in an "Uncategorized" tab appended only when non-empty.
  const knownKeys = new Set(CATEGORIES.map((c) => c.key));
  const tabs = CATEGORIES.map((cat) => ({
    key: cat.key,
    label: cat.label,
    clusters: active.filter((c) => c.category === cat.key),
  }));
  const uncategorized = active.filter((c) => !knownKeys.has(c.category));
  if (uncategorized.length) {
    tabs.push({
      key: "uncategorized",
      label: "Uncategorized",
      clusters: uncategorized,
    });
  }
  // Default to the first tab that actually has clusters.
  const activeTabIdx = Math.max(
    0,
    tabs.findIndex((t) => t.clusters.length),
  );

  // Render an issue's sample conversations as deep-links to the admin
  // conversation viewer. sample_convs is a jsonb array of conversation IDs.
  const convLinks = (convs) => {
    if (!Array.isArray(convs) || !convs.length) return "";
    return (
      ' <span class="convs">' +
      convs
        .map(
          (c) =>
            `<a href="${APP_BASE_URL}/admin/conversations?conversationId=${encodeURIComponent(c)}">#${esc(c)}</a>`,
        )
        .join(" ") +
      "</span>"
    );
  };

  const issueRow = (i) => `
        <li>
          <span class="dot sev-${esc(i.severity)}"></span>
          <b>${esc(i.company)}</b> &middot; ${esc(i.kind)}
          <span class="muted">${esc(i.status)} &middot; streak ${esc(i.streak)}</span>${convLinks(i.sample_convs)}
        </li>`;

  const clusterCard = (c) => {
    const list = (issuesByCluster.get(c.id) || [])
      .slice()
      .sort(bySeverity)
      .map(issueRow)
      .join("");
    return `
      <div class="card">
        <div class="card-head">
          <span class="name">${esc(c.slug)}</span>
          <span class="pill st-${esc(c.status)}">${esc(c.status)}</span>
          <span class="pill sv-${esc(c.severity)}">${esc(c.severity)}</span>
        </div>
        <div class="muted meta">${esc(c.company_count)} companies &middot; ${esc(c.issue_count)} active issues &middot; streak ${esc(c.streak)}</div>
        <p class="desc">${esc(c.description)}</p>
        <ul class="issues">${list || '<li class="muted">no linked issues</li>'}</ul>
      </div>`;
  };

  const runLine =
    runs.length > 0
      ? runs
          .map((r) => `${esc(r.layer)} ${fmtTime(r.last_run)}`)
          .join("  &middot;  ")
      : "no successful runs recorded yet";

  // Conversation-health block — the percentage overview from the email.
  const health = computeHealth(cwRuns || []);
  const highAlert = active.filter((c) => c.severity === "high").length;
  const openCount = active.filter((c) => c.status === "open").length;
  let healthBlock;
  if (!health) {
    healthBlock = `
  <div class="health">
    <div class="health-detail">Conversation-health score unavailable — no conversation-watch runs in the last 24h.</div>
  </div>`;
  } else {
    let scoreClass = "";
    if (health.cleanPct < 93) scoreClass = "bad";
    else if (health.cleanPct < 97) scoreClass = "warn";
    if (highAlert > 0 && scoreClass === "") scoreClass = "warn";
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
    healthBlock = `
  <div class="health">
    <span class="score${scoreClass ? " " + scoreClass : ""}">${health.cleanPct}%</span>
    <span class="score-label">conversations clean today</span>
    <div class="health-detail">${health.flagged} of ${health.processed} conversation checks flagged &middot; ${esc(posture)}${yest}</div>
    <div class="spark">${health.spark} <span class="spark-cap">flag rate &middot; last 7 days &middot; newest right</span></div>
  </div>`;
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>RS watch — issues</title>
<style>
  body { margin:0; padding:28px 16px 80px; background:#f5f4ed; color:#2c2b27;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.55; }
  .wrap { max-width:720px; margin:0 auto; }
  h1 { font-family:Georgia,serif; font-weight:500; font-size:23px; margin:0 0 4px; }
  h2 { font-family:Georgia,serif; font-style:italic; font-weight:500; font-size:16px;
       margin:30px 0 10px; }
  .sub { color:#827e76; font-size:12px; margin-bottom:22px; }
  .card { background:#fbfaf4; border:1px solid #e3decf; border-radius:10px;
          padding:15px 17px; margin:13px 0; }
  .card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .name { font-family:Georgia,serif; font-size:16px; }
  .meta { margin:3px 0 6px; }
  .desc { font-size:14px; margin:6px 0 10px; }
  .muted { color:#827e76; font-size:12px; font-weight:400; }
  .pill { font-size:10px; letter-spacing:.04em; text-transform:uppercase;
          padding:2px 8px; border-radius:999px; font-weight:600; }
  .st-open { background:#f0d9cc; color:#8a4a30; }
  .st-monitoring { background:#ede8d8; color:#807548; }
  .st-resolved { background:#dfecd5; color:#3d5c2b; }
  .sv-high { background:#ecc8c0; color:#8c3527; }
  .sv-medium { background:#f0d9cc; color:#8a4a30; }
  .sv-low { background:#ede8d8; color:#807548; }
  ul.issues { list-style:none; margin:0; padding:0; }
  ul.issues li { padding:4px 0; border-top:1px solid #efebdd; font-size:13px; }
  ul.issues li:first-child { border-top:0; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%;
         margin-right:5px; vertical-align:middle; }
  .dot.sev-high { background:#8c3527; }
  .dot.sev-medium { background:#cc785c; }
  .dot.sev-low { background:#bdb48f; }
  .empty { color:#827e76; font-style:italic; font-size:14px; }
  a { color:#8a4a30; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .convs a { margin-left:5px; font-size:12px; color:#6e6c64; }
  .health { background:#fbfaf4; border:1px solid #e3decf; border-left:3px solid #cc785c;
            border-radius:10px; padding:14px 16px; margin:18px 0 4px; }
  .health .score { font-family:Georgia,serif; font-size:32px; font-weight:500;
                   color:#3d5c2b; line-height:1; vertical-align:middle; }
  .health .score.warn { color:#8a4a30; }
  .health .score.bad { color:#8c3527; }
  .health .score-label { font-size:13px; color:#3d3b35; margin-left:8px;
                         vertical-align:middle; }
  .health .health-detail { font-size:12px; color:#6e6c64; margin-top:6px; }
  .health .spark { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:15px;
                   letter-spacing:2px; color:#8a4a30; margin-top:8px; }
  .health .spark-cap { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
                       font-size:11px; letter-spacing:0; color:#a09b8e; font-style:italic; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 14px; }
  .tab { font-family:inherit; font-size:12px; cursor:pointer; padding:6px 11px;
         border:1px solid #e3decf; border-radius:999px; background:#fbfaf4;
         color:#827e76; }
  .tab:hover { border-color:#cbc4ac; }
  .tab.on { background:#2c2b27; color:#f5f4ed; border-color:#2c2b27; }
  .tab-n { font-weight:700; }
  .panel { display:none; }
  .panel.on { display:block; }
</style></head>
<body><div class="wrap">
  <h1>RS watch — issues</h1>
  <div class="sub">${runLine}</div>
  ${healthBlock}

  <h2>Active clusters (${active.length})</h2>
  ${
    active.length
      ? `<div class="tabs">${tabs
          .map(
            (t, idx) =>
              `<button class="tab${idx === activeTabIdx ? " on" : ""}" data-tab="${idx}">${esc(t.label)} <span class="tab-n">${t.clusters.length}</span></button>`,
          )
          .join("")}</div>
  ${tabs
    .map(
      (t, idx) =>
        `<div class="panel${idx === activeTabIdx ? " on" : ""}" data-panel="${idx}">${
          t.clusters.length
            ? t.clusters.map(clusterCard).join("")
            : '<p class="empty">No active clusters in this category.</p>'
        }</div>`,
    )
    .join("")}`
      : '<p class="empty">No active clusters.</p>'
  }
  ${
    unclustered.length
      ? `<h2>Unclustered issues (${unclustered.length})</h2>
  <div class="card"><ul class="issues">${unclustered
    .sort(bySeverity)
    .map(issueRow)
    .join("")}</ul></div>`
      : ""
  }
  <h2>Resolved clusters (${resolved.length})</h2>
  ${
    resolved.length
      ? `<div class="card"><ul class="issues">${resolved
          .map(
            (c) =>
              `<li><b>${esc(c.slug)}</b> <span class="muted">resolved ${fmtTime(c.resolved_at)}</span></li>`,
          )
          .join("")}</ul></div>`
      : '<p class="empty">None.</p>'
  }
</div>
<script>
(function () {
  var tabs = document.querySelectorAll(".tab");
  var panels = document.querySelectorAll(".panel");
  tabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var i = btn.getAttribute("data-tab");
      tabs.forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-tab") === i);
      });
      panels.forEach(function (p) {
        p.classList.toggle("on", p.getAttribute("data-panel") === i);
      });
    });
  });
})();
</script>
</body></html>`;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

async function handleMcp(req, res) {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  }
}

app.all("/mcp", (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return handleMcp(req, res);
});

app.all("/t/:token/mcp", (req, res) => {
  if (req.params.token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return handleMcp(req, res);
});

app.get("/dashboard", async (req, res) => {
  if (req.query.token !== AUTH_TOKEN) {
    return res.status(401).send("unauthorized");
  }
  if (!statePool) {
    return res.status(503).send("STATE_DATABASE_URL is not configured");
  }
  try {
    const [clusters, issues, runs, cwRuns] = await Promise.all([
      statePool.query("SELECT * FROM v_clusters"),
      statePool.query("SELECT * FROM v_issues"),
      statePool.query(
        "SELECT layer, MAX(started_at) AS last_run FROM runs WHERE status = 'succeeded' GROUP BY layer",
      ),
      statePool.query(
        `SELECT started_at, stats FROM runs
          WHERE layer = 'conversation-watch' AND status = 'succeeded'
            AND started_at > now() - interval '7 days'
          ORDER BY started_at DESC`,
      ),
    ]);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderDashboard(clusters.rows, issues.rows, runs.rows, cwRuns.rows),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
