import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Client } = pg;

const STATE_DATABASE_URL = process.env.STATE_DATABASE_URL;
if (!STATE_DATABASE_URL) throw new Error("STATE_DATABASE_URL is required");

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function main() {
  const client = new Client({
    connectionString: STATE_DATABASE_URL,
    ssl: false, // Fly Postgres over the private .flycast network — no TLS
  });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const applied = new Set(
      (await client.query("select version from schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      process.stdout.write(`applying ${file} ... `);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (version) values ($1)",
          [file],
        );
        await client.query("commit");
        console.log("ok");
        ran++;
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    console.log(ran === 0 ? "nothing to apply" : `applied ${ran} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
