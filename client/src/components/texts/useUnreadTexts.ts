import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { popupsSupported } from "@/components/messages/useUnreadMessages";

// The newest unread patient text already announced (outside React: page changes remount the layout).
let announced: string | null | undefined;

/**
 * Unread patient texts for the Messages badge (checked every 20 seconds), plus a browser pop-up when a new
 * one comes in. The pop-up never shows the patient's name, number or what they wrote.
 */
export function useUnreadTexts(enabled: boolean): number {
  const [location, setLocation] = useLocation();
  const q = trpc.workspace.texts.unread.useQuery(undefined, { enabled, refetchInterval: 20_000, refetchIntervalInBackground: true, staleTime: 10_000 });
  const newest = q.data?.newest ?? null;
  const stamp = newest ? `${newest.threadId}:${new Date(newest.at ?? 0).getTime()}` : null;

  useEffect(() => {
    if (!q.data) return;
    if (announced === undefined) { announced = stamp; return; }
    if (!stamp || stamp === announced) return;
    announced = stamp;
    if (document.visibilityState === "visible" && location.startsWith("/messages")) return;
    if (!popupsSupported() || Notification.permission !== "granted" || !newest) return;
    try {
      const n = new Notification("New text from a patient", { body: "Open Messages → Patient texts to read it.", tag: "mypcp-text", icon: "/icon-192.png" });
      n.onclick = () => { window.focus(); setLocation(`/messages?tab=texts&t=${newest.threadId}`); n.close(); };
    } catch {
      /* the badge still shows */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, !!q.data]);

  return q.data?.total ?? 0;
}
