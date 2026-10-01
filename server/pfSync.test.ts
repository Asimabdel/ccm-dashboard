import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the export store: which files are already there, and which downloads were started.
const store = vi.hoisted(() => ({ ready: new Set<string>(), started: [] as string[] }));
vi.mock("./exportStore", () => ({
  downloadStatus: async (key: string) => ({ ready: store.ready.has(key), size: store.ready.has(key) ? 100 : 0, error: null }),
  startDownload: async (_url: string, _headers: Record<string, string>, key: string) => { store.started.push(key); },
  clearError: async () => {},
  readChunk: async () => Buffer.alloc(0),
  removeFile: async () => {},
}));

import { checkDownloads, type PfSyncState } from "./pfSync";

const state = (n: number): PfSyncState => ({
  enabled: true, phase: "downloading", mode: "full", requested: null, since: null, statusUrl: "https://example.test/status", startedAt: "2026-09-30T19:34:48Z",
  transactionTime: null, requiresAccessToken: false, progress: null,
  files: Array.from({ length: n }, (_, i) => ({ type: "Observation", url: `https://example.test/f${i}`, key: `pf/run/${i}.ndjson`, size: 0, offset: 0, lines: 0, status: "pending" as const })),
  counts: {}, lastSuccessAt: null, lastTransactionTime: null, lastFullAt: null, lastError: null, lastAttemptAt: null, lockUntil: 0,
} as PfSyncState);

describe("Practice Fusion export downloads", () => {
  beforeEach(() => { store.ready.clear(); store.started.length = 0; });

  it("never starts more than 20 downloads at once, and reuses files already in the store", async () => {
    for (let i = 0; i < 30; i++) store.ready.add(`pf/run/${i}.ndjson`); // fetched by an earlier attempt
    let s = await checkDownloads(state(714), Date.now() + 60_000);
    expect(store.started).toHaveLength(20);
    expect(s.files.filter((f) => f.status === "ready")).toHaveLength(30);
    expect(s.files.filter((f) => f.status === "downloading")).toHaveLength(20);
    expect(s.phase).toBe("downloading");
    // Those 20 finish: the next run marks them and starts 20 more.
    for (const k of store.started) store.ready.add(k);
    store.started.length = 0;
    s = await checkDownloads(s, Date.now() + 60_000);
    expect(s.files.filter((f) => f.status === "ready")).toHaveLength(50);
    expect(store.started).toHaveLength(20);
  });

  it("moves on to loading once every file is there", async () => {
    for (let i = 0; i < 5; i++) store.ready.add(`pf/run/${i}.ndjson`);
    const s = await checkDownloads(state(5), Date.now() + 60_000);
    expect(store.started).toHaveLength(0);
    expect(s.phase).toBe("loading");
  });

  it("stops when the run is out of time (and keeps its place)", async () => {
    const s = await checkDownloads(state(100), Date.now() - 1);
    expect(store.started).toHaveLength(0);
    expect(s.files.every((f) => f.status === "pending")).toBe(true);
  });
});
