// CLI wrapper for the Workspace migration (needs network access to the database).
//
//   node_modules/.bin/tsx server/migrateWorkspace.ts            (dry run: prints the plan)
//   node_modules/.bin/tsx server/migrateWorkspace.ts --apply    (executes it)
//
// Production RDS only accepts the Lambda, so there use a direct invoke instead:
//   aws lambda invoke --function-name ccm-app --cli-binary-format raw-in-base64-out \
//     --payload '{"__migrate":"workspace"}' out.json
import "dotenv/config";
import { WORKSPACE_STATEMENTS, inspectWorkspace, runWorkspaceMigration } from "./workspaceMigration";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  console.log(`${apply ? "APPLYING to" : "DRY RUN against"} ${new URL(url).host}\n`);
  if (!apply) {
    console.log(JSON.stringify(await inspectWorkspace(), null, 2));
    console.log("  • append missing enum values (auditLogs.action, notifications.type)");
    for (const s of WORKSPACE_STATEMENTS) console.log(`  • ${s.label}`);
    console.log("  • starter playbooks (only if the playbooks table is empty)");
    console.log("\nNothing was changed. Re-run with --apply to execute.");
    process.exit(0);
  }
  for (const label of await runWorkspaceMigration()) console.log(`  ✓ ${label}`);
  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
