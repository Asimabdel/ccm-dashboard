import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import {
  Loader2, Sparkles, AlertTriangle, Save, ArrowLeft, Phone, ShieldCheck, Activity,
  ClipboardList, Plus, Trash2,
} from "lucide-react";

type Problem = { condition: string; goal: string; intervention: string };

type Responses = {
  howFeeling: string; newSymptoms: string; medicationAdherence: string; refillsNeeded: string;
  erHospitalizationSince: string; recentSpecialistVisits: string; bloodPressureReading: string;
  bloodSugarReading: string; upcomingAppointments: string; followUpNeeded: string; patientConcerns: string;
};

const EMPTY: Responses = {
  howFeeling: "", newSymptoms: "", medicationAdherence: "", refillsNeeded: "",
  erHospitalizationSince: "", recentSpecialistVisits: "", bloodPressureReading: "",
  bloodSugarReading: "", upcomingAppointments: "", followUpNeeded: "", patientConcerns: "",
};

const SCRIPT: { key: keyof Responses; question: string; placeholder: string }[] = [
  { key: "howFeeling", question: "How have you been feeling since our last check-in?", placeholder: "General wellbeing, energy, mood…" },
  { key: "newSymptoms", question: "Any new or worsening symptoms? (chest pain, shortness of breath, dizziness, swelling)", placeholder: "Describe any new symptoms…" },
  { key: "medicationAdherence", question: "Are you taking all medications as prescribed?", placeholder: "Adherence, missed doses, side effects…" },
  { key: "refillsNeeded", question: "Do you need any prescription refills?", placeholder: "Medications needing refill…" },
  { key: "bloodPressureReading", question: "Most recent blood pressure reading?", placeholder: "e.g. 128/82" },
  { key: "bloodSugarReading", question: "Most recent blood sugar reading? (if applicable)", placeholder: "e.g. 110 mg/dL fasting" },
  { key: "erHospitalizationSince", question: "Any ER visits or hospitalizations since last contact?", placeholder: "Dates, reason, outcome…" },
  { key: "recentSpecialistVisits", question: "Any recent specialist visits?", placeholder: "Specialist, date, findings…" },
  { key: "upcomingAppointments", question: "Any upcoming appointments scheduled?", placeholder: "Provider, date…" },
  { key: "followUpNeeded", question: "What follow-up does this patient need?", placeholder: "Labs, referrals, scheduling, education…" },
  { key: "patientConcerns", question: "Any other concerns from the patient?", placeholder: "Questions, social needs, barriers…" },
];

export default function CallWorkflowPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, params] = useRoute("/workflow/:id");
  const [, setLocation] = useLocation();
  const taskId = Number(params?.id);

  const task = trpc.worklist.getTask.useQuery(taskId, { enabled: !!user && !!taskId });
  const patientId = task.data?.patientId;
  const patient = trpc.patients.detail.useQuery(patientId!, { enabled: !!patientId });
  const existingNote = trpc.ccmNotes.getByTaskId.useQuery(taskId, { enabled: !!user && !!taskId });
  const carePlan = trpc.carePlan.get.useQuery(patientId!, { enabled: !!patientId });
  const utils = trpc.useUtils();

  const [responses, setResponses] = useState<Responses>(EMPTY);
  const [generatedNote, setGeneratedNote] = useState("");
  const [aiGeneratedAt, setAiGeneratedAt] = useState<number | null>(null);
  const [escalate, setEscalate] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // Care plan + chronic conditions captured in-call
  const [problems, setProblems] = useState<Problem[]>([]);
  const [medications, setMedications] = useState("");
  const [planNotes, setPlanNotes] = useState("");
  const [planReviewed, setPlanReviewed] = useState(false);
  const [newCondition, setNewCondition] = useState("");
  const [planHydrated, setPlanHydrated] = useState(false);

  // hydrate from existing note (review mode)
  useEffect(() => {
    if (existingNote.data && !hydrated) {
      const n = existingNote.data;
      setResponses({
        howFeeling: n.howFeeling || "", newSymptoms: n.newSymptoms || "", medicationAdherence: n.medicationAdherence || "",
        refillsNeeded: n.refillsNeeded || "", erHospitalizationSince: n.erHospitalizationSince || "",
        recentSpecialistVisits: n.recentSpecialistVisits || "", bloodPressureReading: n.bloodPressureReading || "",
        bloodSugarReading: n.bloodSugarReading || "", upcomingAppointments: n.upcomingAppointments || "",
        followUpNeeded: n.followUpNeeded || "", patientConcerns: n.patientConcerns || "",
      });
      if (n.generatedNote) setGeneratedNote(n.generatedNote);
      if (n.aiGeneratedAt) setAiGeneratedAt(new Date(n.aiGeneratedAt).getTime());
      if (n.escalationFlag) { setEscalate(true); setEscalationReason(n.escalationReason || ""); }
      setHydrated(true);
    } else if (task.data && !existingNote.data && !hydrated && existingNote.isFetched) {
      setHydrated(true);
    }
  }, [existingNote.data, existingNote.isFetched, task.data, hydrated]);

  // hydrate care plan: use the saved plan, else seed problems from the patient's conditions
  useEffect(() => {
    if (planHydrated || !patient.data) return;
    if (patientId && !carePlan.isFetched) return; // wait for the care-plan query
    const cp = carePlan.data;
    if (cp && Array.isArray(cp.problems) && cp.problems.length) {
      setProblems(cp.problems.map((p) => ({ condition: p.condition || "", goal: p.goal || "", intervention: p.intervention || "" })));
      setMedications(cp.medications || "");
      setPlanNotes(cp.additionalNotes || "");
    } else {
      const conds = (patient.data.patient?.chronicConditions as string[]) || [];
      setProblems(conds.map((c) => ({ condition: c, goal: "", intervention: "" })));
    }
    setPlanHydrated(true);
  }, [patient.data, carePlan.data, carePlan.isFetched, patientId, planHydrated]);

  const genNote = trpc.ccmNotesAI.generateNote.useMutation({
    onSuccess: (r) => { setGeneratedNote(typeof r.note === "string" ? r.note : String(r.note)); setAiGeneratedAt(r.generatedAt ?? Date.now()); toast.success("Note drafted by AI. Review and edit as needed."); },
    onError: (e) => toast.error(e.message),
  });
  const saveNote = trpc.ccmNotes.save.useMutation({
    onSuccess: () => {
      utils.worklist.forMonth.invalidate(); utils.worklist.getTask.invalidate(taskId);
      toast.success("CCM note saved.");
      setLocation("/worklist");
    },
    onError: (e) => toast.error(e.message),
  });
  const savePlan = trpc.carePlan.save.useMutation({ onError: (e) => toast.error(e.message) });
  const updatePatient = trpc.patients.update.useMutation({ onError: (e) => toast.error(e.message) });

  if (loading || !user || task.isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  if (!task.data) {
    return <CCMDashboardLayout title="Call Workflow"><p className="text-slate-400">Task not found.</p></CCMDashboardLayout>;
  }

  const set = (k: keyof Responses, v: string) => setResponses((r) => ({ ...r, [k]: v }));
  const p = patient.data?.patient;
  const conditions: string[] = (p?.chronicConditions as string[]) || [];

  const setProblem = (i: number, k: keyof Problem, v: string) =>
    setProblems((ps) => ps.map((pr, idx) => (idx === i ? { ...pr, [k]: v } : pr)));
  const removeProblem = (i: number) => setProblems((ps) => ps.filter((_, idx) => idx !== i));
  const addCondition = () => {
    const c = newCondition.trim();
    if (!c) return;
    setProblems((ps) => [...ps, { condition: c, goal: "", intervention: "" }]);
    setNewCondition("");
  };

  const cleanProblems = () =>
    problems
      .map((pr) => ({ condition: pr.condition.trim(), goal: pr.goal.trim(), intervention: pr.intervention.trim() }))
      .filter((pr) => pr.condition);

  const saving = saveNote.isPending || savePlan.isPending || updatePatient.isPending;

  // Persist conditions + care plan first, then the CCM note (which navigates away).
  const persist = async (markCompleted: boolean) => {
    if (!patientId) return;
    const cps = cleanProblems();
    try {
      await updatePatient.mutateAsync({ id: patientId, chronicConditions: cps.map((pr) => pr.condition) });
      await savePlan.mutateAsync({ patientId, problems: cps, medications, additionalNotes: planNotes, markReviewed: planReviewed });
      await saveNote.mutateAsync({
        ccmTaskId: taskId, patientId, ...responses, generatedNote,
        aiGeneratedAt: aiGeneratedAt ?? undefined,
        escalationFlag: escalate, escalationReason: escalate ? escalationReason : undefined,
        carePlanReviewed: planReviewed,
        markCompleted,
      });
    } catch {
      /* individual mutations surface their own error toasts */
    }
  };

  return (
    <CCMDashboardLayout title="Guided CCM Call">
      <button onClick={() => setLocation("/worklist")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4 transition-colors"><ArrowLeft size={15} /> Back to worklist</button>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: patient context */}
        <div className="space-y-5">
          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Patient</p>
            <h2 className="text-2xl font-bold text-slate-900">{p?.name || <Loader2 className="animate-spin inline" />}</h2>
            <p className="text-sm text-slate-500 mt-0.5">{p?.dateOfBirth ? `DOB ${new Date(p.dateOfBirth).toLocaleDateString()}` : ""} {p?.phoneNumber ? `· ${p.phoneNumber}` : ""}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {conditions.map((c) => <span key={c} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[hsl(200_60%_94%)] text-[hsl(200_80%_30%)]">{c}</span>)}
            </div>
            {p?.insurance && <p className="mt-4 text-sm text-slate-500">Insurance: <span className="text-slate-700">{p.insurance}</span></p>}
          </div>

          <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-3xl p-6 shadow-[0_18px_40px_-22px_rgba(15,23,42,0.6)]">
            <div className="flex items-center gap-2 text-slate-300 text-xs uppercase tracking-wider mb-3"><Phone size={13} /> Call in progress</div>
            <p className="text-sm text-slate-300 leading-relaxed">Work through the script on the right, then generate or write the CCM note. Flag the patient if anything needs provider attention.</p>
            <div className="mt-5 flex items-center gap-2 text-xs text-slate-400">
              <ShieldCheck size={14} className="text-emerald-400" /> Access to this record is audit-logged.
            </div>
          </div>

          {conditions.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-center gap-2 mb-3 text-slate-700"><Activity size={15} className="text-[hsl(200_100%_45%)]" /><span className="text-sm font-semibold">Care focus</span></div>
              <p className="text-xs text-slate-500 leading-relaxed">Review adherence and symptoms for each chronic condition, and confirm the care plan is current.</p>
            </div>
          )}
        </div>

        {/* Right: script + form */}
        <div className="lg:col-span-2 space-y-5">
          {/* Chronic conditions & care plan */}
          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <div className="flex items-center gap-2 mb-1"><ClipboardList size={16} className="text-[hsl(200_100%_45%)]" /><h3 className="font-bold text-slate-900">Chronic Conditions & Care Plan</h3></div>
            <p className="text-xs text-slate-500 mb-4">Review each chronic condition with a measurable goal and the planned intervention. This is the patient's CCM care plan — confirm it's current and updated this month.</p>

            <div className="space-y-3">
              {problems.map((pr, i) => (
                <div key={i} className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <input value={pr.condition} onChange={(e) => setProblem(i, "condition", e.target.value)} placeholder="Condition"
                      className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
                    <button onClick={() => removeProblem(i)} title="Remove condition" className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition"><Trash2 size={15} /></button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input value={pr.goal} onChange={(e) => setProblem(i, "goal", e.target.value)} placeholder="Goal (e.g. A1c < 7%, BP < 130/80)"
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
                    <input value={pr.intervention} onChange={(e) => setProblem(i, "intervention", e.target.value)} placeholder="Intervention / management"
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
                  </div>
                </div>
              ))}
              {problems.length === 0 && <p className="text-sm text-slate-400">No conditions yet — add the patient's chronic conditions below.</p>}
            </div>

            <div className="flex items-center gap-2 mt-3">
              <input value={newCondition} onChange={(e) => setNewCondition(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCondition(); } }}
                placeholder="Add a chronic condition…"
                className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
              <button onClick={addCondition} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 active:scale-[0.97] transition"><Plus size={15} /> Add</button>
            </div>

            <div className="mt-4 grid gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Medication management / reconciliation</label>
                <textarea value={medications} onChange={(e) => setMedications(e.target.value)} rows={2} placeholder="Current medications, changes, adherence concerns…"
                  className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Care plan notes (psychosocial, social services, other)</label>
                <textarea value={planNotes} onChange={(e) => setPlanNotes(e.target.value)} rows={2} placeholder="Functional status, social needs, community resources…"
                  className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
              </div>
            </div>

            <label className="mt-4 flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={planReviewed} onChange={(e) => setPlanReviewed(e.target.checked)} className="accent-[hsl(200_100%_50%)] w-4 h-4" />
              <span className="text-sm font-medium text-slate-800">Care plan reviewed &amp; updated with the patient this month</span>
            </label>
          </div>

          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <div className="flex items-center gap-2 mb-5"><Phone size={16} className="text-[hsl(200_100%_45%)]" /><h3 className="font-bold text-slate-900">Call Script & Documentation</h3></div>
            <div className="space-y-5">
              {SCRIPT.map((q, i) => (
                <div key={q.key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5"><span className="text-slate-300 mr-1.5">{i + 1}.</span>{q.question}</label>
                  <textarea value={responses[q.key]} onChange={(e) => set(q.key, e.target.value)} placeholder={q.placeholder} rows={2}
                    className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent transition" />
                </div>
              ))}
            </div>
          </div>

          {/* Escalation */}
          <div className={`rounded-3xl border p-5 transition ${escalate ? "border-rose-200 bg-rose-50/60" : "border-slate-100 bg-white"}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={escalate} onChange={(e) => setEscalate(e.target.checked)} className="accent-rose-500 w-4 h-4" />
              <AlertTriangle size={16} className={escalate ? "text-rose-500" : "text-slate-400"} />
              <span className="font-medium text-slate-800 text-sm">Flag this patient for provider review (urgent symptom / escalation)</span>
            </label>
            {escalate && (
              <textarea value={escalationReason} onChange={(e) => setEscalationReason(e.target.value)} placeholder="Reason for escalation (what should the provider review?)" rows={2}
                className="mt-3 w-full px-3.5 py-2.5 rounded-2xl border border-rose-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-rose-300" />
            )}
          </div>

          {/* AI note */}
          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2"><Sparkles size={16} className="text-[hsl(280_60%_55%)]" /><h3 className="font-bold text-slate-900">CCM Documentation Note</h3></div>
              <button disabled={genNote.isPending} onClick={() => genNote.mutate({
                patientName: p?.name || "Patient",
                localDateTime: new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }),
                chronicConditions: cleanProblems().map((pr) => pr.condition),
                carePlan: { problems: cleanProblems(), medications, additionalNotes: planNotes, reviewedThisMonth: planReviewed },
                responses,
              })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[hsl(280_60%_55%)] text-white text-sm font-semibold hover:brightness-110 active:scale-[0.97] transition disabled:opacity-50">
                {genNote.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate with AI
              </button>
            </div>
            <textarea value={generatedNote} onChange={(e) => setGeneratedNote(e.target.value)} placeholder="Click 'Generate with AI' to draft a professional CCM note from the responses above, or write your own. You can edit the generated text before saving."
              rows={12} className="w-full px-4 py-3 rounded-2xl border border-slate-200 text-sm leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-[hsl(280_60%_60%)]" />
            {aiGeneratedAt && (
              <p className="mt-2 text-xs text-slate-400 flex items-center gap-1.5">
                <Sparkles size={12} className="text-[hsl(280_60%_55%)]" />
                AI generated on {new Date(aiGeneratedAt).toLocaleString()}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3">
            <button disabled={saving} onClick={() => persist(false)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 active:scale-[0.97] disabled:opacity-50 transition">
              <Save size={15} /> Save Draft
            </button>
            <button disabled={saving} onClick={() => persist(true)} className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-2xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Complete & Save
            </button>
          </div>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
