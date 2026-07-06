import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Lock, ArrowRight, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { validatePassword } from "@/lib/ccm";

const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  staff: "/worklist",
  provider: "/escalations",
  billing: "/billing",
  front_desk: "/follow-ups",
  user: "/admin",
};

export default function ChangePasswordPage() {
  const { user, loading, isAuthenticated, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // If a password-only worker is being forced to change, we know it from the login flow,
  // but we can't read mustChangePassword directly from `me`. We treat this page as both
  // the forced first-login change and a general "change my password" screen.
  const forced = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("forced") === "1";

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      setLocation("/");
    }
  }, [loading, isAuthenticated, setLocation]);

  const changePassword = trpc.auth.changePassword.useMutation({
    onSuccess: async () => {
      toast.success("Password updated. You're all set.");
      await utils.auth.me.invalidate();
      await refresh();
      setLocation(ROLE_HOME[user?.role ?? "admin"] ?? "/admin");
    },
    onError: (err) => {
      toast.error(err.message || "Could not update password.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pwErr = validatePassword(newPassword);
    if (pwErr) {
      toast.error(pwErr);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation do not match.");
      return;
    }
    changePassword.mutate({
      currentPassword: currentPassword || undefined,
      newPassword,
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[hsl(17_70%_56%)] to-[hsl(24_76%_42%)] flex items-center justify-center shadow-glow-primary">
            <ShieldCheck size={20} className="text-white" />
          </div>
          <div className="leading-tight">
            <span className="block font-bold tracking-tight text-slate-900">Care Hub</span>
            <span className="block text-[10px] uppercase tracking-widest text-slate-400 font-medium">Operations</span>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-soft-lg p-7">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {forced ? "Set a new password" : "Change your password"}
          </h1>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">
            {forced
              ? "For security, please choose your own password before continuing to the dashboard."
              : "Update the password you use to sign in to the dashboard."}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {!forced && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Current password</label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[hsl(20_72%_46%)] focus:border-transparent"
                    placeholder="Your current password"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">New password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[hsl(20_72%_46%)] focus:border-transparent"
                  placeholder="At least 8 chars, with a letter and number"
                />
              </div>
              {newPassword.length > 0 && validatePassword(newPassword) && (
                <p className="mt-1.5 text-[12px] text-rose-600">{validatePassword(newPassword)}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Confirm new password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[hsl(20_72%_46%)] focus:border-transparent"
                  placeholder="Re-enter new password"
                />
              </div>
              {confirmPassword.length > 0 && confirmPassword !== newPassword && (
                <p className="mt-1.5 text-[12px] text-rose-600">Passwords do not match.</p>
              )}
            </div>

            <button
              type="submit"
              disabled={changePassword.isPending || !!validatePassword(newPassword) || newPassword !== confirmPassword}
              className="group w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 active:scale-[0.98] transition-all duration-200 disabled:opacity-60"
            >
              {changePassword.isPending ? <Loader2 size={18} className="animate-spin" /> : "Update password"}
              {!changePassword.isPending && <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
