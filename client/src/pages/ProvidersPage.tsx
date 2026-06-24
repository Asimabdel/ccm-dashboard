import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Loader2, Stethoscope, Plus, Pencil, Trash2, Building2, ShieldCheck } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ProviderForm = { id?: number; name: string; title: string; clinicId: string; aliases: string };
const EMPTY: ProviderForm = { name: "", title: "", clinicId: "", aliases: "" };

export default function ProvidersPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const list = trpc.providers.all.useQuery(undefined, { enabled: !!user });
  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [removeTarget, setRemoveTarget] = useState<{ id: number; name: string } | null>(null);

  const invalidate = () => utils.providers.all.invalidate();
  const create = trpc.providers.create.useMutation({ onSuccess: () => { invalidate(); toast.success("Provider added."); setOpen(false); }, onError: (e) => toast.error(e.message) });
  const update = trpc.providers.update.useMutation({ onSuccess: () => { invalidate(); toast.success("Provider updated."); setOpen(false); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.providers.remove.useMutation({ onSuccess: () => { invalidate(); toast.success("Provider removed."); setRemoveTarget(null); }, onError: (e) => { toast.error(e.message); setRemoveTarget(null); } });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  if (!isAdmin) {
    return <CCMDashboardLayout title="Providers"><div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">Provider management is restricted to administrators.</div></CCMDashboardLayout>;
  }

  const openCreate = () => { setForm(EMPTY); setOpen(true); };
  const openEdit = (p: ProviderForm) => { setForm(p); setOpen(true); };
  const submit = () => {
    if (!form.name.trim()) { toast.error("Provider name is required."); return; }
    const aliases = form.aliases.split(",").map((a) => a.trim()).filter(Boolean);
    const payload = { name: form.name.trim(), title: form.title || undefined, clinicId: form.clinicId ? Number(form.clinicId) : undefined, aliases };
    if (form.id) update.mutate({ id: form.id, ...payload }); else create.mutate(payload);
  };

  const field = "w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] transition";
  const rows = list.data || [];

  return (
    <CCMDashboardLayout title="Providers">
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-slate-500 flex items-center gap-1.5"><ShieldCheck size={15} className="text-emerald-600" /> Add, edit, or remove the providers patients are paneled to.</p>
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition"><Plus size={15} /> Add provider</button>
      </div>

      {list.isLoading && <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <Stethoscope className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">No providers yet. Add your first provider.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Title</th>
                  <th className="px-5 py-3 font-medium">Clinic</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.provider.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-slate-800 flex items-center gap-2"><span className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center"><Stethoscope size={15} className="text-emerald-600" /></span>{r.provider.name}</p>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{r.provider.title || "—"}</td>
                    <td className="px-5 py-3 text-slate-500">{r.clinicName ? <span className="inline-flex items-center gap-1.5"><Building2 size={13} className="text-slate-400" /> {r.clinicName}{r.location ? ` · ${r.location}` : ""}</span> : "—"}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button onClick={() => openEdit({ id: r.provider.id, name: r.provider.name, title: r.provider.title || "", clinicId: r.provider.clinicId ? String(r.provider.clinicId) : "", aliases: (r.provider.aliases || []).join(", ") })} className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"><Pencil size={15} /></button>
                        <button onClick={() => setRemoveTarget({ id: r.provider.id, name: r.provider.name })} className="p-2 rounded-lg text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit provider" : "Add provider"}</DialogTitle>
            <DialogDescription>Providers can be linked to a clinic and assigned to patient panels.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Name *</label><input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dr. Jane Smith" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Title</label><input className={field} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="MD, Internal Medicine" /></div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Also known as (aliases)</label>
              <input className={field} value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="Sudad, Dr. Sudad" />
              <p className="text-[11px] text-slate-400 mt-1">Comma-separated. Used to match this provider on imported sheets (e.g. "Magdalene" for Maggie).</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Clinic</label>
              <select className={field} value={form.clinicId} onChange={(e) => setForm({ ...form, clinicId: e.target.value })}>
                <option value="">Unassigned</option>
                {(clinics.data || []).map((c) => <option key={c.id} value={String(c.id)}>{c.name} · {c.location}</option>)}
              </select>
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition">Cancel</button>
            <button onClick={submit} disabled={create.isPending || update.isPending} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
              {(create.isPending || update.isPending) && <Loader2 size={14} className="animate-spin" />} {form.id ? "Save changes" : "Add provider"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove provider?</AlertDialogTitle>
            <AlertDialogDescription>Remove <span className="font-semibold text-slate-700">{removeTarget?.name}</span>? Providers assigned to patients can't be removed until those patients are reassigned.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={() => removeTarget && remove.mutate(removeTarget.id)}>
              {remove.isPending ? <Loader2 size={15} className="animate-spin" /> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CCMDashboardLayout>
  );
}
