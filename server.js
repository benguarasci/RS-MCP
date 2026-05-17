import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
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

  return server;
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

app.listen(PORT, () => console.log(`MCP server listening on :${PORT}`));
