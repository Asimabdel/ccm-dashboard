import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Command as Cmdk } from "cmdk";
import {
  CornerDownLeft, Database, FileText, KeyRound, ListPlus, LogOut, MessageSquare, MessagesSquare, Phone, Printer, Search, Send, ShieldCheck, X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { NAV, type Role } from "@/lib/nav";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { useNavCounts } from "@/components/workspace/useNavMenu";
import { rcDial } from "@/components/phone/ringcentralStore";
import { NewTaskDialog } from "@/components/workspace/NewTaskDialog";
import { SendFaxDialog } from "@/components/fax/SendFaxDialog";
import { ExcuseNoteDialog } from "@/components/documents/ExcuseNoteDialog";
import { patientHref } from "@shared/folder";
import { FIND_ACTIONS, FIND_ACTION_INFO, parseFindQuery, type FindAction } from "@shared/findAnything";

const ACTION_ICON: Record<FindAction, React.ElementType> = { excuse: FileText, forms: Send, task: ListPlus, call: Phone, text: MessageSquare, fax: Printer, insurance: ShieldCheck };
const ACTION_TONE: Record<FindAction, string> = {
  excuse: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  forms: "bg-brand-soft text-brand dark:text-teal-300",
  task: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  call: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  text: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  fax: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  insurance: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
};
/** Quick buttons on a patient row (the first ones this person can use). */
const ROW_ACTIONS: FindAction[] = ["call", "forms", "excuse", "task"];

interface Person { key: string; patientId: number | null; name: string; hint: string; phone: string | null }

/** Bold the start of each name part that was typed. */
function Highlight({ name, words }: { name: string; words: string[] }) {
  const ws = words.map((w) => w.toLowerCase()).filter((w) => !/\d/.test(w));
  return (
    <>
      {name.split(" ").map((part, i) => {
        const w = ws.filter((x) => part.toLowerCase().startsWith(x)).sort((a, b) => b.length - a.length)[0];
        return <span key={i}>{i > 0 && " "}{w ? <><b className="font-bold text-brand dark:text-teal-300">{part.slice(0, w.length)}</b>{part.slice(w.length)}</> : part}</span>;
      })}
    </>
  );
}

const fmtDob = (d: string | null) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : null);

/**
 * Find anything (Ctrl K / ⌘K, or "/"): jump to a page or patient, and do things straight from here:
 * "note maria" makes an excuse note for Maria, "forms dan" sends Daniel his forms, "call 0142" calls
 * the patient whose phone ends in 0142. Recent patients and what's waiting show before anything is typed.
 * Mounted once in CCMDashboardLayout; the header search button opens it with an "open-command-palette" event.
 */
export function CommandPalette() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { caps } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [chip, setChip] = useState<FindAction | null>(null);
  const [selected, setSelected] = useState("");
  const [dialog, setDialog] = useState<"task" | "fax" | "excuse" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl K / ⌘K toggles; "/" opens when you're not typing somewhere; the header button sends an event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (document.querySelector("[role=dialog]")) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);
  useEffect(() => { if (!open) { setQuery(""); setChip(null); } }, [open]);

  // Debounce the patient search so we don't fire (and audit-log) a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const role = (user && user.role in NAV ? (user.role as Role) : "admin") as Role;
  const navItems = NAV[role] || [];
  const isAdmin = user?.role === "admin";
  const everyone = !!caps?.flowView;
  const allowed = (a: FindAction) =>
    a === "excuse" ? !!caps?.documents : a === "forms" ? !!caps?.intakeForms : a === "task" ? !!caps?.tasks : a === "fax" ? !!caps?.sendFax
      : a === "insurance" ? !!caps?.eligibility : a === "text" ? !!caps?.texts : a === "call" ? everyone : false;
  const actions = FIND_ACTIONS.filter(allowed);

  const parsed = parseFindQuery(debounced, chip);
  const action = parsed.action && allowed(parsed.action) ? parsed.action : null;
  const look = action ? parsed.rest : debounced;
  const words = look.split(/\s+/).filter(Boolean);
  const lookOk = look.replace(/\s/g, "").length >= 2;

  // Patients: everyone at the clinics for staff with the patient view; billing searches the CCM roster.
  const recent = trpc.workspace.patients.recent.useQuery(undefined, { enabled: open && everyone, staleTime: 10_000 });
  const directoryQ = trpc.workspace.directory.list.useQuery({ q: look, status: "all", sort: "name", page: 1 }, { enabled: open && lookOk && everyone });
  const rosterQ = trpc.patients.list.useQuery({ search: look }, { enabled: open && lookOk && !everyone && user?.role !== "medical_assistant" });
  const people = trpc.workspace.chat.people.useQuery(undefined, { enabled: open && !!caps?.messages && !!debounced && !action, staleTime: 5 * 60_000 });
  const waiting = useNavCounts(open && !!user);
  const openDm = trpc.workspace.chat.direct.useMutation({ onSuccess: (r) => setLocation(`/messages?c=${r.id}`), onError: (e) => toast.error(e.message) });
  const utils = trpc.useUtils();
  const seed = trpc.admin.seed.useMutation({
    onSuccess: async (s) => { toast.success(`Seeded ${s.patients} patients and ${s.tasks} tasks.`); await utils.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const found: Person[] = everyone
    ? (directoryQ.data?.rows ?? []).map((r) => ({ key: r.key, patientId: r.patientId, name: r.name, phone: r.phone ?? null, hint: [r.dob ? `DOB ${fmtDob(r.dob)}` : null, r.clinicName, r.phone].filter(Boolean).join(" · ") }))
    : (rosterQ.data ?? []).map((row) => ({ key: `p:${row.patient.id}`, patientId: row.patient.id, name: row.patient.name, phone: row.patient.phoneNumber ?? null, hint: [row.clinicName, row.patient.phoneNumber].filter(Boolean).join(" · ") }));
  const recents: Person[] = (recent.data ?? []).map((r) => ({ key: r.key, patientId: r.patientId, name: r.name, phone: r.phone ?? null, hint: [r.dob ? `DOB ${fmtDob(r.dob)}` : null, r.clinicName, r.phone].filter(Boolean).join(" · ") }));
  const searching = lookOk && (everyone ? directoryQ.isFetching : rosterQ.isFetching);

  const close = () => setOpen(false);
  const openPatient = (p: Person, tab?: string, extra?: string) => {
    close();
    setLocation(everyone ? patientHref(p.key, tab ?? "overview", extra) : `/patients/${p.key.slice(2)}`);
  };
  /** Do something for a patient (or, for a few things, without one). */
  const run = (a: FindAction, p: Person | null) => {
    if (!p) {
      if (a === "task" || a === "fax" || a === "excuse") { close(); setDialog(a); return; }
      setChip(a); setQuery(""); inputRef.current?.focus(); return;
    }
    if (!everyone) { openPatient(p); return; }
    if (a === "call") {
      if (!p.phone) { toast.error(`There's no phone number on file for ${p.name}.`); return; }
      close();
      if (!rcDial(p.phone, { patientId: p.patientId, subjectKey: p.key, name: p.name, source: "search" })) {
        const digits = p.phone.replace(/\D/g, "").slice(-10);
        if (digits.length === 10) window.location.href = `tel:+1${digits}`;
      }
      return;
    }
    if (a === "insurance") { openPatient(p, "insurance"); return; }
    openPatient(p, "overview", `do=${a}`);
  };

  // What the list shows, in order. Values are unique ids; cmdk keeps the arrow-key selection on them.
  type Row = { id: string; group: string; node: React.ReactNode; onSelect: () => void };
  const rows: Row[] = [];
  const patientRow = (group: string, p: Person, title: React.ReactNode, onSelect: () => void, quick: boolean) => rows.push({
    id: `${group}:${p.key}`, group, onSelect,
    node: (
      <>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand dark:text-teal-300">{p.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
          <span className="block truncate text-xs text-slate-500">{p.hint}</span>
        </span>
        {quick && everyone && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-data-[selected=true]:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
            {ROW_ACTIONS.filter(allowed).filter((a) => a !== "call" || p.phone).slice(0, 3).map((a) => {
              const Icon = ACTION_ICON[a];
              return (
                <button key={a} type="button" title={`${FIND_ACTION_INFO[a].label}`} aria-label={`${FIND_ACTION_INFO[a].label}: ${p.name}`}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); run(a, p); }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-brand dark:hover:bg-slate-700 dark:hover:text-teal-300">
                  <Icon size={16} />
                </button>
              );
            })}
          </span>
        )}
        {!quick && <CornerDownLeft size={15} className="shrink-0 text-brand opacity-0 group-data-[selected=true]:opacity-100 dark:text-teal-300" />}
      </>
    ),
  });
  const actionRow = (group: string, id: string, a: FindAction, title: React.ReactNode, sub: string, onSelect: () => void) => {
    const Icon = ACTION_ICON[a];
    rows.push({
      id: `${group}:${id}`, group, onSelect,
      node: (
        <>
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", ACTION_TONE[a])}><Icon size={16} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
            <span className="block truncate text-xs text-slate-500">{sub}</span>
          </span>
          <CornerDownLeft size={15} className="shrink-0 text-brand opacity-0 group-data-[selected=true]:opacity-100 dark:text-teal-300" />
        </>
      ),
    });
  };
  const plainRow = (group: string, id: string, Icon: React.ElementType, title: React.ReactNode, sub: string | null, onSelect: () => void, badge?: number) => rows.push({
    id: `${group}:${id}`, group, onSelect,
    node: (
      <>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"><Icon size={16} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
          {sub && <span className="block truncate text-xs text-slate-500">{sub}</span>}
        </span>
        {badge ? <span className="shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">{badge > 99 ? "99+" : badge}</span> : null}
        <CornerDownLeft size={15} className="shrink-0 text-brand opacity-0 group-data-[selected=true]:opacity-100 dark:text-teal-300" />
      </>
    ),
  });

  if (action) {
    const info = FIND_ACTION_INFO[action];
    const list = words.length ? found : chip ? recents : [];
    list.slice(0, 6).forEach((p) => patientRow(words.length ? "Do it" : "Recent patients", p, <>{info.lead} <Highlight name={p.name} words={words} /></>, () => run(action, p), false));
    if (!chip && !words.length) actionRow("Do it", `pick-${action}`, action, `${info.lead}…`, "Pick the patient next", () => run(action, null));
    if (!info.needsPatient && !words.length) actionRow("Do it", `none-${action}`, action, <>{info.label} <span className="font-normal text-slate-500">· without a patient</span></>, info.hint, () => { close(); setDialog(action as "task" | "fax" | "excuse"); });
  } else if (!debounced) {
    recents.slice(0, 5).forEach((p) => patientRow("Recent patients", p, p.name, () => openPatient(p), true));
    actions.filter((a) => a !== "call" && a !== "text").forEach((a) => actionRow("Do something", a, a, `${FIND_ACTION_INFO[a].lead}…`, FIND_ACTION_INFO[a].hint, () => { setChip(a); setQuery(""); inputRef.current?.focus(); }));
    navItems.filter((n) => (waiting[n.path] ?? 0) > 0).slice(0, 5).forEach((n) => plainRow("Waiting on you", n.path, n.icon, n.label, null, () => { close(); setLocation(n.path); }, waiting[n.path]));
    navItems.forEach((n) => plainRow("Go to", n.path, n.icon, n.label, null, () => { close(); setLocation(n.path); }));
  } else {
    found.slice(0, 6).forEach((p) => patientRow("Patients", p, <Highlight name={p.name} words={words} />, () => openPatient(p), true));
    if (found.length === 1 && everyone) {
      const p = found[0];
      actions.filter((a) => a !== "call" || p.phone).forEach((a) => actionRow(`For ${p.name}`, a, a, a === "call" ? `Call ${p.phone}` : FIND_ACTION_INFO[a].label, FIND_ACTION_INFO[a].hint, () => run(a, p)));
    }
    const ql = debounced.toLowerCase();
    const matches = (label: string) => label.toLowerCase().includes(ql) || words.every((w) => label.toLowerCase().split(/\s+/).some((x) => x.startsWith(w.toLowerCase())));
    navItems.filter((n) => matches(n.label)).slice(0, 5).forEach((n) => plainRow("Pages", n.path, n.icon, n.label, null, () => { close(); setLocation(n.path); }, waiting[n.path]));
    (people.data ?? []).filter((s) => s.id !== user?.id && s.name && words.every((w) => s.name!.toLowerCase().split(/[\s,.]+/).some((x) => x.startsWith(w.toLowerCase())))).slice(0, 3)
      .forEach((s) => plainRow("Team", `dm-${s.id}`, MessagesSquare, `Message ${s.name}`, null, () => { close(); openDm.mutate({ userId: s.id }); }));
    const account: [string, React.ElementType, string, () => void][] = [
      ["password", KeyRound, "Change password", () => { close(); setLocation("/change-password"); }],
      ["signout", LogOut, "Sign out", () => { close(); void logout().then(() => setLocation("/")); }],
      ...(isAdmin ? [
        ["audit", ShieldCheck, "Open audit log", () => { close(); setLocation("/audit"); }],
        ["seed", Database, "Seed demo data", () => { close(); seed.mutate(); }],
      ] as [string, React.ElementType, string, () => void][] : []),
    ];
    account.filter(([, , label]) => matches(label)).forEach(([id, Icon, label, fn]) => plainRow("Account", id, Icon, label, null, fn));
  }
  if (!debounced && !action) {
    plainRow("Account", "password", KeyRound, "Change password", null, () => { close(); setLocation("/change-password"); });
    plainRow("Account", "signout", LogOut, "Sign out", null, () => { close(); void logout().then(() => setLocation("/")); });
  }
  const groups = rows.reduce<{ name: string; rows: Row[] }[]>((acc, r) => {
    const g = acc.find((x) => x.name === r.group);
    if (g) g.rows.push(r); else acc.push({ name: r.group, rows: [r] });
    return acc;
  }, []);

  // Keep the first row picked as the list changes (so Enter always does the top thing).
  const firstId = rows[0]?.id ?? "";
  const ids = rows.map((r) => r.id).join("|");
  useEffect(() => { setSelected(firstId); }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;
  const placeholder = chip ? "Which patient? Name, date of birth or phone" : "Search, or type what to do: “note maria”, “forms 0142”";

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[12vh] translate-y-0 gap-0 overflow-hidden rounded-2xl border-slate-200 bg-white p-0 shadow-2xl sm:max-w-[680px] dark:border-slate-700 dark:bg-slate-800 max-sm:top-0 max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
          onEscapeKeyDown={(e) => { if (chip) { e.preventDefault(); setChip(null); } }}
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        >
          <DialogTitle className="sr-only">Find anything</DialogTitle>
          <DialogDescription className="sr-only">Search patients, pages and people, or type what to do.</DialogDescription>
          <Cmdk shouldFilter={false} loop value={selected} onValueChange={setSelected} className="flex h-full max-h-[min(640px,78vh)] flex-col max-sm:max-h-none">
            <div className="flex min-h-14 items-center gap-2.5 border-b border-slate-200 px-4 dark:border-slate-700">
              <Search size={18} className="shrink-0 text-slate-400" />
              {chip && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-soft py-1 pl-2.5 pr-1 text-sm font-semibold text-brand dark:text-teal-300">
                  {FIND_ACTION_INFO[chip].lead}
                  <button type="button" aria-label="Remove" className="flex h-5 w-5 items-center justify-center rounded hover:bg-black/5" onClick={() => { setChip(null); inputRef.current?.focus(); }}><X size={13} /></button>
                </span>
              )}
              <Cmdk.Input
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                onKeyDown={(e) => { if (e.key === "Backspace" && !query && chip) setChip(null); }}
                placeholder={placeholder}
                className="h-14 min-w-0 flex-1 border-0 !bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
              />
              <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:inline dark:border-slate-600">Esc</kbd>
              <button type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 sm:hidden" aria-label="Close" onClick={close}><X size={18} /></button>
            </div>
            <Cmdk.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2.5 pt-1 max-sm:max-h-none">
              <Cmdk.Empty className="px-6 py-10 text-center text-sm text-slate-500">
                {searching ? "Searching…" : <>Nothing matches “{query}”.<br />Try a name, date of birth or phone, or words like <b>note</b>, <b>forms</b>, <b>task</b> or <b>fax</b>.</>}
              </Cmdk.Empty>
              {groups.map((g) => (
                <Cmdk.Group key={g.name} heading={g.name} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.09em] [&_[cmdk-group-heading]]:text-slate-500">
                  {g.rows.map((r) => (
                    <Cmdk.Item key={r.id} value={r.id} onSelect={r.onSelect}
                      className="group flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 outline-none data-[selected=true]:bg-brand-soft">
                      {r.node}
                    </Cmdk.Item>
                  ))}
                </Cmdk.Group>
              ))}
            </Cmdk.List>
            <div className="hidden items-center gap-4 border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500 sm:flex dark:border-slate-700 dark:bg-slate-900/40">
              <span><kbd className="rounded border border-slate-200 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">↑</kbd> <kbd className="rounded border border-slate-200 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">↓</kbd> move</span>
              <span><kbd className="rounded border border-slate-200 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">Enter</kbd> open</span>
              <span className="ml-auto truncate">Try “forms dan”, “call 0142”, “task”</span>
            </div>
          </Cmdk>
        </DialogContent>
      </Dialog>

      {/* Things done without a patient picked */}
      <NewTaskDialog open={dialog === "task"} onOpenChange={(o) => !o && setDialog(null)} />
      {caps?.sendFax && <SendFaxDialog open={dialog === "fax"} onOpenChange={(o) => !o && setDialog(null)} />}
      {caps?.documents && <ExcuseNoteDialog open={dialog === "excuse"} onClose={() => setDialog(null)} onCreated={(id) => setLocation(`/documents/${id}`)} />}
    </>
  );
}
