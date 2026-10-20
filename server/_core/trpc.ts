import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { WORKFORCE_ONLY_ROLES } from '@shared/workforce';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // Never leak raw SQL / schema / DB connection errors to the browser. If the
  // database is unreachable or a query fails, log the real cause server-side and
  // return a friendly, generic message instead of a stack/SQL dump.
  errorFormatter({ shape, error }) {
    const raw = `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`;
    const isDbError =
      error.code === "INTERNAL_SERVER_ERROR" &&
      /Failed query|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|ER_[A-Z]|Too many connections|pool is closed|getaddrinfo/i.test(raw);
    if (isDbError) {
      if (error.cause) console.error("[DB] Request failed:", error.cause);
      return { ...shape, message: "The service is temporarily unavailable. Please try again in a moment." };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Workforce-only roles (e.g. medical assistants using the schedule / time clock)
// are fenced to these routers at the middleware level, so no patient (PHI)
// procedure is reachable for them even if it lacks its own role check.
// (workspace.* checks capabilities per procedure and scopes MAs to their clinics.)
const WORKFORCE_ONLY_ALLOWED_PREFIXES = ["auth.", "workforce.", "workspace.", "notifications.", "system."];

// Office managers (admin for one office) are fenced the same way, plus the few older procedures
// their pages use; each of those limits them to their office (staff logins, patient search, clinics).
const OFFICE_MANAGER_ALLOWED = [...WORKFORCE_ONLY_ALLOWED_PREFIXES, "users.", "members.create", "patients.list", "patients.duplicates", "clinics.list"];
// MAs (since 2026-10-01: the front desk's pages, at their clinic): plus the older procedures those pages use, each limited to their clinic.
const MEDICAL_ASSISTANT_ALLOWED = [...WORKFORCE_ONLY_ALLOWED_PREFIXES, "patients.list", "patients.duplicates", "clinics.list", "followUps.list", "followUps.updateStatus"];
const allowedFor = (list: string[], path: string) => list.some((p) => (p.endsWith(".") ? path.startsWith(p) : path === p));
// The APCM tab's procedures: also open to the named APCM people (server/apcmAccess.ts, e.g. an MA), whatever their role.
const APCM_PATHS = ["apcm.overview", "patients.detail", "patients.updateAPCM"];
const namedApcm = async (userId: number) => (await import("../apcmAccess")).hasNamedApcmAccess(userId);

const requireUser = t.middleware(async opts => {
  const { ctx, next, path } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  const fenced =
    ((WORKFORCE_ONLY_ROLES as readonly string[]).includes(ctx.user.role) &&
      !allowedFor(ctx.user.role === "medical_assistant" ? MEDICAL_ASSISTANT_ALLOWED : WORKFORCE_ONLY_ALLOWED_PREFIXES, path)) ||
    (ctx.user.role === "office_manager" && !allowedFor(OFFICE_MANAGER_ALLOWED, path));
  if (fenced && !(APCM_PATHS.includes(path) && (await namedApcm(ctx.user.id)))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
