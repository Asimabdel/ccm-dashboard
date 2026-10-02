import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

// The newest unread message already announced (kept outside React so moving between pages, which
// remounts the layout, doesn't announce it again). undefined = nothing loaded yet.
let announced: string | null | undefined;

export const popupsSupported = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Unread internal messages for the top bar and sidebar (checked every 15 seconds), plus a browser
 * pop-up when a new one arrives. The pop-up names only the sender: never the message, and never a
 * conversation title (a conversation about a patient is named after them). Muted conversations only
 * count (and pop up for) @mentions of you.
 */
export function useUnreadMessages(enabled: boolean): number {
  const [location, setLocation] = useLocation();
  const q = trpc.workspace.chat.unread.useQuery(undefined, { enabled, refetchInterval: 15_000, refetchIntervalInBackground: true, staleTime: 10_000 });
  const newest = q.data?.newest ?? null;
  const stamp = newest ? String(newest.messageId) : null;

  useEffect(() => {
    if (!q.data) return;
    // First load after signing in / reloading: what's already waiting shows as the badge, no pop-up.
    if (announced === undefined) { announced = stamp; return; }
    if (!stamp || stamp === announced) return;
    announced = stamp;
    // Reading messages right now: the page itself shows it.
    if (document.visibilityState === "visible" && location.startsWith("/messages")) return;
    if (!popupsSupported() || Notification.permission !== "granted" || !newest) return;
    try {
      // Never the message or the patient: just who, and whether it's a mention or a "patient ready".
      const from = newest.from ?? "Someone";
      const n = new Notification(newest.flow ? "A patient is ready" : newest.mention ? "You were mentioned" : "New message in MyPCP", {
        body: newest.flow ? `From ${from}. Open MyPCP to see who.` : newest.mention ? `${from} mentioned you.` : `From ${from}`,
        tag: "mypcp-message",
        icon: "/icon-192.png",
      });
      n.onclick = () => { window.focus(); setLocation(`/messages?c=${newest.conversationId}`); n.close(); };
    } catch {
      /* some browsers only allow pop-ups from a service worker: the badge still shows */
    }
    // Only a new newest message should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, !!q.data]);

  return q.data?.total ?? 0;
}
