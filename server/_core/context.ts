import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";

/** An admin previewing another role's dashboards ("View as"): the role they act as, kept in this cookie. */
export const VIEW_AS_COOKIE = "mypcp_view_as";
export const VIEW_AS_ROLES = ["staff", "provider", "billing", "front_desk"] as const;

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /** `role` is the role in effect (an admin's preview role while they "view as"); `realRole` is their own when previewing. */
  user: (User & { realRole?: User["role"] }) | null;
};

function viewAsRole(cookieHeader: string | undefined): (typeof VIEW_AS_ROLES)[number] | null {
  const m = /(?:^|;\s*)mypcp_view_as=([^;]+)/.exec(cookieHeader ?? "");
  const v = m ? decodeURIComponent(m[1]!) : null;
  return v && (VIEW_AS_ROLES as readonly string[]).includes(v) ? (v as (typeof VIEW_AS_ROLES)[number]) : null;
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: TrpcContext["user"] = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  // "View as": only an admin's own login can preview, and their stored role never changes.
  if (user?.role === "admin") {
    const preview = viewAsRole(opts.req.headers.cookie);
    if (preview) user = { ...user, role: preview, realRole: "admin" };
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
