/**
 * LOCAL DEVELOPMENT ONLY — throwaway MySQL with fictional data.
 *
 * Production RDS only accepts connections from the Lambda, so new screens are
 * developed against this disposable local MySQL instead. Nothing here ever
 * touches production, and the data is wiped when the process stops.
 *
 *   pnpm dev:db                       # terminal 1 — starts MySQL on 127.0.0.1:3307
 *   export DATABASE_URL=mysql://dev:devpass@127.0.0.1:3307/ccm
 *   npx drizzle-kit push --force      # terminal 2 — creates the tables
 *   pnpm seed:local                   # fictional demo data + logins (scripts/seed-local.ts)
 *   then start the "local" config in .claude/launch.json (app on :3001)
 */
import { createDB } from "mysql-memory-server";

const PORT = 3307;

async function main() {
  const db = await createDB({
    port: PORT,
    dbName: "ccm",
    username: "root",
    version: "8.4.x",
    logLevel: "WARN",
    // drizzle-kit requires a password, so add a local-only dev user. UTC matches RDS,
    // so DB-default timestamps read back the same way they do in production.
    initSQLString:
      "CREATE USER IF NOT EXISTS 'dev'@'%' IDENTIFIED BY 'devpass'; GRANT ALL PRIVILEGES ON *.* TO 'dev'@'%'; FLUSH PRIVILEGES; SET GLOBAL time_zone = '+00:00';",
  });
  console.log(`\n✓ Local dev MySQL ${db.mysql.version} ready`);
  console.log(`  DATABASE_URL=mysql://dev:devpass@127.0.0.1:${db.port}/ccm\n`);
  const shutdown = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("✗ Could not start local MySQL:", err);
  process.exit(1);
});
