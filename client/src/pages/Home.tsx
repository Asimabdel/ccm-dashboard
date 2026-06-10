import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Activity, ClipboardList, ShieldCheck } from "lucide-react";

const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  staff: "/worklist",
  provider: "/escalations",
  billing: "/billing",
  front_desk: "/follow-ups",
  user: "/admin",
};

export default function Home() {
  const { user, loading, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && isAuthenticated && user) {
      setLocation(ROLE_HOME[user.role] ?? "/admin");
    }
  }, [loading, isAuthenticated, user, setLocation]);

  return (
    <div className="min-h-screen bg-[hsl(240_10%_97%)] relative overflow-hidden">
      {/* Subtle grid texture + abstract geometric accents */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.4] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[hsl(200_85%_88%)] blur-3xl opacity-60" />
      <div className="pointer-events-none absolute top-1/3 -left-32 w-80 h-80 rounded-full bg-[hsl(345_80%_92%)] blur-3xl opacity-60" />
      <div className="pointer-events-none absolute bottom-10 right-1/4 w-40 h-40 rounded-[2rem] rotate-12 bg-[hsl(200_85%_90%)] opacity-50" />

      <div className="relative z-10 max-w-5xl mx-auto px-6 pt-28 pb-20">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/70 border border-slate-200/70 backdrop-blur-sm mb-6 animate-fade-in-up">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-slate-500">Chronic Care Management</p>
        </div>
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-slate-900 leading-[1.05] max-w-3xl">
          The operations hub for your CCM program.
        </h1>
        <p className="mt-6 text-lg font-light text-slate-500 max-w-xl leading-relaxed">
          Streamline patient outreach, documentation, staff coordination, billing
          readiness, and provider communication - all in one calm, focused workspace.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          {isAuthenticated ? (
            <button
              onClick={() => setLocation(ROLE_HOME[user?.role ?? "admin"] ?? "/admin")}
              className="group inline-flex items-center gap-2 px-7 py-3.5 rounded-2xl bg-slate-900 text-white font-semibold text-base hover:bg-slate-800 active:scale-[0.97] transition-all duration-200 shadow-soft-lg"
            >
              Go to my dashboard
              <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
            </button>
          ) : (
            <a
              href={getLoginUrl()}
              className="group inline-flex items-center gap-2 px-7 py-3.5 rounded-2xl bg-slate-900 text-white font-semibold text-base hover:bg-slate-800 active:scale-[0.97] transition-all duration-200 shadow-soft-lg"
            >
              Log in to dashboard
              <ArrowRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
            </a>
          )}
          <span className="text-sm font-light text-slate-400">
            {loading ? "Checking your session..." : "Secure Manus sign-in"}
          </span>
        </div>

        <div className="mt-20 grid sm:grid-cols-3 gap-5">
          {[
            { icon: ClipboardList, title: "Monthly Worklist", desc: "Auto-generated tasks with exact status and priority labels." },
            { icon: Activity, title: "Guided Call Workflow", desc: "Structured script, care documentation, and AI-drafted CCM notes." },
            { icon: ShieldCheck, title: "Role-based Access", desc: "Each role sees only its dashboard - admin, staff, provider, billing, front desk." },
          ].map((f, i) => (
            <div
              key={f.title}
              className="group bg-white rounded-3xl p-6 border border-slate-100 shadow-soft hover:shadow-soft-lg hover:-translate-y-1 transition-all duration-300 animate-fade-in-up"
              style={{ animationDelay: `${150 + i * 80}ms` }}
            >
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[hsl(200_100%_55%)] to-[hsl(210_100%_45%)] flex items-center justify-center mb-4 shadow-glow-primary transition-transform duration-300 group-hover:scale-110">
                <f.icon size={20} className="text-white" />
              </div>
              <h3 className="font-bold text-slate-900 tracking-tight">{f.title}</h3>
              <p className="mt-1.5 text-sm font-light text-slate-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
