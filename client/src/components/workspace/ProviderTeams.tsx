import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mail, Pencil, Search, UsersRound } from "lucide-react";
import { Btn, inputCls } from "./ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { WORKSPACE_ROLE_LABELS } from "@shared/workspace";

/**
 * Admin → Providers: each provider's team (their MAs and anyone else who works with them).
 * Patient emails for a provider's patients go to that team: they show in everyone's My Work
 * until one of them takes it. The provider's own login is always on the team.
 */
export function ProviderTeams() {
  const q = trpc.workspace.teams.list.useQuery();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const save = trpc.workspace.teams.set.useMutation({
    onSuccess: () => { void utils.workspace.teams.invalidate(); setEditing(null); toast.success("Team saved. New emails for their patients go to this team."); },
    onError: (e) => toast.error(e.message),
  });

  const data = q.data;
  const editingProvider = data?.providers.find((p) => p.id === editing) ?? null;
  const choices = useMemo(() => {
    if (!data || !editingProvider) return [];
    const needle = search.trim().toLowerCase();
    return data.people
      .filter((u) => u.id !== editingProvider.login?.userId && (!needle || (u.name ?? "").toLowerCase().includes(needle)))
      // The provider's office's MAs first, then everyone else.
      .map((u) => ({ ...u, suggested: u.role === "medical_assistant" && !!editingProvider.clinicId && u.homeClinicId === editingProvider.clinicId }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [data, editingProvider, search]);

  const start = (id: number) => {
    const p = data?.providers.find((x) => x.id === id);
    setPicked(p?.members.map((m) => m.userId) ?? []);
    setSearch("");
    setEditing(id);
  };
  const toggle = (id: number) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <section className="mt-6 bg-white rounded-3xl border border-slate-200 dark:border-slate-700 p-6">
      <h3 className="flex items-center gap-2 font-bold tracking-tight text-slate-900 dark:text-slate-50"><UsersRound size={17} /> Provider teams</h3>
      <p className="mt-1 text-sm text-slate-500 flex items-start gap-1.5">
        <Mail size={14} className="mt-0.5 shrink-0" />
        Emails from a provider's patients go to that provider's team: the provider plus the people below. Each email shows in everyone's My Work until one of them takes it.
        Providers without a team keep the old routing (care coordinator, then the front desk).
      </p>
      {q.isLoading && <Loader2 size={16} className="mt-4 animate-spin text-slate-400" />}
      {q.error && <p className="mt-4 text-sm text-rose-600">{q.error.message}</p>}
      <ul className="mt-4 divide-y divide-slate-100 dark:divide-slate-700">
        {(data?.providers ?? []).map((p) => (
          <li key={p.id} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 dark:text-slate-50">{p.name}{p.clinicName ? <span className="font-normal text-slate-500"> · {p.clinicName}</span> : null}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.members.length === 0 ? (
                    <span className="text-xs text-slate-400">No team yet: their patients' emails use the old routing.</span>
                  ) : (
                    <>
                      {p.login ? <Chip strong>{p.login.name ?? p.name} (provider)</Chip> : <Chip muted>No provider login: only the team gets them</Chip>}
                      {p.members.map((m) => <Chip key={m.userId}>{m.name}{m.role ? ` · ${WORKSPACE_ROLE_LABELS[m.role] ?? m.role}` : ""}</Chip>)}
                    </>
                  )}
                </div>
              </div>
              {editing !== p.id && <Btn size="sm" variant="secondary" onClick={() => start(p.id)}><Pencil size={13} /> {p.members.length ? "Edit team" : "Set up team"}</Btn>}
            </div>
            {editing === p.id && (
              <div className="mt-3 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
                <div className="relative mb-3 max-w-xs">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input className={cn(inputCls, "py-1.5 pl-8 text-sm")} placeholder="Find a person…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
                  {choices.map((u) => (
                    <label key={u.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800", picked.includes(u.id) && "bg-teal-50 dark:bg-teal-950/40")}>
                      <input type="checkbox" className="size-4 accent-teal-700" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} />
                      <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">{u.name}</span>
                      <span className="shrink-0 text-xs text-slate-500">{WORKSPACE_ROLE_LABELS[u.role] ?? u.role}{u.suggested ? " · same office" : ""}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-500">{picked.length} picked{p.login ? `, plus ${p.name}` : ""}. Pick nobody to turn the team off.</p>
                  <div className="flex gap-2">
                    <Btn size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                    <Btn size="sm" disabled={save.isPending} onClick={() => save.mutate({ providerId: p.id, userIds: picked })}>{save.isPending && <Loader2 size={13} className="animate-spin" />} Save team</Btn>
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Chip({ children, strong, muted }: { children: React.ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs",
      strong ? "bg-teal-50 font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-200"
        : muted ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>
      {children}
    </span>
  );
}
