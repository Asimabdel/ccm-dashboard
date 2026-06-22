import "dotenv/config";
import serverless from "serverless-http";
import { createApp } from "./app";

/**
 * AWS Lambda entry point.
 *
 * Wraps the same Express app (createApp — storage proxy + OAuth + tRPC) used by the
 * local server and the Vercel function, so it can run behind a Lambda Function URL
 * (HTTPS is built in — no load balancer or certificate needed). serverless-http
 * translates the Lambda event/response to/from Express req/res.
 */
export const handler = serverless(createApp());
