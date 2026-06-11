import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Loader2, Building2, Plus, Pencil, Trash2, MapPin, Phone, ShieldCheck } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ClinicForm = { id?: number; name: string; location: string; address: string; phone: string };
const EMPTY: ClinicForm = { name: "", location: "", address: "", phone: "" };

export default function ClinicsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const list = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ClinicForm>(EMPTY);
  const [removeTarget, setRemoveTarget] = useState<{ id: number; name: string } | null>(null);

  const invalidate = () => utils.clinics.list.invalidate();
  const create = trpc.clinics.create.useMutation({ onSuccess: () => { invalidate(); toast.success("Clinic added."); setOpen(false); }, onError: (e) => toast.error(e.message) });
  const update = trpc.clinics.update.useMutation({ onSuccess: () => { invalidate(); toast.success("Clinic updated."); setOpen(false); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.clinics.remove.useMutation({ onSuccess: () => { invalidate(); toast.success("Clinic removed."); setRemoveTarget(null); }, onError: (e) => { toast.error(e.message); setRemoveTarget(null); } });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  if (!isAdmin) {
    return <CCMDashboardLayout title="Clinics"><div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">Clinic management is restricted to administrators.</div></CCMDashboardLayout>;
  }

  const openCreate = () => { setForm(EMPTY); setOpen(true); };
  const openEdit = (c: ClinicForm) => { setForm(c); setOpen(true); };
  const submit = () => {
    if (!form.name.trim() || !form.location.trim()) { toast.error("Name and location are required."); return; }
    const payload = { name: form.name.trim(), location: form.location.trim(), address: form.address || undefined, phone: form.phone || undefined };
    if (form.id) update.mutate({ id: form.id, ...payload }); else create.mutate(payload);
  };

  const field = "w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] transition";
  const rows = list.data || [];

  return (
    <CCMDashboardLayout title="Clinics">
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-slate-500 flex items-center gap-1.5"><ShieldCheck size={15} className="text-emerald-600" /> Manage clinic locations used across patients and providers.</p>
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition"><Plus size={15} /> Add clinic</button>
      </div>

      {list.isLoading && <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <Building2 className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">No clinics yet. Add your first location.</p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rows.map((c) => (
          <div key={c.id} className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-5 group">
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 rounded-2xl bg-[hsl(200_60%_94%)] flex items-center justify-center"><Building2 size={18} className="text-[hsl(200_80%_35%)]" /></div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                <button onClick={() => openEdit({ id: c.id, name: c.name, location: c.location, address: c.address || "", phone: c.phone || "" })} className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"><Pencil size={15} /></button>
                <button onClick={() => setRemoveTarget({ id: c.id, name: c.name })} className="p-2 rounded-lg text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition"><Trash2 size={15} /></button>
              </div>
            </div>
            <h3 className="mt-3 font-bold text-slate-900">{c.name}</h3>
            <p className="text-sm text-slate-500 flex items-center gap-1.5 mt-1"><MapPin size={13} /> {c.location}</p>
            {c.address && <p className="text-xs text-slate-400 mt-2">{c.address}</p>}
            {c.phone && <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-1"><Phone size={12} /> {c.phone}</p>}
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit clinic" : "Add clinic"}</DialogTitle>
            <DialogDescription>Clinic locations are shared across patients and providers.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Name *</label><input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Riverside Family Medicine" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Location *</label><input className={field} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Downtown" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Address</label><input className={field} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, Suite 200" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1.5">Phone</label><input className={field} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" /></div>
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition">Cancel</button>
            <button onClick={submit} disabled={create.isPending || update.isPending} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
              {(create.isPending || update.isPending) && <Loader2 size={14} className="animate-spin" />} {form.id ? "Save changes" : "Add clinic"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove clinic?</AlertDialogTitle>
            <AlertDialogDescription>Remove <span className="font-semibold text-slate-700">{removeTarget?.name}</span>? Clinics assigned to patients or providers can't be removed until those are reassigned.</AlertDialogDescription>
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
