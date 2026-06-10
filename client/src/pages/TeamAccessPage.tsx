import { FormEvent, useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Building2,
  CheckCircle2,
  Loader2,
  MailPlus,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Stethoscope,
  Trash2,
  UserCog,
  Users,
  X,
} from "lucide-react";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
  { value: "user", label: "No access" },
] as const;

type RoleValue = (typeof ROLE_OPTIONS)[number]["value"];
type TeamForm = {
  name: string;
  email: string;
  role: RoleValue;
};
type InviteForm = { email: string; role: RoleValue; clinicLocation: string };
type ProviderForm = { name: string; title: string; clinicId: string; userId: string };
type ClinicForm = { name: string; location: string; address: string; phone: string };

const emptyInvite: InviteForm = { email: "", role: "staff", clinicLocation: "" };
const emptyProvider: ProviderForm = { name: "", title: "", clinicId: "", userId: "" };
const emptyClinic: ClinicForm = { name: "", location: "", address: "", phone: "" };

function roleBadge(role: string): string {
  switch (role) {
    case "admin":
      return "bg-violet-100 text-violet-700 ring-violet-200";
    case "staff":
      return "bg-sky-100 text-sky-700 ring-sky-200";
    case "provider":
      return "bg-emerald-100 text-emerald-700 ring-emerald-200";
    case "billing":
      return "bg-amber-100 text-amber-800 ring-amber-200";
    case "front_desk":
      return "bg-cyan-100 text-cyan-700 ring-cyan-200";
    default:
      return "bg-slate-100 text-slate-500 ring-slate-200";
  }
}

function statusBadge(status: string): string {
  if (status === "pending") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (status === "accepted") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  return "bg-slate-100 text-slate-500 ring-slate-200";
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "Not set";
}

function Card({
  title,
  subtitle,
  icon,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/50">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-slate-900 p-2.5 text-white shadow-sm">{icon}</div>
          <div>
            <h2 className="text-base font-semibold text-slate-950">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5 text-sm font-medium text-slate-700">
      <span>{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export default function TeamAccessPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const users = trpc.users.list.useQuery(undefined, { enabled: isAdmin });
  const invites = trpc.invites.list.useQuery(undefined, { enabled: isAdmin });
  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: isAdmin });
  const providers = trpc.providers.all.useQuery(undefined, { enabled: isAdmin });

  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [teamForm, setTeamForm] = useState<TeamForm>({ name: "", email: "", role: "staff" });
  const [inviteForm, setInviteForm] = useState<InviteForm>(emptyInvite);
  const [editingProviderId, setEditingProviderId] = useState<number | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm>(emptyProvider);
  const [editingClinicId, setEditingClinicId] = useState<number | null>(null);
  const [clinicForm, setClinicForm] = useState<ClinicForm>(emptyClinic);

  const clinicOptions = useMemo(() => clinics.data || [], [clinics.data]);
  const providerUsers = useMemo(() => (users.data || []).filter((member) => member.role === "provider"), [users.data]);
  const activeInvites = useMemo(() => (invites.data || []).filter((invite) => invite.status !== "revoked"), [invites.data]);

  const refreshAdminData = () => {
    utils.users.list.invalidate();
    utils.invites.list.invalidate();
    utils.clinics.list.invalidate();
    utils.providers.all.invalidate();
  };

  const updateUser = trpc.users.update.useMutation({
    onSuccess: () => {
      setEditingUserId(null);
      refreshAdminData();
      toast.success("Team member updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeUser = trpc.users.remove.useMutation({
    onSuccess: () => {
      refreshAdminData();
      toast.success("Team access removed.");
    },
    onError: (e) => toast.error(e.message),
  });

  const sendInvite = trpc.invites.send.useMutation({
    onSuccess: () => {
      setInviteForm(emptyInvite);
      utils.invites.list.invalidate();
      toast.success("Invite created.");
    },
    onError: (e) => toast.error(e.message),
  });

  const revokeInvite = trpc.invites.revoke.useMutation({
    onSuccess: () => {
      utils.invites.list.invalidate();
      toast.success("Invite revoked.");
    },
    onError: (e) => toast.error(e.message),
  });

  const createClinic = trpc.clinics.create.useMutation({
    onSuccess: () => {
      setClinicForm(emptyClinic);
      refreshAdminData();
      toast.success("Clinic added.");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateClinic = trpc.clinics.update.useMutation({
    onSuccess: () => {
      setEditingClinicId(null);
      setClinicForm(emptyClinic);
      refreshAdminData();
      toast.success("Clinic updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeClinic = trpc.clinics.remove.useMutation({
    onSuccess: () => {
      refreshAdminData();
      toast.success("Clinic removed.");
    },
    onError: (e) => toast.error(e.message),
  });

  const createProvider = trpc.providers.create.useMutation({
    onSuccess: () => {
      setProviderForm(emptyProvider);
      refreshAdminData();
      toast.success("Provider added.");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateProvider = trpc.providers.update.useMutation({
    onSuccess: () => {
      setEditingProviderId(null);
      setProviderForm(emptyProvider);
      refreshAdminData();
      toast.success("Provider updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeProvider = trpc.providers.remove.useMutation({
    onSuccess: () => {
      refreshAdminData();
      toast.success("Provider removed.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <CCMDashboardLayout title="Team / Access">
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Worker access management is restricted to administrators.
        </div>
      </CCMDashboardLayout>
    );
  }

  const startEditUser = (member: NonNullable<typeof users.data>[number]) => {
    setEditingUserId(member.id);
    setTeamForm({
      name: member.name || "",
      email: member.email || "",
      role: member.role as RoleValue,
    });
  };

  const submitUser = (event: FormEvent) => {
    event.preventDefault();
    if (!editingUserId) return;
    updateUser.mutate({
      id: editingUserId,
      name: teamForm.name.trim(),
      email: teamForm.email.trim(),
      role: teamForm.role,
    });
  };

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();
    sendInvite.mutate({
      email: inviteForm.email.trim(),
      role: inviteForm.role,
      clinicLocation: inviteForm.clinicLocation.trim() || undefined,
    });
  };

  const startEditClinic = (clinic: NonNullable<typeof clinics.data>[number]) => {
    setEditingClinicId(clinic.id);
    setClinicForm({
      name: clinic.name,
      location: clinic.location,
      address: clinic.address || "",
      phone: clinic.phone || "",
    });
  };

  const submitClinic = (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      name: clinicForm.name.trim(),
      location: clinicForm.location.trim(),
      address: clinicForm.address.trim() || undefined,
      phone: clinicForm.phone.trim() || undefined,
    };
    if (editingClinicId) updateClinic.mutate({ id: editingClinicId, ...payload });
    else createClinic.mutate(payload);
  };

  const startEditProvider = (row: NonNullable<typeof providers.data>[number]) => {
    setEditingProviderId(row.provider.id);
    setProviderForm({
      name: row.provider.name,
      title: row.provider.title || "",
      clinicId: row.provider.clinicId ? String(row.provider.clinicId) : "",
      userId: row.provider.userId ? String(row.provider.userId) : "",
    });
  };

  const submitProvider = (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      name: providerForm.name.trim(),
      title: providerForm.title.trim() || undefined,
      clinicId: providerForm.clinicId ? Number(providerForm.clinicId) : undefined,
      userId: providerForm.userId ? Number(providerForm.userId) : undefined,
    };
    if (editingProviderId) updateProvider.mutate({ id: editingProviderId, ...payload });
    else createProvider.mutate(payload);
  };

  const confirmRemove = (label: string) => window.confirm(`Remove ${label}? This cannot be undone from this screen.`);

  const busy =
    updateUser.isPending ||
    removeUser.isPending ||
    sendInvite.isPending ||
    revokeInvite.isPending ||
    createClinic.isPending ||
    updateClinic.isPending ||
    removeClinic.isPending ||
    createProvider.isPending ||
    updateProvider.isPending ||
    removeProvider.isPending;

  return (
    <CCMDashboardLayout title="Team / Access">
      <div className="mb-6 rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-6 text-white shadow-lg shadow-slate-300/40">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-slate-200 ring-1 ring-white/15">
              <ShieldCheck size={14} />
              Administrative command center
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Manage people, providers, and clinic locations.</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Invite new team members, adjust access, keep provider names current, and maintain clinic details from one modern workspace.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15">
              <p className="text-2xl font-semibold">{(users.data || []).length}</p>
              <p className="text-xs text-slate-300">Team</p>
            </div>
            <div className="rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15">
              <p className="text-2xl font-semibold">{(providers.data || []).length}</p>
              <p className="text-xs text-slate-300">Providers</p>
            </div>
            <div className="rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15">
              <p className="text-2xl font-semibold">{clinicOptions.length}</p>
              <p className="text-xs text-slate-300">Clinics</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <div className="space-y-6">
          <Card
            title="Team Members"
            subtitle="Edit names and roles, then remove access when someone leaves."
            icon={<Users size={20} />}
          >
            {users.isLoading ? (
              <div className="py-12 text-center"><Loader2 className="mx-auto animate-spin text-slate-300" /></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-3 font-medium">Member</th>
                      <th className="px-3 py-3 font-medium">Email</th>
                      <th className="px-3 py-3 font-medium">Role</th>
                      <th className="px-3 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(users.data || []).map((member) => {
                      const isSelf = member.id === user.id;
                      return (
                        <tr key={member.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/80">
                          <td className="px-3 py-3">
                            <div className="font-semibold text-slate-900">
                              {textValue(member.name)}
                              {isSelf && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">You</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-500">{textValue(member.email)}</td>
                          <td className="px-3 py-3">
                            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ring-1 ${roleBadge(member.role)}`}>
                              {member.role.replace("_", " ")}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <button className={`${buttonClass} bg-slate-100 text-slate-700 hover:bg-slate-200`} onClick={() => startEditUser(member)} disabled={busy}>
                                <Pencil size={15} /> Edit
                              </button>
                              <button
                                className={`${buttonClass} bg-rose-50 text-rose-700 hover:bg-rose-100`}
                                onClick={() => confirmRemove(member.name || member.email || "this team member") && removeUser.mutate(member.id)}
                                disabled={busy || isSelf}
                                title={isSelf ? "You cannot remove your own access" : undefined}
                              >
                                <Trash2 size={15} /> Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {(users.data || []).length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-12 text-center text-slate-400">No workers yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Providers"
            subtitle="Add, edit, and remove provider display names used across patient records."
            icon={<Stethoscope size={20} />}
            action={
              editingProviderId ? (
                <button className={`${buttonClass} bg-slate-100 text-slate-700`} onClick={() => { setEditingProviderId(null); setProviderForm(emptyProvider); }}>
                  <X size={15} /> Cancel edit
                </button>
              ) : null
            }
          >
            <form className="mb-5 grid gap-3 md:grid-cols-5" onSubmit={submitProvider}>
              <Field label="Provider name">
                <input className={inputClass} value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} required />
              </Field>
              <Field label="Title">
                <input className={inputClass} value={providerForm.title} onChange={(e) => setProviderForm({ ...providerForm, title: e.target.value })} placeholder="MD, NP, PA" />
              </Field>
              <Field label="Clinic">
                <select className={inputClass} value={providerForm.clinicId} onChange={(e) => setProviderForm({ ...providerForm, clinicId: e.target.value })}>
                  <option value="">Unassigned</option>
                  {clinicOptions.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
                </select>
              </Field>
              <Field label="Linked user">
                <select className={inputClass} value={providerForm.userId} onChange={(e) => setProviderForm({ ...providerForm, userId: e.target.value })}>
                  <option value="">None</option>
                  {providerUsers.map((member) => <option key={member.id} value={member.id}>{member.name || member.email || `User #${member.id}`}</option>)}
                </select>
              </Field>
              <div className="flex items-end">
                <button className={`${buttonClass} w-full bg-slate-950 text-white hover:bg-slate-800`} disabled={busy}>
                  {editingProviderId ? <CheckCircle2 size={16} /> : <Plus size={16} />}
                  {editingProviderId ? "Save" : "Add"}
                </button>
              </div>
            </form>
            <div className="grid gap-3 md:grid-cols-2">
              {(providers.data || []).map((row) => (
                <div key={row.provider.id} className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">{row.provider.name}</p>
                      <p className="text-sm text-slate-500">{row.provider.title || "No title"} - {row.clinicName || "No clinic"}</p>
                    </div>
                    <div className="flex gap-1.5">
                      <button className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-900" onClick={() => startEditProvider(row)} disabled={busy} title="Edit provider"><Pencil size={15} /></button>
                      <button className="rounded-lg p-2 text-rose-600 hover:bg-white" onClick={() => confirmRemove(row.provider.name) && removeProvider.mutate(row.provider.id)} disabled={busy} title="Remove provider"><Trash2 size={15} /></button>
                    </div>
                  </div>
                </div>
              ))}
              {(providers.data || []).length === 0 && <p className="text-sm text-slate-400">No providers have been added yet.</p>}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Send Invites" subtitle="Create pending invitations before a team member signs in." icon={<MailPlus size={20} />}>
            <form className="space-y-3" onSubmit={submitInvite}>
              <Field label="Email">
                <input className={inputClass} type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} required />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Role">
                  <select className={inputClass} value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as RoleValue })}>
                    {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                  </select>
                </Field>
                <Field label="Clinic location">
                  <input className={inputClass} value={inviteForm.clinicLocation} onChange={(e) => setInviteForm({ ...inviteForm, clinicLocation: e.target.value })} placeholder="Optional" />
                </Field>
              </div>
              <button className={`${buttonClass} w-full bg-blue-600 text-white hover:bg-blue-700`} disabled={busy}>
                <MailPlus size={16} /> Send invite
              </button>
            </form>
            <div className="mt-5 space-y-2">
              {activeInvites.map((invite) => (
                <div key={invite.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{invite.email}</p>
                    <p className="text-xs text-slate-500 capitalize">{invite.role.replace("_", " ")} - {invite.clinicLocation || "No clinic"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${statusBadge(invite.status)}`}>{invite.status}</span>
                    {invite.status === "pending" && (
                      <button className="rounded-lg p-1.5 text-slate-500 hover:bg-white hover:text-rose-600" onClick={() => revokeInvite.mutate(invite.id)} disabled={busy} title="Revoke invite">
                        <X size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {activeInvites.length === 0 && <p className="text-sm text-slate-400">No pending invites.</p>}
            </div>
          </Card>

          <Card
            title="Clinics"
            subtitle="Maintain locations used for assignments, reporting, and provider rosters."
            icon={<Building2 size={20} />}
            action={
              editingClinicId ? (
                <button className={`${buttonClass} bg-slate-100 text-slate-700`} onClick={() => { setEditingClinicId(null); setClinicForm(emptyClinic); }}>
                  <X size={15} /> Cancel
                </button>
              ) : null
            }
          >
            <form className="space-y-3" onSubmit={submitClinic}>
              <Field label="Clinic name">
                <input className={inputClass} value={clinicForm.name} onChange={(e) => setClinicForm({ ...clinicForm, name: e.target.value })} required />
              </Field>
              <Field label="Location">
                <input className={inputClass} value={clinicForm.location} onChange={(e) => setClinicForm({ ...clinicForm, location: e.target.value })} required />
              </Field>
              <Field label="Address">
                <input className={inputClass} value={clinicForm.address} onChange={(e) => setClinicForm({ ...clinicForm, address: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input className={inputClass} value={clinicForm.phone} onChange={(e) => setClinicForm({ ...clinicForm, phone: e.target.value })} />
              </Field>
              <button className={`${buttonClass} w-full bg-slate-950 text-white hover:bg-slate-800`} disabled={busy}>
                {editingClinicId ? <CheckCircle2 size={16} /> : <Plus size={16} />}
                {editingClinicId ? "Save clinic" : "Add clinic"}
              </button>
            </form>
            <div className="mt-5 space-y-2">
              {clinicOptions.map((clinic) => (
                <div key={clinic.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">{clinic.name}</p>
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500"><MapPin size={13} /> {clinic.location}</p>
                      {(clinic.address || clinic.phone) && <p className="mt-1 text-xs text-slate-400">{clinic.address || "No address"} - {clinic.phone || "No phone"}</p>}
                    </div>
                    <div className="flex gap-1.5">
                      <button className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-900" onClick={() => startEditClinic(clinic)} disabled={busy} title="Edit clinic"><Pencil size={15} /></button>
                      <button className="rounded-lg p-2 text-rose-600 hover:bg-white" onClick={() => confirmRemove(clinic.name) && removeClinic.mutate(clinic.id)} disabled={busy} title="Remove clinic"><Trash2 size={15} /></button>
                    </div>
                  </div>
                </div>
              ))}
              {clinicOptions.length === 0 && <p className="text-sm text-slate-400">No clinics have been added yet.</p>}
            </div>
          </Card>
        </div>
      </div>

      {editingUserId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <form className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl" onSubmit={submitUser}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Edit team member</h2>
                <p className="text-sm text-slate-500">Update their profile details and platform access.</p>
              </div>
              <button type="button" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setEditingUserId(null)}><X size={18} /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input className={inputClass} value={teamForm.name} onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })} />
              </Field>
              <Field label="Email">
                <input className={inputClass} type="email" value={teamForm.email} onChange={(e) => setTeamForm({ ...teamForm, email: e.target.value })} />
              </Field>
              <Field label="Role">
                <select className={inputClass} value={teamForm.role} onChange={(e) => setTeamForm({ ...teamForm, role: e.target.value as RoleValue })}>
                  {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={`${buttonClass} bg-slate-100 text-slate-700 hover:bg-slate-200`} onClick={() => setEditingUserId(null)}>Cancel</button>
              <button className={`${buttonClass} bg-slate-950 text-white hover:bg-slate-800`} disabled={busy}><CheckCircle2 size={16} /> Save changes</button>
            </div>
          </form>
        </div>
      )}

      <p className="mt-5 flex items-center gap-1.5 text-sm font-light text-slate-400">
        <UserCog size={14} /> Team and access controls are limited to administrators.
      </p>
    </CCMDashboardLayout>
  );
}
