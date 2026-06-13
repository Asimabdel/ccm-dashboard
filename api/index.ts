import "dotenv/config";
import { createApp } from "../server/_core/app";

/**
 * Vercel serverless entry point.
 *
 * Exports the Express app as the request handler. Vercel's @vercel/node runtime
 * invokes the default export as (req, res) => app(req, res), so every request that
 * `vercel.json` rewrites to `/api/index` (i.e. /api/* and /manus-storage/*) is
 * routed through the normal Express stack — tRPC, OAuth callback, storage proxy.
 *
 * No server.listen() here: the platform manages the request/response lifecycle.
 */
export default createApp();
