import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

// Mirror the runtime TLS handling in server/db.ts: managed MySQL requires TLS but
// mysql2 ignores ?ssl-mode=REQUIRED in the URL, so pass discrete credentials and
// enable TLS for non-local hosts.
const u = new URL(connectionString);
const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
const ca = process.env.DATABASE_SSL_CA;

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    ssl: isLocal ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  },
});
