import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";

/**
 * Build the Express app with all API routes wired up (storage proxy, OAuth, tRPC).
 *
 * Static-file / Vite serving is intentionally NOT included here so the exact same
 * app can run in two environments:
 *   - As a long-lived Node server (server/_core/index.ts) where it also serves the
 *     built client (or the Vite dev middleware).
 *   - As an AWS Lambda function (server/_core/lambda.ts) where the same handler
 *     serves both the API and the built SPA (see lambda.ts).
 */
export function createApp(): Express {
  const app = express();
  // Larger body limit to support file uploads (e.g. bulk patient import).
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  return app;
}
