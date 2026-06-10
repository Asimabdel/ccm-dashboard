import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Loader2, UserCog, ShieldCheck } from "lucide-react";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
  { value: "user", label: "No access (pending)" },
] as const;

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
  const users = trpc.users.list.useQuery(undefined, { enabled: isAdmin });
  const utils = trpc.useUtils();

  const setRole = trpc.users.setRole.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); toast.success("Role updated."); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (!isAdmin) {
    return (
      <CCMDashboardLayout title="Team / Access">
        <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">
          Worker access management is restricted to administrators.
        </div>
      </CCMDashboardLayout>
    );
  }

  return (
    <CCMDashboardLayout title="Team / Access">
      <div className="flex items-center gap-2 mb-5 text-slate-500 text-sm">
        <ShieldCheck size={16} className="text-emerald-600" />
        Each worker signs in with their own Manus account. Assign their role here to grant the minimum access necessary for their job (HIPAA minimum-necessary principle).
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                <th className="px-5 py-3 font-medium">Worker</th>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Current Role</th>
                <th className="px-5 py-3 font-medium">Assign Role</th>
              </tr>
            </thead>
            <tbody>
              {users.isLoading && <tr><td colSpan={4} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!users.isLoading && (users.data || []).length === 0 && <tr><td colSpan={4} className="px-5 py-12 text-center text-slate-400 font-light">No workers yet. Invite staff to sign in, then assign their role here.</td></tr>}
              {(users.data || []).map((u) => {
                const isSelf = u.id === user.id;
                return (
                  <tr key={u.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-slate-800 flex items-center gap-1.5">
                        {u.name || "Unnamed"}
                        {isSelf && <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px]">You</span>}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{u.email || "—"}</td>
                    <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${roleBadge(u.role)}`}>{u.role.replace("_", " ")}</span></td>
                    <td className="px-5 py-3">
                      <select
                        className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] disabled:opacity-50"
                        value={u.role}
                        disabled={isSelf || setRole.isPending}
                        title={isSelf ? "You cannot change your own role" : undefined}
                        onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value as any })}
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400 flex items-center gap-1.5"><UserCog size={14} /> {(users.data || []).length} workers</p>
    </CCMDashboardLayout>
  );
}
