import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Loader2, Pencil, Shuffle, UserPlus } from "lucide-react";
import { Field, Modal, btnPrimary, inputCls } from "./ui";

interface ProfileDraft {
  userId: number; name: string | null; jobRoleId: number | null; homeClinicId: number | null;
  canFloat: boolean; hoursPerWeek: number; hireDate: string; active: boolean;
}

export function PeopleTab() {
  const utils = trpc.useUtils();
  const people = trpc.workforce.people.list.useQuery();
  const roles = trpc.workforce.roles.list.useQuery();
  const clinics = trpc.clinics.list.useQuery();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [adding, setAdding] = useState<{ name: string; jobRoleId: number | null; homeClinicId: number | null } | null>(null);
  const add = trpc.workforce.people.add.useMutation({
    onSuccess: () => { utils.workforce.invalidate(); setAdding(null); toast.success("Employee added"); },
    onError: (e) => toast.error(e.message),
  });
  const save = trpc.workforce.people.saveProfile.useMutation({
    onSuccess: () => { utils.workforce.invalidate(); setDraft(null); toast.success("Profile saved"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="text-sm text-slate-500 max-w-2xl">
          Your whole team. Give each employee a job role and home clinic so they show up on the schedule, get their checklist, and can be found for coverage.
          To let someone clock in and see their schedule, give them a login on <Link href="/team" className="font-semibold text-slate-700 underline">Team &amp; Access</Link> — choose the <b>Medical Assistant</b> access level for MAs (Patient Flow, their tasks, schedule and time clock for their home clinic; no CCM, BHI or billing data).
        </p>
        <button className={`${btnPrimary} shrink-0`} onClick={() => setAdding({ name: "", jobRoleId: null, homeClinicId: null })}><UserPlus size={15} /> Add employee</button>
      </div>
      {people.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      {!!people.data?.length && (
        <div className="bg-white rounded-3xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-widest font-medium text-slate-400">
                <th className="text-left px-4 py-3">Employee</th><th className="text-left px-3 py-3">Job role</th><th className="text-left px-3 py-3">Home clinic</th>
                <th className="px-3 py-3 text-center">Hours / wk</th><th className="px-3 py-3 text-center">Status</th><th />
              </tr>
            </thead>
            <tbody>
              {people.data.map((p) => (
                <tr key={p.userId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3"><p className="font-semibold text-slate-800">{p.name ?? p.email}</p><p className="text-xs text-slate-400">{p.accessRole === "user" ? "No login yet" : `${p.email} · ${p.accessRole.replace("_", " ")}`}</p></td>
                  <td className="px-3 py-3 text-slate-700">{p.jobRoleName ?? <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-3 text-slate-700">{p.homeClinicName ?? <span className="text-slate-300">—</span>}{p.canFloat && <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700"><Shuffle size={11} /> floats</span>}</td>
                  <td className="px-3 py-3 text-center text-slate-700">{p.profileId ? p.hoursPerWeek : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${!p.profileId ? "bg-amber-100 text-amber-800" : p.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{!p.profileId ? "Not set up" : p.active ? "Active" : "Inactive"}</span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button onClick={() => setDraft({ userId: p.userId, name: p.name, jobRoleId: p.jobRoleId, homeClinicId: p.homeClinicId, canFloat: !!p.canFloat, hoursPerWeek: p.hoursPerWeek ?? 40, hireDate: p.hireDate ?? "", active: p.active ?? true })}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100"><Pencil size={12} /> {p.profileId ? "Edit" : "Set up"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal title="Add employee" onClose={() => setAdding(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(adding); }}>
            <Field label="Full name"><input required autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} className={inputCls} /></Field>
            <Field label="Job role (optional)">
              <select value={adding.jobRoleId ?? ""} onChange={(e) => setAdding({ ...adding, jobRoleId: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                <option value="">— none —</option>
                {(roles.data || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <Field label="Home clinic (optional)">
              <select value={adding.homeClinicId ?? ""} onChange={(e) => setAdding({ ...adding, homeClinicId: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                <option value="">— none —</option>
                {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <p className="text-xs text-slate-400">This adds them to the schedule and scorecards without a login. You can give them one later on Team &amp; Access.</p>
            <button type="submit" disabled={add.isPending || !adding.name.trim()} className={`${btnPrimary} w-full`}>{add.isPending ? "Adding…" : "Add employee"}</button>
          </form>
        </Modal>
      )}

      {draft && (
        <Modal title={draft.name ?? "Employee"} onClose={() => setDraft(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ userId: draft.userId, jobRoleId: draft.jobRoleId, homeClinicId: draft.homeClinicId, canFloat: draft.canFloat, hoursPerWeek: draft.hoursPerWeek, hireDate: draft.hireDate || null, active: draft.active }); }}>
            <Field label="Job role">
              <select value={draft.jobRoleId ?? ""} onChange={(e) => setDraft({ ...draft, jobRoleId: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                <option value="">— none —</option>
                {(roles.data || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <Field label="Home clinic">
              <select value={draft.homeClinicId ?? ""} onChange={(e) => setDraft({ ...draft, homeClinicId: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                <option value="">— none —</option>
                {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Target hours / week"><input type="number" min={0} max={80} value={draft.hoursPerWeek} onChange={(e) => setDraft({ ...draft, hoursPerWeek: Number(e.target.value) })} className={inputCls} /></Field>
              <Field label="Hire date"><input type="date" value={draft.hireDate} onChange={(e) => setDraft({ ...draft, hireDate: e.target.value })} className={inputCls} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={draft.canFloat} onChange={(e) => setDraft({ ...draft, canFloat: e.target.checked })} /> Can float to other clinics for coverage</label>
            <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active employee</label>
            <button type="submit" disabled={save.isPending} className={`${btnPrimary} w-full`}>{save.isPending ? "Saving…" : "Save profile"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
