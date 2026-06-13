import "dotenv/config";
import { createApp } from "./app";

/**
 * Source for the Vercel serverless function.
 *
 * This is bundled into `api/index.js` (a single self-contained file) by the
 * `build:vercel` npm script. We ship a pre-bundled file rather than letting
 * Vercel compile `api/*.ts` directly because, with the project in ESM mode,
 * Vercel's per-file transpile leaves extensionless relative imports
 * (`./app`, `../routers`) unresolved and its dependency tracer misses the
 * dynamically-required internals of mysql2/drizzle — both surfacing at runtime
 * as ERR_MODULE_NOT_FOUND. Bundling collapses everything into one module with
 * no remaining imports to resolve.
 *
 * Vercel's Node launcher invokes the default export as the request handler, and
 * an Express app is exactly an (req, res) handler.
 */
export default createApp();
