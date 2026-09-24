// CLI wrapper for the Workforce migration (needs network access to the database).
//
//   node_modules/.bin/tsx server/migrateWorkforce.ts            (dry run: prints the plan)
//   node_modules/.bin/tsx server/migrateWorkforce.ts --apply    (executes it)
import "dotenv/config";
import { WORKFORCE_STATEMENTS, runWorkforceMigration } from "./workforceMigration";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  console.log(`${apply ? "APPLYING to" : "DRY RUN against"} ${new URL(url).host}\n`);
  if (!apply) {
    for (const s of WORKFORCE_STATEMENTS) console.log(`  • ${s.label}`);
    console.log("\nNothing was changed. Re-run with --apply to execute.");
    return;
  }
  for (const label of await runWorkforceMigration()) console.log(`  ✓ ${label}`);
  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
