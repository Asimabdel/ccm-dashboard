import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2, Sparkles, Users } from "lucide-react";
import type { DutyFrequency } from "@shared/workforce";
import { Field, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const FREQ: Record<DutyFrequency, { label: string; hint: string }> = {
  daily: { label: "Daily", hint: "checked off every shift" },
  weekly: { label: "Weekly", hint: "checked off once a week" },
  monthly: { label: "Monthly", hint: "checked off once a month" },
  as_needed: { label: "As needed", hint: "part of the job — not tracked" },
};

interface DutyDraft { id?: number; category: string; title: string; detail: string; frequency: DutyFrequency }

export function RolesTab() {
  const utils = trpc.useUtils();
  const roles = trpc.workforce.roles.list.useQuery();
  const [roleId, setRoleId] = useState<number | null>(null);
  const [roleDraft, setRoleDraft] = useState<{ id?: number; name: string; summary: string } | null>(null);
  const [dutyDraft, setDutyDraft] = useState<DutyDraft | null>(null);

  const refresh = () => utils.workforce.roles.invalidate();
  const onError = (e: { message: string }) => toast.error(e.message);
  const seed = trpc.workforce.roles.seedMaTemplate.useMutation({
    onSuccess: (r) => { refresh(); setRoleId(r.id); toast.success(r.created ? "Medical Assistant role created — edit it to match how you run your clinics" : "The Medical Assistant role already exists"); },
    onError,
  });
  const saveRole = trpc.workforce.roles.save.useMutation({ onSuccess: (r) => { refresh(); setRoleId(r.id); setRoleDraft(null); toast.success("Role saved"); }, onError });
  const archiveRole = trpc.workforce.roles.archive.useMutation({ onSuccess: () => { refresh(); setRoleId(null); toast.success("Role archived"); }, onError });
  const saveDuty = trpc.workforce.roles.saveDuty.useMutation({ onSuccess: () => { refresh(); setDutyDraft(null); toast.success("Saved"); }, onError });
  const archiveDuty = trpc.workforce.roles.archiveDuty.useMutation({ onSuccess: () => { refresh(); toast.success("Removed"); }, onError });

  const list = roles.data || [];
  useEffect(() => { if (roleId == null && list.length) setRoleId(list[0].id); }, [list, roleId]);
  const role = list.find((r) => r.id === roleId);
  const categories = Array.from(new Set((role?.duties || []).map((d) => d.category)));

  return (
    <div className="grid lg:grid-cols-[260px_1fr] gap-5">
      <div className="space-y-2">
        {roles.isLoading && <Loader2 className="animate-spin text-slate-400" />}
        {list.map((r) => (
          <button key={r.id} onClick={() => setRoleId(r.id)} className={`w-full text-left px-4 py-3 rounded-2xl border transition ${r.id === roleId ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-800 hover:bg-slate-50"}`}>
            <p className="font-semibold text-sm">{r.name}</p>
            <p className={`flex items-center gap-1 text-xs mt-0.5 ${r.id === roleId ? "text-slate-300" : "text-slate-400"}`}><Users size={11} /> {r.headcount} staff · {r.duties.length} duties</p>
          </button>
        ))}
        <button className={`${btnGhost} w-full`} onClick={() => setRoleDraft({ name: "", summary: "" })}><Plus size={14} /> New job role</button>
        {!list.some((r) => r.name === "Medical Assistant") && (
          <button className={`${btnGhost} w-full !text-emerald-700 !border-emerald-200 !bg-emerald-50`} disabled={seed.isPending} onClick={() => seed.mutate()}><Sparkles size={14} /> Load MA starter template</button>
        )}
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6 min-h-[300px]">
        {!role && !roles.isLoading && (
          <div className="text-sm text-slate-500 max-w-lg">
            <p className="font-semibold text-slate-800 text-base">Define what each job is responsible for.</p>
            <p className="mt-2">A job role is the single source of truth for a position across all four clinics: a short summary plus a list of duties. Daily, weekly, and monthly duties become the employee's check-off list on their <b>My Day</b> page, and completion feeds their scorecard.</p>
            <p className="mt-2">Start with <b>Load MA starter template</b> and edit it to match how you run your clinics.</p>
          </div>
        )}
        {role && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold tracking-tight text-slate-900">{role.name}</h3>
                {role.summary && <p className="mt-1 text-sm text-slate-600 max-w-2xl leading-relaxed">{role.summary}</p>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button className={btnGhost} onClick={() => setRoleDraft({ id: role.id, name: role.name, summary: role.summary ?? "" })}><Pencil size={14} /> Edit</button>
                <button className={btnGhost} title="Archive role" onClick={() => { if (confirm(`Archive the "${role.name}" role? Staff keep their history but lose this checklist.`)) archiveRole.mutate(role.id); }}><Trash2 size={14} /></button>
              </div>
            </div>

            {categories.map((cat) => (
              <div key={cat} className="mt-5">
                <p className="text-[11px] uppercase tracking-widest font-semibold text-slate-400 mb-1.5">{cat}</p>
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-2xl">
                  {role.duties.filter((d) => d.category === cat).map((d) => (
                    <li key={d.id} className="px-4 py-2.5 flex items-start gap-3 group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800">{d.title}</p>
                        {d.detail && <p className="text-xs text-slate-500 mt-0.5">{d.detail}</p>}
                      </div>
                      <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${d.frequency === "as_needed" ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-800"}`}>{FREQ[d.frequency].label}</span>
                      <button onClick={() => setDutyDraft({ id: d.id, category: d.category, title: d.title, detail: d.detail ?? "", frequency: d.frequency })} className="p-1 text-slate-300 hover:text-slate-700"><Pencil size={14} /></button>
                      <button onClick={() => archiveDuty.mutate(d.id)} className="p-1 text-slate-300 hover:text-rose-600"><Trash2 size={14} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <button className={`${btnPrimary} mt-5`} onClick={() => setDutyDraft({ category: categories[0] ?? "General", title: "", detail: "", frequency: "daily" })}><Plus size={14} /> Add duty</button>
          </>
        )}
      </div>

      {roleDraft && (
        <Modal title={roleDraft.id ? "Edit job role" : "New job role"} onClose={() => setRoleDraft(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); saveRole.mutate({ id: roleDraft.id, name: roleDraft.name, summary: roleDraft.summary.trim() || null }); }}>
            <Field label="Job title"><input required autoFocus value={roleDraft.name} onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })} className={inputCls} placeholder="e.g. Front Desk Coordinator" /></Field>
            <Field label="What this role is here to do"><textarea rows={4} value={roleDraft.summary} onChange={(e) => setRoleDraft({ ...roleDraft, summary: e.target.value })} className={inputCls} placeholder="One or two sentences an employee can read on day one." /></Field>
            <button type="submit" disabled={saveRole.isPending} className={`${btnPrimary} w-full`}>Save</button>
          </form>
        </Modal>
      )}

      {dutyDraft && role && (
        <Modal title={dutyDraft.id ? "Edit duty" : "Add duty"} onClose={() => setDutyDraft(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); saveDuty.mutate({ ...dutyDraft, jobRoleId: role.id, detail: dutyDraft.detail.trim() || null }); }}>
            <Field label="Duty"><input required autoFocus value={dutyDraft.title} onChange={(e) => setDutyDraft({ ...dutyDraft, title: e.target.value })} className={inputCls} placeholder="e.g. Stock and wipe down exam rooms" /></Field>
            <Field label="What 'done right' looks like (optional)"><textarea rows={2} value={dutyDraft.detail} onChange={(e) => setDutyDraft({ ...dutyDraft, detail: e.target.value })} className={inputCls} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Section">
                <input required list="duty-categories" value={dutyDraft.category} onChange={(e) => setDutyDraft({ ...dutyDraft, category: e.target.value })} className={inputCls} />
                <datalist id="duty-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="How often">
                <select value={dutyDraft.frequency} onChange={(e) => setDutyDraft({ ...dutyDraft, frequency: e.target.value as DutyFrequency })} className={inputCls}>
                  {(Object.keys(FREQ) as DutyFrequency[]).map((f) => <option key={f} value={f}>{FREQ[f].label}</option>)}
                </select>
              </Field>
            </div>
            <p className="text-xs text-slate-400">{FREQ[dutyDraft.frequency].label}: {FREQ[dutyDraft.frequency].hint}.</p>
            <button type="submit" disabled={saveDuty.isPending} className={`${btnPrimary} w-full`}>Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
