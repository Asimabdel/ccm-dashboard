import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { NAV_PREFS_MAX_SHORTCUTS, cleanNavPrefs, type NavPrefs } from "@shared/navMenu";

/**
 * The side menu, per person: starred pages ("My shortcuts"), folded sections, and how many
 * things are waiting on each page.
 *
 * Every page draws its own layout, so the menu is rebuilt on each click. A copy of the person's
 * choices is kept in this browser (keyed by their login) so the menu is right on the first paint;
 * the copy saved on their account wins as soon as it arrives, so the choices follow them to any computer.
 */

const EMPTY_PREFS: NavPrefs = { shortcuts: [], folded: [] };
const NO_COUNTS: Record<string, number> = {};
/** When the bubbles were last refreshed because something was saved (shared by every page's menu). */
let lastAfterSave = 0;
const storeKey = (userId: number) => `ws.navPrefs.${userId}`;

function readLocal(userId: number | undefined): NavPrefs {
  if (!userId) return EMPTY_PREFS;
  try {
    return cleanNavPrefs(JSON.parse(localStorage.getItem(storeKey(userId)) || "null"));
  } catch {
    return EMPTY_PREFS;
  }
}

function writeLocal(userId: number | undefined, prefs: NavPrefs) {
  if (!userId) return;
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the account copy still works */
  }
}

const same = (a: NavPrefs, b: NavPrefs) => a.shortcuts.join("|") === b.shortcuts.join("|") && a.folded.join("|") === b.folded.join("|");

// Saves go to the account one at a time, newest last, so two quick clicks can never land out of order.
// (Kept outside the hook: the menu is rebuilt on every page, and a save may still be on its way.)
let saving = false;
let waitingToSave: NavPrefs | null = null;
function saveInOrder(next: NavPrefs, send: (p: NavPrefs) => Promise<unknown>, onFail: () => void) {
  waitingToSave = next;
  if (saving) return;
  saving = true;
  void (async () => {
    try {
      while (waitingToSave) {
        const p = waitingToSave;
        waitingToSave = null;
        await send(p);
      }
    } catch {
      waitingToSave = null;
      onFail();
    } finally {
      saving = false;
    }
  })();
}

export function useNavPrefs(userId: number | undefined) {
  const utils = trpc.useUtils();
  const saved = trpc.workspace.nav.prefs.useQuery(undefined, { enabled: !!userId, staleTime: 5 * 60_000 });
  const [prefs, setPrefs] = useState<NavPrefs>(() => readLocal(userId));
  const latest = useRef(prefs);
  latest.current = prefs;

  // A different person signed in on this browser: start from their own copy.
  useEffect(() => {
    setPrefs(readLocal(userId));
  }, [userId]);

  // The copy on the account wins once it arrives.
  useEffect(() => {
    if (!saved.data) return;
    const next = cleanNavPrefs(saved.data);
    if (!same(next, latest.current)) setPrefs(next);
    writeLocal(userId, next);
  }, [saved.data, userId]);

  const update = useCallback(
    (change: (p: NavPrefs) => NavPrefs) => {
      const next = cleanNavPrefs(change(latest.current));
      latest.current = next;
      setPrefs(next);
      writeLocal(userId, next);
      // Keep the cached copy in step, so the next page (which rebuilds the menu) does not flash the old one.
      void utils.workspace.nav.prefs.cancel();
      utils.workspace.nav.prefs.setData(undefined, next);
      saveInOrder(
        next,
        (p) => utils.client.workspace.nav.savePrefs.mutate(p),
        // The save did not go through: show what the account really has.
        () => void utils.workspace.nav.prefs.invalidate(),
      );
    },
    [userId, utils],
  );

  const toggleShortcut = useCallback(
    (path: string) =>
      update((p) => ({
        ...p,
        shortcuts: p.shortcuts.includes(path) ? p.shortcuts.filter((x) => x !== path) : [...p.shortcuts, path].slice(-NAV_PREFS_MAX_SHORTCUTS),
      })),
    [update],
  );

  const toggleFold = useCallback(
    (section: string) => update((p) => ({ ...p, folded: p.folded.includes(section) ? p.folded.filter((x) => x !== section) : [...p.folded, section] })),
    [update],
  );

  return { shortcuts: prefs.shortcuts, folded: prefs.folded, toggleShortcut, toggleFold };
}

/**
 * How many things are waiting on each menu page for this person (path → number; pages with
 * nothing waiting are left out). Refreshed every minute, when the person comes back to the tab,
 * and a moment after they save anything (so a bubble drops right after the work is done).
 */
export function useNavCounts(enabled: boolean): Record<string, number> {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const counts = trpc.workspace.nav.counts.useQuery(undefined, {
    enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.mutation.state.status !== "success") return;
      // Starring a page or folding a section changes nothing that is counted.
      if (JSON.stringify(event.mutation.options.mutationKey ?? "").includes('"nav"')) return;
      if (timer) return;
      // A moment after the save; then at most once every 10 seconds (pages that save as you type).
      const wait = Math.max(1200, lastAfterSave + 10_000 - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        lastAfterSave = Date.now();
        void utils.workspace.nav.counts.invalidate();
      }, wait);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [enabled, queryClient, utils]);

  return counts.data ?? NO_COUNTS;
}
