import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  esc,
  SEV_RANK,
  renderDashboard,
  renderCluster,
  renderCompanies,
  renderCompany,
  renderIssue,
  renderNewIssueForm,
  renderNotFound,
} from "./views.js";

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

// ---- dashboard helpers -----------------------------------------------------

// Validate the auth token (query or form body) and that the state DB is wired
// up. Returns the token string, or null after sending an error response.
function dashAuth(req, res) {
  const token = req.query.token || (req.body && req.body.token);
  if (token !== AUTH_TOKEN) {
    res.status(401).send("unauthorized");
    return null;
  }
  if (!statePool) {
    res.status(503).send("STATE_DATABASE_URL is not configured");
    return null;
  }
  return token;
}

// Rail data shared by every page: category counts + a cluster lookup map.
async function loadRail() {
  const { rows } = await statePool.query(
    "SELECT id, slug, category FROM clusters",
  );
  const categoryCounts = {};
  for (const r of rows) {
    if (r.category) {
      categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
    }
  }
  const clusterMeta = new Map(
    rows.map((r) => [String(r.id), { slug: r.slug, category: r.category }]),
  );
  return { categoryCounts, totalClusters: rows.length, clusterMeta };
}

// Per-company aggregates from the watch-state DB — drives the Companies view
// and the per-company health badge. Cheap: one query, indexed scans.
async function loadCompanyAggregates() {
  const { rows } = await statePool.query(`
    SELECT c.id, c.slug, c.name, c.admin_id,
      (SELECT count(*)::int FROM issues i WHERE i.company_id = c.id AND i.status = 'open')          AS open_issues,
      (SELECT count(*)::int FROM issues i WHERE i.company_id = c.id AND i.status = 'monitoring')    AS monitoring_issues,
      (SELECT count(*)::int FROM issues i WHERE i.company_id = c.id AND i.status IN ('open','monitoring') AND i.severity = 'high') AS high_issues,
      (SELECT count(*)::int FROM cs_issues i WHERE i.company_id = c.id AND i.status = 'open')       AS cs_open,
      (SELECT count(*)::int FROM cs_issues i WHERE i.company_id = c.id AND i.status = 'monitoring') AS cs_monitoring,
      (SELECT count(*)::int FROM cs_issues i WHERE i.company_id = c.id AND i.status IN ('open','monitoring') AND i.severity = 'high') AS cs_high,
      (SELECT count(*)::int FROM cs_actions a WHERE a.company_id = c.id AND a.status = 'open')      AS open_actions,
      GREATEST(
        (SELECT max(last_sighted) FROM issues    i WHERE i.company_id = c.id AND i.status IN ('open','monitoring')),
        (SELECT max(last_sighted) FROM cs_issues i WHERE i.company_id = c.id AND i.status IN ('open','monitoring'))
      ) AS last_sighted
    FROM companies c
    ORDER BY c.name
  `);
  return rows;
}

// Topline activity metrics from the prod DB for a list of admin IDs. One
// READ ONLY transaction; three grouped queries. Returns map keyed by admin_id.
// Returns an empty map on prod DB error so the dashboard still renders.
async function loadTopline(adminIds, windowHours = 24) {
  const result = new Map();
  if (!adminIds.length) return result;
  const win = `${Number(windowHours)} hours`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const [conv, tour, prospect] = await Promise.all([
      client.query(
        `SELECT "companyId" AS admin_id,
                count(*)::int AS conversations,
                (count(*) FILTER (WHERE "adminRating" <= 2))::int AS low_rated
         FROM "Conversation"
         WHERE "companyId" = ANY($1::int[])
           AND "createdAt" > now() - interval '${win}'
         GROUP BY "companyId"`,
        [adminIds],
      ),
      client.query(
        `SELECT m."companyId" AS admin_id,
                (count(*) FILTER (WHERE a."status" IN ('Confirmed','ManagerConfirmed')))::int AS tours_booked,
                (count(*) FILTER (WHERE a."status" = 'Completed'))::int AS tours_completed,
                (count(*) FILTER (WHERE a."status" IN ('ManagerCancelled','ProspectCancelled')))::int AS tours_cancelled
         FROM "Appointment" a
         JOIN "Manager" m ON m.id = a."managerId"
         WHERE m."companyId" = ANY($1::int[])
           AND a."deletedAt" IS NULL
           AND a."createdAt" > now() - interval '${win}'
         GROUP BY m."companyId"`,
        [adminIds],
      ),
      client.query(
        `SELECT "companyId" AS admin_id, count(*)::int AS prospects
         FROM "Prospect"
         WHERE "companyId" = ANY($1::int[])
           AND "createdAt" > now() - interval '${win}'
         GROUP BY "companyId"`,
        [adminIds],
      ),
    ]);
    await client.query("COMMIT");
    const merge = (row) => {
      const prev = result.get(row.admin_id) || {};
      result.set(row.admin_id, { ...prev, ...row });
    };
    conv.rows.forEach(merge);
    tour.rows.forEach(merge);
    prospect.rows.forEach(merge);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("loadTopline failed:", err.message);
  } finally {
    client.release();
  }
  return result;
}

function parseFilters(q) {
  return {
    category: q.category || "",
    severity: q.severity || "",
    status: q.status || "",
    company: q.company || "",
    q: q.q || "",
    sort: q.sort || "",
  };
}

function filterClusters(clusters, issues, f) {
  let list = clusters;
  if (f.category) list = list.filter((c) => c.category === f.category);
  if (f.severity) list = list.filter((c) => c.severity === f.severity);
  if (f.status) list = list.filter((c) => c.status === f.status);
  if (f.company) {
    const ids = new Set(
      issues
        .filter((i) => i.company_slug === f.company)
        .map((i) => String(i.cluster_id)),
    );
    list = list.filter((c) => ids.has(String(c.id)));
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const issueMatch = new Set(
      issues
        .filter(
          (i) =>
            (i.kind && i.kind.toLowerCase().includes(q)) ||
            (i.summary && i.summary.toLowerCase().includes(q)),
        )
        .map((i) => String(i.cluster_id)),
    );
    list = list.filter(
      (c) =>
        (c.slug && c.slug.toLowerCase().includes(q)) ||
        (c.description && c.description.toLowerCase().includes(q)) ||
        issueMatch.has(String(c.id)),
    );
  }
  return list;
}

function sortClusters(list, sort) {
  const arr = list.slice();
  const num = (v) => Number(v || 0);
  switch (sort) {
    case "slug":
      arr.sort((a, b) => a.slug.localeCompare(b.slug));
      break;
    case "category":
      arr.sort((a, b) =>
        String(a.category || "").localeCompare(String(b.category || "")),
      );
      break;
    case "severity":
      arr.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
      break;
    case "status":
      arr.sort((a, b) => a.status.localeCompare(b.status));
      break;
    case "companies":
      arr.sort((a, b) => num(b.company_count) - num(a.company_count));
      break;
    case "streak":
      arr.sort((a, b) => num(b.streak) - num(a.streak));
      break;
    default: // "issues"
      arr.sort((a, b) => num(b.issue_count) - num(a.issue_count));
  }
  return arr;
}

// ---- app -------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

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

app.all("/mcp", (req, res) => {
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

// ---- dashboard routes ------------------------------------------------------

const html = (res, body) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(body);
};

app.get("/dashboard", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const filters = parseFilters(req.query);
    const [vclusters, vissues, cwRuns, snaps] = await Promise.all([
      statePool.query("SELECT * FROM v_clusters"),
      statePool.query("SELECT * FROM v_issues"),
      statePool.query(
        `SELECT started_at, stats FROM runs
          WHERE layer = 'conversation-watch' AND status = 'succeeded'
            AND started_at > now() - interval '7 days'
          ORDER BY started_at DESC`,
      ),
      statePool.query(
        `SELECT cluster_id, issue_count, captured_at FROM cluster_snapshots
          WHERE captured_at > now() - interval '14 days'
          ORDER BY cluster_id, captured_at`,
      ),
    ]);

    const snapshotSeries = {};
    for (const s of snaps.rows) {
      const k = String(s.cluster_id);
      (snapshotSeries[k] = snapshotSeries[k] || []).push(
        Number(s.issue_count),
      );
    }

    const filtered = filterClusters(vclusters.rows, vissues.rows, filters);
    const active = sortClusters(
      filtered.filter((c) => c.status !== "resolved"),
      filters.sort,
    );
    const resolved = filtered.filter((c) => c.status === "resolved");

    html(
      res,
      renderDashboard({
        token,
        clusters: active,
        resolved,
        cwRuns: cwRuns.rows,
        snapshotSeries,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
        filters,
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.get("/cluster/:id", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const cluster = await statePool.query(
      "SELECT * FROM v_clusters WHERE id = $1",
      [req.params.id],
    );
    if (!cluster.rows.length) {
      return html(
        res.status(404),
        renderNotFound({
          token,
          what: "No cluster with that id.",
          categoryCounts: rail.categoryCounts,
          totalClusters: rail.totalClusters,
        }),
      );
    }
    const [issues, snapshots] = await Promise.all([
      statePool.query("SELECT * FROM v_issues WHERE cluster_id = $1", [
        req.params.id,
      ]),
      statePool.query(
        `SELECT * FROM cluster_snapshots WHERE cluster_id = $1
          ORDER BY captured_at DESC LIMIT 14`,
        [req.params.id],
      ),
    ]);
    const sorted = issues.rows
      .slice()
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    html(
      res,
      renderCluster({
        token,
        cluster: cluster.rows[0],
        issues: sorted,
        snapshots: snapshots.rows,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.get("/companies", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const companies = await loadCompanyAggregates();
    const adminIds = companies.map((c) => c.admin_id).filter(Boolean);
    const topline = await loadTopline(adminIds, 24);
    html(
      res,
      renderCompanies({
        token,
        companies,
        topline,
        windowHours: 24,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
        sort: req.query.sort || "",
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.get("/company/:slug", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const company = await statePool.query(
      "SELECT id, slug, name, admin_id FROM companies WHERE slug = $1",
      [req.params.slug],
    );
    if (!company.rows.length) {
      return html(
        res.status(404),
        renderNotFound({
          token,
          what: "No company with that slug.",
          categoryCounts: rail.categoryCounts,
          totalClusters: rail.totalClusters,
        }),
      );
    }
    const co = company.rows[0];
    const [issues, csIssues, csActions] = await Promise.all([
      statePool.query("SELECT * FROM v_issues WHERE company_slug = $1", [co.slug]),
      statePool.query(
        "SELECT * FROM v_cs_issues WHERE company_slug = $1 ORDER BY status, severity DESC, last_sighted DESC",
        [co.slug],
      ),
      statePool.query(
        "SELECT * FROM v_cs_actions WHERE company_slug = $1 AND status = 'open' ORDER BY first_flagged DESC",
        [co.slug],
      ),
    ]);
    const toplineMap = co.admin_id
      ? await loadTopline([co.admin_id], 24)
      : new Map();
    html(
      res,
      renderCompany({
        token,
        company: co,
        issues: issues.rows,
        csIssues: csIssues.rows,
        csActions: csActions.rows,
        topline: toplineMap.get(co.admin_id) || null,
        windowHours: 24,
        clusterMeta: rail.clusterMeta,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.get("/issue/new", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const companies = await statePool.query(
      "SELECT slug, name FROM companies ORDER BY name",
    );
    html(
      res,
      renderNewIssueForm({
        token,
        companies: companies.rows,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.get("/issue/:id", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const rail = await loadRail();
    const issue = await statePool.query(
      "SELECT * FROM v_issues WHERE id = $1",
      [req.params.id],
    );
    if (!issue.rows.length) {
      return html(
        res.status(404),
        renderNotFound({
          token,
          what: "No issue with that id.",
          categoryCounts: rail.categoryCounts,
          totalClusters: rail.totalClusters,
        }),
      );
    }
    html(
      res,
      renderIssue({
        token,
        issue: issue.rows[0],
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
      }),
    );
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

// ---- operator write routes -------------------------------------------------

const tokenQs = (token) => `?token=${encodeURIComponent(token)}`;

app.post("/issue/:id/dismiss", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    await statePool.query(
      "UPDATE issues SET status = 'dismissed' WHERE id = $1",
      [req.params.id],
    );
    res.redirect(`/issue/${req.params.id}${tokenQs(token)}`);
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.post("/issue/:id/note", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;
  try {
    const note = (req.body.operator_note || "").trim() || null;
    await statePool.query(
      "UPDATE issues SET operator_note = $1 WHERE id = $2",
      [note, req.params.id],
    );
    res.redirect(`/issue/${req.params.id}${tokenQs(token)}`);
  } catch (err) {
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.post("/issue", async (req, res) => {
  const token = dashAuth(req, res);
  if (!token) return;

  const companySlug = (req.body.company || "").trim();
  const kind = (req.body.kind || "").trim();
  const summary = (req.body.summary || "").trim();
  let severity = (req.body.severity || "medium").trim();
  if (!["low", "medium", "high"].includes(severity)) severity = "medium";
  const sampleConvs = (req.body.sample_convs || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const reshow = async (error, status = 400) => {
    const rail = await loadRail();
    const companies = await statePool.query(
      "SELECT slug, name FROM companies ORDER BY name",
    );
    html(
      res.status(status),
      renderNewIssueForm({
        token,
        companies: companies.rows,
        categoryCounts: rail.categoryCounts,
        totalClusters: rail.totalClusters,
        error,
        values: { company: companySlug, kind, summary, severity,
          sample_convs: req.body.sample_convs || "" },
      }),
    );
  };

  try {
    if (!companySlug || !kind || !summary) {
      return reshow("Company, kind, and summary are all required.");
    }
    const company = await statePool.query(
      "SELECT id FROM companies WHERE slug = $1",
      [companySlug],
    );
    if (!company.rows.length) {
      return reshow("That company does not exist in the watch system.");
    }
    const inserted = await statePool.query(
      `INSERT INTO issues
         (company_id, kind, status, severity, summary, sample_convs, origin)
       VALUES ($1, $2, 'monitoring', $3, $4, $5::jsonb, 'operator')
       RETURNING id`,
      [
        company.rows[0].id,
        kind,
        severity,
        summary,
        JSON.stringify(sampleConvs),
      ],
    );
    res.redirect(`/issue/${inserted.rows[0].id}${tokenQs(token)}`);
  } catch (err) {
    if (err.code === "23505") {
      return reshow(
        `An issue "${kind}" already exists for that company — open it from the dashboard instead.`,
        409,
      );
    }
    res.status(500).send(`error: ${esc(err.message)}`);
  }
});

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
