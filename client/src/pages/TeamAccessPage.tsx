import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Loader2, UserCog, ShieldCheck, Mail, UserPlus, Trash2, CheckCircle2, Clock } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
  { value: "user", label: "No access (pending)" },
] as const;

const ASSIGNABLE = ROLE_OPTIONS.filter((r) => r.value !== "user");

function roleBadge(role: string): string {
  switch (role) {
    case "admin": return "bg-purple-100 text-purple-700";
    case "staff": return "bg-blue-100 text-blue-700";
    case "provider": return "bg-emerald-100 text-emerald-700";
    case "billing": return "bg-amber-100 text-amber-800";
    case "front_desk": return "bg-cyan-100 text-cyan-700";
    default: return "bg-slate-100 text-slate-500";
  }
}

export default function TeamAccessPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const usersQuery = trpc.users.list.useQuery(undefined, { enabled: isAdmin });
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [newRole, setNewRole] = useState<string>("staff");
  const [clinicLocation, setClinicLocation] = useState("");
  const [removeTarget, setRemoveTarget] = useState<{ id: number; name: string } | null>(null);

  const setRole = trpc.users.setRole.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); toast.success("Role updated."); },
    onError: (e: { message: string }) => toast.error(e.message),
  });
  const createMember = trpc.members.create.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("Login created. They get this role automatically when they sign in with that email.");
      setEmail(""); setName(""); setClinicLocation("");
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });
  const removeMember = trpc.users.remove.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); toast.success("Access revoked."); setRemoveTarget(null); },
    onError: (e: { message: string }) => { toast.error(e.message); setRemoveTarget(null); },
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (!isAdmin) {
    return (
      <CCMDashboardLayout title="Team & Access">
        <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">
          Team management is restricted to administrators.
        </div>
      </CCMDashboardLayout>
    );
  }

  const field = "px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] transition";
  const allUsers = usersQuery.data || [];
  const pendingCount = allUsers.filter((u) => (u as { pending?: boolean }).pending).length;

  return (
    <CCMDashboardLayout title="Team & Access">
      <div className="flex items-center gap-2 mb-5 text-slate-500 text-sm">
        <ShieldCheck size={16} className="text-emerald-600" />
        Workers sign in with their own Manus account. Create a login by email to pre-assign a role; they get that role automatically the first time they sign in with that email (HIPAA minimum-necessary principle).
      </div>

      {/* Create login form */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6 mb-6">
        <div className="flex items-center gap-2 mb-4"><UserPlus size={17} className="text-[hsl(200_100%_45%)]" /><h3 className="font-bold text-slate-900">Create a worker login</h3></div>
        <form
          className="grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_1fr_auto] gap-3 items-end"
          onSubmit={(e) => { e.preventDefault(); if (!email) return; createMember.mutate({ email, name: name || undefined, role: newRole as "admin" | "staff" | "provider" | "billing" | "front_desk", clinicLocation: clinicLocation || undefined }); }}
        >
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Work email</label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nurse@clinic.com" className={`${field} w-full pl-9`} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Name <span className="text-slate-300">(optional)</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" className={`${field} w-full`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Role</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className={field}>
              {ASSIGNABLE.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Clinic location <span className="text-slate-300">(optional)</span></label>
            <input value={clinicLocation} onChange={(e) => setClinicLocation(e.target.value)} placeholder="e.g. Downtown" className={`${field} w-full`} />
          </div>
          <button type="submit" disabled={createMember.isPending || !email}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
            {createMember.isPending ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Create login
          </button>
        </form>
      </div>

      {/* Members */}
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2"><UserCog size={16} className="text-slate-400" /><h3 className="font-bold text-slate-900">Team members</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                <th className="px-5 py-3 font-medium">Worker</th>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Current Role</th>
                <th className="px-5 py-3 font-medium">Assign Role</th>
                <th className="px-5 py-3 font-medium text-right">Access</th>
              </tr>
            </thead>
            <tbody>
              {usersQuery.isLoading && <tr><td colSpan={6} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!usersQuery.isLoading && allUsers.length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-400 font-light">No workers yet. Create a login above.</td></tr>}
              {allUsers.map((u) => {
                const isSelf = u.id === user.id;
                const hasAccess = u.role !== "user";
                const pending = (u as { pending?: boolean }).pending;
                return (
                  <tr key={u.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-slate-800 flex items-center gap-1.5">
                        {u.name || "Unnamed"}
                        {isSelf && <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px]">You</span>}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{u.email || "—"}</td>
                    <td className="px-5 py-3">
                      {pending ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-semibold"><Clock size={11} /> Pending sign-in</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-semibold"><CheckCircle2 size={11} /> Active</span>
                      )}
                    </td>
                    <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${roleBadge(u.role)}`}>{u.role.replace("_", " ")}</span></td>
                    <td className="px-5 py-3">
                      <select
                        className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] disabled:opacity-50"
                        value={u.role}
                        disabled={isSelf || setRole.isPending}
                        title={isSelf ? "You cannot change your own role" : undefined}
                        onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value as "admin" | "staff" | "provider" | "billing" | "front_desk" | "user" })}
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {isSelf ? (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-300"><CheckCircle2 size={13} /> Owner</span>
                      ) : hasAccess || pending ? (
                        <button onClick={() => setRemoveTarget({ id: u.id, name: u.name || u.email || "this member" })}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-rose-500 hover:text-rose-700 px-2.5 py-1.5 rounded-lg hover:bg-rose-50 transition">
                          <Trash2 size={13} /> Remove
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">No access</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400 flex items-center gap-1.5"><UserCog size={14} /> {allUsers.length} workers · {pendingCount} pending sign-in</p>

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove team member?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes all access for <span className="font-semibold text-slate-700">{removeTarget?.name}</span>. They will no longer be able to view any patient data unless re-created. This is logged in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => removeTarget && removeMember.mutate(removeTarget.id)}
            >
              {removeMember.isPending ? <Loader2 size={15} className="animate-spin" /> : "Remove access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CCMDashboardLayout>
  );
}
