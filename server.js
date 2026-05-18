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

function renderDashboard(clusters, issues, runs) {
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

  const issueRow = (i) => `
        <li>
          <span class="dot sev-${esc(i.severity)}"></span>
          <b>${esc(i.company)}</b> &middot; ${esc(i.kind)}
          <span class="muted">${esc(i.status)} &middot; streak ${esc(i.streak)}</span>
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
</style></head>
<body><div class="wrap">
  <h1>RS watch — issues</h1>
  <div class="sub">${runLine}</div>

  <h2>Active clusters (${active.length})</h2>
  ${active.length ? active.map(clusterCard).join("") : '<p class="empty">No active clusters.</p>'}
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
</div></body></html>`;
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
    const [clusters, issues, runs] = await Promise.all([
      statePool.query("SELECT * FROM v_clusters"),
      statePool.query("SELECT * FROM v_issues"),
      statePool.query(
        "SELECT layer, MAX(started_at) AS last_run FROM runs WHERE status = 'succeeded' GROUP BY layer",
      ),
    ]);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard(clusters.rows, issues.rows, runs.rows));
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
