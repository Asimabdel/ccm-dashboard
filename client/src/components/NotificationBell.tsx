import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Bell, CheckCheck, Settings2, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/ccm";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { ALWAYS_ON, NOTIFICATION_KINDS, NOTIFICATION_KIND_LIST, type NotificationKind } from "@shared/notifications";

/** Where a notification opens, by kind. */
const OPENS: Partial<Record<NotificationKind, string>> = {
  my_tasks: "/my-work",
  team_tasks: "/my-work",
  program_approvals: "/program-approvals",
  documents: "/documents",
};

/** The top-bar bell: newest notifications, mark all read, clear all, and which kinds to get. */
export function NotificationBell() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data } = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });
  const refresh = () => utils.notifications.list.invalidate();
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: refresh });
  const markAll = trpc.notifications.markAllRead.useMutation({ onSuccess: refresh });
  const clearAll = trpc.notifications.clearAll.useMutation({
    onSuccess: (r) => { void refresh(); toast.success(r.cleared ? `Cleared ${r.cleared.toLocaleString()} notification${r.cleared === 1 ? "" : "s"}` : "Nothing to clear"); },
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Bell size={18} />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 bg-brand text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between">
            Notifications
            <span className="text-xs font-normal text-slate-400">{unread.toLocaleString()} unread</span>
          </DropdownMenuLabel>
          <div className="flex items-center gap-1 px-2 pb-1.5">
            <button type="button" disabled={!unread || markAll.isPending} onClick={() => markAll.mutate()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700">
              <CheckCheck size={13} /> Mark all read
            </button>
            <button type="button" disabled={!items.length || clearAll.isPending} onClick={() => { setMenuOpen(false); setConfirmClear(true); }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700">
              <Trash2 size={13} /> Clear all
            </button>
            <button type="button" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700">
              <Settings2 size={13} /> Settings
            </button>
          </div>
          <DropdownMenuSeparator />
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">No notifications</p>}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.read) markRead.mutate(n.id);
                  const to = OPENS[n.kind];
                  if (to) { setMenuOpen(false); setLocation(to); }
                }}
                className={cn(
                  "w-full text-left px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-50 dark:border-slate-700/50",
                  !n.read && "bg-slate-50 dark:bg-blue-900/20"
                )}
              >
                <div className="flex items-start gap-2">
                  {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full bg-brand shrink-0" />}
                  <div className={cn(n.read && "pl-4")}>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{n.title}</p>
                    {n.content && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{n.content}</p>}
                    <p className="text-[10px] text-slate-400 mt-1">{fmtDate(n.createdAt)} · {NOTIFICATION_KINDS[n.kind].label}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all notifications?</AlertDialogTitle>
            <AlertDialogDescription>
              This empties your bell for good. Your tasks, requests and documents stay where they are, so nothing you need to do is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={() => clearAll.mutate()}>Clear all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {settingsOpen && <NotificationSettings off={data?.off ?? []} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function NotificationSettings({ off, onClose }: { off: NotificationKind[]; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [offNow, setOffNow] = useState<NotificationKind[]>(off);
  const save = trpc.notifications.setOff.useMutation({
    onSuccess: (r) => { setOffNow(r.off); void utils.notifications.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const toggle = (k: NotificationKind, on: boolean) => {
    const next = on ? offNow.filter((x) => x !== k) : [...offNow, k];
    setOffNow(next);
    save.mutate({ off: next });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Notification settings</DialogTitle>
          <DialogDescription>Pick what shows up in your bell. Switching a type off also marks the ones already waiting as read. This only changes your bell, not anyone else's.</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {NOTIFICATION_KIND_LIST.map((k) => {
            const locked = ALWAYS_ON.includes(k);
            const on = locked || !offNow.includes(k);
            return (
              <li key={k} className="flex items-center justify-between gap-4 py-2.5">
                <label htmlFor={`notif-${k}`} className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{NOTIFICATION_KINDS[k].label}</span>
                  <span className="block text-xs text-slate-500">{NOTIFICATION_KINDS[k].hint}</span>
                </label>
                <Switch id={`notif-${k}`} checked={on} disabled={locked} onCheckedChange={(v) => toggle(k, v)} />
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
