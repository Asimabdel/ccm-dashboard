import "dotenv/config";
import express from "express";
import path from "path";
import serverless from "serverless-http";
import { createApp } from "./app";

/**
 * AWS Lambda entry point (behind a Lambda Function URL — HTTPS built in).
 *
 * Serves BOTH the API and the built React SPA from one function:
 *   - createApp() registers the API routes (tRPC, OAuth, storage proxy).
 *   - The built client is bundled into the zip at ./public and served statically,
 *     with a catch-all that returns index.html for client-side routes.
 *
 * (On Vercel the SPA was served by the CDN; on Lambda there's no CDN, so the
 * function serves it itself.)
 */
const app = createApp();

const pub = path.resolve(import.meta.dirname, "public");
app.use(express.static(pub));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/manus-storage/")) return next();
  res.sendFile(path.join(pub, "index.html"));
});

export const handler = serverless(app);
