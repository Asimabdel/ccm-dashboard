import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerIntegrationRoutes } from "../integration";
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
  // Square's webhook (payments, refunds, Terminal). Registered before the JSON parser: the signature
  // is checked against the exact bytes Square sent.
  app.post("/api/square/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    try {
      const { handleSquareWebhook } = await import("../squareDb");
      const sig = req.headers["x-square-hmacsha256-signature"];
      const r = await handleSquareWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(""), typeof sig === "string" ? sig : "");
      res.status(r.status).json({ ok: r.status === 200 });
    } catch (e) {
      console.error("[square] webhook failed:", (e as Error).message);
      res.status(500).json({ ok: false });
    }
  });
  // Larger body limit to support file uploads (e.g. bulk patient import).
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // Read-only CCM/RPM integration API for the separate Clinic Command Center app.
  registerIntegrationRoutes(app);
  // Google sends the admin back here after connecting the practice mailbox (read-only).
  app.get("/api/integrations/google/callback", async (req, res) => {
    try {
      const { handleGmailCallback } = await import("../gmailSync");
      res.redirect(await handleGmailCallback(req.query as Record<string, unknown>));
    } catch (e) {
      console.error("[gmail] connect failed:", (e as Error).message);
      res.redirect("/integrations?gmail=" + encodeURIComponent("Connecting the mailbox failed. Try again."));
    }
  });
  // Practice Fusion checks MyPCP's sign-in against this public key (SMART Backend Services).
  app.get("/.well-known/jwks.json", async (_req, res) => {
    try {
      const { getJwks } = await import("../pfFhir");
      res.set("Cache-Control", "public, max-age=300").json(await getJwks());
    } catch (e) {
      console.error("[jwks] failed:", (e as Error).message);
      res.status(503).json({ error: "unavailable" });
    }
  });
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
