import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Activity, ClipboardList, ShieldCheck, Mail, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";

const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  staff: "/worklist",
  provider: "/escalations",
  billing: "/billing",
  front_desk: "/follow-ups",
  user: "/admin",
};

export default function Home() {
  const { user, loading, isAuthenticated, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Empty when the Manus OAuth portal isn't configured (e.g. off-platform);
  // we then hide the "Continue with Manus sign-in" option.
  const manusLoginUrl = getLoginUrl();

  useEffect(() => {
    if (!loading && isAuthenticated && user) {
      setLocation(ROLE_HOME[user.role] ?? "/admin");
    }
  }, [loading, isAuthenticated, user, setLocation]);

  const passwordLogin = trpc.auth.passwordLogin.useMutation({
    onSuccess: async (res) => {
      await utils.auth.me.invalidate();
      const refreshed = await refresh();
      const role = (refreshed.data as { role?: string } | null | undefined)?.role ?? "admin";
      if (res.mustChangePassword) {
        setLocation("/change-password?forced=1");
      } else {
        setLocation(ROLE_HOME[role] ?? "/admin");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Sign-in failed. Check your email and password.");
    },
  });

  const handlePasswordLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Enter both your email and password.");
      return;
    }
    passwordLogin.mutate({ email, password });
  };

  return (
    <div className="min-h-screen bg-white relative overflow-hidden">
      {/* Subtle grid texture + abstract geometric accents */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.4] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[hsl(22_80%_88%)] blur-3xl opacity-60" />
      <div className="pointer-events-none absolute top-1/3 -left-32 w-80 h-80 rounded-full bg-[hsl(345_80%_92%)] blur-3xl opacity-60" />

      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-24 pb-20 grid lg:grid-cols-2 gap-12 items-center">
        {/* Left: hero copy */}
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/70 border border-slate-200/70 backdrop-blur-sm mb-6 animate-fade-in-up">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-slate-500">Chronic Care Management</p>
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight text-slate-900 leading-[1.05] max-w-2xl">
            The operations hub for your CCM program.
          </h1>
          <p className="mt-6 text-lg font-light text-slate-600 max-w-xl leading-relaxed">
            Streamline patient outreach, documentation, staff coordination, billing
            readiness, and provider communication - all in one calm, focused workspace.
          </p>

          <div className="mt-10 hidden lg:grid sm:grid-cols-3 gap-5">
            {[
              { icon: ClipboardList, title: "Monthly Worklist", desc: "Auto-generated tasks with exact status and priority labels." },
              { icon: Activity, title: "Guided Call Workflow", desc: "Structured script, care documentation, and AI-drafted CCM notes." },
              { icon: ShieldCheck, title: "Role-based Access", desc: "Each role sees only its dashboard." },
            ].map((f, i) => (
              <div
                key={f.title}
                className="group bg-white rounded-3xl p-5 border border-slate-100 shadow-soft hover:shadow-soft-lg hover:-translate-y-1 transition-all duration-300 animate-fade-in-up"
                style={{ animationDelay: `${150 + i * 80}ms` }}
              >
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[hsl(17_70%_56%)] to-[hsl(24_76%_42%)] flex items-center justify-center mb-3 shadow-glow-primary transition-transform duration-300 group-hover:scale-110">
                  <f.icon size={18} className="text-white" />
                </div>
                <h3 className="font-bold text-slate-900 tracking-tight text-sm">{f.title}</h3>
                <p className="mt-1 text-xs font-light text-slate-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Right: sign-in card */}
        <div className="w-full max-w-md lg:ml-auto animate-fade-in-up" style={{ animationDelay: "120ms" }}>
          <div className="bg-white rounded-3xl border border-slate-200 shadow-soft-lg p-7">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Sign in</h2>
            <p className="mt-1.5 text-sm text-slate-500">Use your work email and password.</p>

            <form onSubmit={handlePasswordLogin} className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Work email</label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[hsl(20_72%_46%)] focus:border-transparent"
                    placeholder="nurse@clinic.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Password</label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[hsl(20_72%_46%)] focus:border-transparent"
                    placeholder="Your password"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={passwordLogin.isPending}
                className="group w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 active:scale-[0.98] transition-all duration-200 disabled:opacity-60"
              >
                {passwordLogin.isPending ? <Loader2 size={18} className="animate-spin" /> : "Sign in"}
                {!passwordLogin.isPending && <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />}
              </button>
            </form>

            {manusLoginUrl && (
              <>
                <div className="flex items-center gap-3 my-5">
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-xs uppercase tracking-widest text-slate-400">or</span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>

                <a
                  href={manusLoginUrl}
                  className="group w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold hover:bg-slate-50 active:scale-[0.98] transition-all duration-200"
                >
                  Continue with Manus sign-in
                </a>
              </>
            )}
            <p className="mt-3 text-center text-xs font-light text-slate-400">
              {loading ? "Checking your session..." : "Password login is for accounts created by your administrator."}
            </p>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3">
            <ShieldCheck size={16} className="text-emerald-600 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-slate-500">
              This is a secure system containing protected health information (PHI).
              Access is restricted to authorized users and all activity is logged.
              Unauthorized access or disclosure is prohibited and may be subject to
              penalties under HIPAA and applicable law.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
