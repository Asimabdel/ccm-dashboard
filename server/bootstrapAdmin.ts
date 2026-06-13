import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { hashPassword, validatePasswordStrength } from "./password";

/**
 * One-time bootstrap: create (or promote) the first admin with an email + password.
 *
 * Off the Manus platform there is no way to create the first admin from the UI —
 * `system.seed` and `members.create` both require an existing admin, and the
 * demo users created by the seed have no passwords. Run this once against your
 * database to get a working admin login, then manage everyone else from the
 * Team / Access page in the app.
 *
 * Usage (with DATABASE_URL set):
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='Str0ngPass' pnpm bootstrap:admin
 *   (optional) ADMIN_NAME="Your Name"
 */
async function main() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const name = process.env.ADMIN_NAME || "Administrator";

  if (!email || !password) {
    console.error("✗ Set ADMIN_EMAIL and ADMIN_PASSWORD environment variables.");
    process.exit(1);
  }
  const weak = validatePasswordStrength(password);
  if (weak) {
    console.error(`✗ ${weak}`);
    process.exit(1);
  }

  const db = await getDb();
  if (!db) {
    console.error("✗ Database unavailable — is DATABASE_URL set and reachable, and has `pnpm db:push` been run?");
    process.exit(1);
  }

  const openId = `local:${email}`;
  const passwordHash = await hashPassword(password);
  const now = new Date();

  // Prefer matching an existing row by email (e.g. a seeded/pending account) so we
  // promote it in place; otherwise key the upsert on the local openId.
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing.length) {
    await db
      .update(users)
      .set({
        openId,
        name,
        role: "admin",
        loginMethod: "password",
        passwordHash,
        passwordSetAt: now,
        mustChangePassword: false,
        updatedAt: now,
        lastSignedIn: now,
      })
      .where(eq(users.id, existing[0].id));
  } else {
    await db
      .insert(users)
      .values({
        openId,
        email,
        name,
        role: "admin",
        loginMethod: "password",
        passwordHash,
        passwordSetAt: now,
        mustChangePassword: false,
        lastSignedIn: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          role: "admin",
          name,
          loginMethod: "password",
          passwordHash,
          passwordSetAt: now,
          mustChangePassword: false,
          updatedAt: now,
        },
      });
  }

  console.log(`✓ Admin ready: ${email} (openId ${openId}).`);
  console.log("  Sign in at /sign-in with this email and password.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
