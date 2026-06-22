import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
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

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
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
