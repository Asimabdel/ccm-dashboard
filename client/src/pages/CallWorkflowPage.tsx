import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import {
  Loader2, Sparkles, AlertTriangle, Save, ArrowLeft, Phone, ShieldCheck, Activity,
  Clock, Brain, ClipboardList, CheckCircle2, XCircle,
} from "lucide-react";
import { phq9Severity, gad7Severity, bhiCompliance } from "@/lib/ccm";
import { MedRefillPanel } from "@/components/MedRefillPanel";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { CallCarePlanCard } from "@/components/careplan/CallCarePlanCard";

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

// Behavioral Health Integration (BHI, 99484) call script — reuses the note's text
// fields with behavioral-health wording. Structured scores are captured separately.
const BHI_SCRIPT: { key: keyof Responses; question: string; placeholder: string }[] = [
  { key: "howFeeling", question: "How has your mood and emotional wellbeing been since our last check-in?", placeholder: "Mood, stress, motivation, outlook…" },
  { key: "newSymptoms", question: "Any changes in sleep, appetite, energy, or concentration?", placeholder: "Sleep, appetite, focus, energy…" },
  { key: "medicationAdherence", question: "Are you taking your mental-health medications as prescribed? Any side effects?", placeholder: "Adherence, missed doses, side effects…" },
  { key: "refillsNeeded", question: "Do you need any refills for those medications?", placeholder: "Medications needing refill…" },
  { key: "recentSpecialistVisits", question: "Are you engaged in therapy, counseling, or psychiatry? How is it going?", placeholder: "Therapist / psychiatrist, frequency, progress…" },
  { key: "erHospitalizationSince", question: "Any mental-health crises, ER visits, or hospitalizations since we last spoke?", placeholder: "Dates, reason, outcome…" },
  { key: "upcomingAppointments", question: "Any upcoming behavioral-health appointments?", placeholder: "Provider, date…" },
  { key: "patientConcerns", question: "What stressors or concerns are affecting you right now?", placeholder: "Life stressors, social support, barriers…" },
  { key: "followUpNeeded", question: "What follow-up or coordination does this patient need?", placeholder: "Referrals, warm hand-off, resources, provider consult…" },
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
  const utils = trpc.useUtils();

  const isBhi = task.data?.program === "bhi";

  const [responses, setResponses] = useState<Responses>(EMPTY);
  const [generatedNote, setGeneratedNote] = useState("");
  const [aiGeneratedAt, setAiGeneratedAt] = useState<number | null>(null);
  const [escalate, setEscalate] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // BHI (99484) validated-assessment state — only surfaced on BHI calls.
  const [phq9, setPhq9] = useState("");
  const [gad7, setGad7] = useState("");
  const [otherTool, setOtherTool] = useState("");
  const [otherScore, setOtherScore] = useState("");
  const [behavioralStatus, setBehavioralStatus] = useState("");
  const [carePlanUpdated, setCarePlanUpdated] = useState(false);
  const [bhiRisk, setBhiRisk] = useState(false);

  // CCM: care plan reviewed + which conditions' teaching points were covered on this call.
  const [planReviewed, setPlanReviewed] = useState(false);
  const [covered, setCovered] = useState<string[]>([]);
  const callCtx = trpc.workspace.carePlans.forCall.useQuery({ patientId: patientId! }, { enabled: !!patientId && !isBhi, retry: false });

  // Minutes spent on this call — entered manually, logged onto the monthly task
  // when the note is saved (used toward the monthly time total for billing).
  const [manualMins, setManualMins] = useState("");
  const sessionMinutes = Math.max(0, Math.min(480, parseInt(manualMins, 10) || 0));

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
      // BHI assessment fields
      if (n.phq9Score != null) setPhq9(String(n.phq9Score));
      if (n.gad7Score != null) setGad7(String(n.gad7Score));
      if (n.assessmentToolOther) setOtherTool(n.assessmentToolOther);
      if (n.assessmentScoreOther != null) setOtherScore(String(n.assessmentScoreOther));
      if (n.behavioralStatus) setBehavioralStatus(n.behavioralStatus);
      if (n.carePlanUpdated) setCarePlanUpdated(true);
      if (n.bhiRiskFlag) setBhiRisk(true);
      if (n.carePlanReviewed) setPlanReviewed(true);
      if (Array.isArray(n.educationCovered)) setCovered(n.educationCovered as string[]);
      setHydrated(true);
    } else if (task.data && !existingNote.data && !hydrated && existingNote.isFetched) {
      setHydrated(true);
    }
  }, [existingNote.data, existingNote.isFetched, task.data, hydrated]);

  const genNote = trpc.ccmNotesAI.generateNote.useMutation({
    onSuccess: (r) => { setGeneratedNote(typeof r.note === "string" ? r.note : String(r.note)); setAiGeneratedAt(r.generatedAt ?? Date.now()); toast.success("Note drafted by AI. Review and edit as needed."); },
    onError: (e) => toast.error(e.message),
  });
  const saveNote = trpc.ccmNotes.save.useMutation({
    onSuccess: () => {
      utils.worklist.forMonth.invalidate(); utils.worklist.getTask.invalidate(taskId);
      toast.success(isBhi ? "BHI note saved." : "CCM note saved.");
      setLocation("/worklist");
    },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user || task.isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  if (!task.data) {
    return <CCMDashboardLayout title="Call Workflow"><p className="text-slate-400">Task not found.</p></CCMDashboardLayout>;
  }

  const set = (k: keyof Responses, v: string) => setResponses((r) => ({ ...r, [k]: v }));
  const p = patient.data?.patient;
  const conditions: string[] = (isBhi ? (p?.bhiConditions as string[]) : (p?.chronicConditions as string[])) || [];
  const script = isBhi ? BHI_SCRIPT : SCRIPT;

  // BHI assessment fields sent to ccmNotes.save (empty object on CCM calls).
  const bhiFields = isBhi ? {
    phq9Score: phq9 !== "" ? Number(phq9) : null,
    gad7Score: gad7 !== "" ? Number(gad7) : null,
    assessmentToolOther: otherTool || undefined,
    assessmentScoreOther: otherScore !== "" ? Number(otherScore) : null,
    behavioralStatus: (behavioralStatus || undefined) as "improved" | "unchanged" | "worsening" | "new" | undefined,
    carePlanUpdated,
    bhiRiskFlag: bhiRisk,
  } : {};
  const bhiAssessment = isBhi ? {
    phq9Score: phq9 !== "" ? Number(phq9) : null,
    gad7Score: gad7 !== "" ? Number(gad7) : null,
    assessmentToolOther: otherTool || undefined,
    assessmentScoreOther: otherScore !== "" ? Number(otherScore) : null,
    behavioralStatus: behavioralStatus || undefined,
    carePlanUpdated, riskFlag: bhiRisk,
  } : undefined;

  // CCM-only fields for ccmNotes.save and the AI note.
  const ccmFields = isBhi ? {} : { carePlanReviewed: planReviewed, educationCovered: covered };
  const cc = callCtx.data;
  const carePlanForNote = isBhi || !cc ? undefined : {
    status: cc.plan?.status ?? "none",
    reviewed: planReviewed,
    problems: (cc.plan?.problems ?? []).map((x) => x.problem),
    educationCovered: cc.conditions.filter((c) => covered.includes(c.key)).map((c) => c.label),
  };

  const phqBand = phq9Severity(phq9 !== "" ? Number(phq9) : null);
  const gadBand = gad7Severity(gad7 !== "" ? Number(gad7) : null);

  return (
    <CCMDashboardLayout title={isBhi ? "Guided BHI Call" : "Guided CCM Call"}>
      <button onClick={() => setLocation("/worklist")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4 transition-colors"><ArrowLeft size={15} /> Back to worklist</button>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: patient context */}
        <div className="space-y-5">
          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Patient</p>
            <h2 className="text-2xl font-bold text-slate-900">{p?.name || <Loader2 className="animate-spin inline" />}</h2>
            <p className="text-sm text-slate-500 mt-0.5">{p?.dateOfBirth ? `DOB ${new Date(p.dateOfBirth).toLocaleDateString()}` : ""} {p?.phoneNumber && <>· <PhoneLink phone={p.phoneNumber} context={{ patientId: p.id, name: p.name, source: "ccm_call" }} className="font-medium text-slate-700" /></>}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {conditions.map((c) => <span key={c} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[hsl(22_64%_93%)] text-[hsl(17_66%_34%)]">{c}</span>)}
            </div>
            {p?.insurance && <p className="mt-4 text-sm text-slate-500">Insurance: <span className="text-slate-700">{p.insurance}</span></p>}
          </div>

          {/* BHI 99484 compliance — patient-level prerequisites to billing */}
          {isBhi && p && (() => {
            const checks = bhiCompliance(p);
            const met = checks.filter((c) => c.ok).length;
            return (
              <div className={`rounded-3xl border p-5 ${met === checks.length ? "border-emerald-100 bg-emerald-50/50" : "border-amber-100 bg-amber-50/50"}`}>
                <div className="flex items-center justify-between mb-2.5">
                  <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><ShieldCheck size={14} className="text-violet-500" /> BHI requirements</p>
                  <span className={`text-xs font-bold ${met === checks.length ? "text-emerald-700" : "text-amber-700"}`}>{met}/{checks.length}</span>
                </div>
                <div className="space-y-1">
                  {checks.map((c) => (
                    <div key={c.key} className="flex items-center gap-2 text-[13px]">
                      {c.ok ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> : <XCircle size={14} className="text-slate-300 shrink-0" />}
                      <span className={c.ok ? "text-slate-600" : "text-slate-500"}>{c.label}</span>
                    </div>
                  ))}
                </div>
                {met < checks.length && <p className="text-[11px] text-amber-700 mt-2.5">Complete the missing items on the patient's BHI panel before this call can be billed.</p>}
              </div>
            );
          })()}

          <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-3xl p-6 shadow-[0_18px_40px_-22px_rgba(15,23,42,0.6)]">
            <div className="flex items-center gap-2 text-slate-300 text-xs uppercase tracking-wider mb-3">{isBhi ? <Brain size={13} /> : <Phone size={13} />} {isBhi ? "BHI call in progress" : "Call in progress"}</div>
            <p className="text-sm text-slate-300 leading-relaxed">{isBhi ? "Complete the validated assessments and behavioral check-in on the right, then generate or write the BHI note. Flag any safety risk for provider review." : "Work through the script on the right, then generate or write the CCM note. Flag the patient if anything needs provider attention."}</p>
            <div className="mt-5 flex items-center gap-2 text-xs text-slate-400">
              <ShieldCheck size={14} className="text-emerald-400" /> Access to this record is audit-logged.
            </div>
          </div>

          {/* Minutes spent on this call */}
          <div className="bg-white rounded-3xl border border-slate-100 p-6">
            <div className="flex items-center gap-2 text-slate-700 mb-3">
              <Clock size={15} className="text-[hsl(17_68%_47%)]" /><span className="text-sm font-semibold">Minutes spent on this call</span>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" min={0} max={480} value={manualMins} placeholder="0"
                onChange={(e) => setManualMins(e.target.value)}
                className="w-20 px-3 py-2 rounded-xl border border-slate-200 text-lg font-mono tabular-nums text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]" />
              <span className="text-sm text-slate-400">minutes</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">Added to this month's total when you save.</p>
          </div>

          {conditions.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <div className="flex items-center gap-2 mb-3 text-slate-700"><Activity size={15} className="text-[hsl(17_68%_47%)]" /><span className="text-sm font-semibold">Care focus</span></div>
              <p className="text-xs text-slate-500 leading-relaxed">Review adherence and symptoms for each chronic condition, and confirm the care plan is current.</p>
            </div>
          )}
        </div>

        {/* Right: script + form */}
        <div className="lg:col-span-2 space-y-5">
          {/* BHI validated-assessment scoring — the documentation foundation for 99484 */}
          {isBhi && (
            <div className="bg-white rounded-3xl border border-violet-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
              <div className="flex items-center gap-2 mb-4"><ClipboardList size={16} className="text-violet-500" /><h3 className="font-bold text-slate-900">Validated Assessments</h3><span className="text-[11px] text-slate-400">Required for BHI</span></div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">PHQ-9 (depression, 0–27)</label>
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} max={27} value={phq9} onChange={(e) => setPhq9(e.target.value)} placeholder="—"
                      className="w-24 px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-violet-300" />
                    {phqBand && <span className={`px-2 py-1 rounded-full text-[11px] font-semibold ${phqBand.cls}`}>{phqBand.label}</span>}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">GAD-7 (anxiety, 0–21)</label>
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} max={21} value={gad7} onChange={(e) => setGad7(e.target.value)} placeholder="—"
                      className="w-24 px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-violet-300" />
                    {gadBand && <span className={`px-2 py-1 rounded-full text-[11px] font-semibold ${gadBand.cls}`}>{gadBand.label}</span>}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Other tool (optional)</label>
                  <div className="flex items-center gap-2">
                    <input value={otherTool} onChange={(e) => setOtherTool(e.target.value)} placeholder="AUDIT-C, DAST-10…"
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300" />
                    <input type="number" value={otherScore} onChange={(e) => setOtherScore(e.target.value)} placeholder="score"
                      className="w-20 px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-violet-300" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Behavioral trajectory</label>
                  <select value={behavioralStatus} onChange={(e) => setBehavioralStatus(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-300">
                    <option value="">Select…</option>
                    <option value="new">New to BHI</option>
                    <option value="improved">Improved</option>
                    <option value="unchanged">Unchanged</option>
                    <option value="worsening">Worsening</option>
                  </select>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-700">
                  <input type="checkbox" checked={carePlanUpdated} onChange={(e) => setCarePlanUpdated(e.target.checked)} className="accent-violet-500 w-4 h-4" />
                  Behavioral care plan reviewed / revised this month
                </label>
                <label className={`flex items-center gap-2.5 cursor-pointer text-sm font-medium rounded-xl px-3 py-2 transition ${bhiRisk ? "bg-rose-50 text-rose-700" : "text-slate-700"}`}>
                  <input type="checkbox" checked={bhiRisk} onChange={(e) => setBhiRisk(e.target.checked)} className="accent-rose-500 w-4 h-4" />
                  <AlertTriangle size={15} className={bhiRisk ? "text-rose-500" : "text-slate-400"} />
                  Safety risk (suicidal ideation / self-harm) — routes to provider review
                </label>
              </div>
            </div>
          )}

          {!isBhi && patientId && <CallCarePlanCard patientId={patientId} covered={covered} setCovered={setCovered} reviewed={planReviewed} setReviewed={setPlanReviewed} />}

          <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
            <div className="flex items-center gap-2 mb-5">{isBhi ? <Brain size={16} className="text-violet-500" /> : <Phone size={16} className="text-[hsl(17_68%_47%)]" />}<h3 className="font-bold text-slate-900">{isBhi ? "Behavioral Health Check-In" : "Call Script & Documentation"}</h3></div>
            <div className="space-y-5">
              {script.map((q, i) => (
                <div key={q.key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5"><span className="text-slate-300 mr-1.5">{i + 1}.</span>{q.question}</label>
                  <textarea value={responses[q.key]} onChange={(e) => set(q.key, e.target.value)} placeholder={q.placeholder} rows={2}
                    className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)] focus:border-transparent transition" />
                </div>
              ))}
            </div>
          </div>

          {/* Medication refill requests → provider */}
          {patientId && <MedRefillPanel patientId={patientId} ccmTaskId={taskId} providerName={patient.data?.provider?.name} />}

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
              <div className="flex items-center gap-2"><Sparkles size={16} className="text-[hsl(280_60%_55%)]" /><h3 className="font-bold text-slate-900">{isBhi ? "BHI Documentation Note" : "CCM Documentation Note"}</h3></div>
              <button disabled={genNote.isPending} onClick={() => genNote.mutate({ patientName: p?.name || "Patient", localDateTime: new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }), program: isBhi ? "bhi" : "ccm", responses, bhiAssessment, carePlan: carePlanForNote })}
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
            <button disabled={saveNote.isPending} onClick={() => saveNote.mutate({
              ccmTaskId: taskId, patientId: patientId!, ...responses, generatedNote,
              aiGeneratedAt: aiGeneratedAt ?? undefined,
              escalationFlag: escalate, escalationReason: escalate ? escalationReason : undefined,
              sessionMinutes, ...bhiFields, ...ccmFields,
              markCompleted: false,
            })} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 active:scale-[0.97] disabled:opacity-50 transition">
              <Save size={15} /> Save Draft
            </button>
            <button disabled={saveNote.isPending} onClick={() => saveNote.mutate({
              ccmTaskId: taskId, patientId: patientId!, ...responses, generatedNote,
              aiGeneratedAt: aiGeneratedAt ?? undefined,
              escalationFlag: escalate, escalationReason: escalate ? escalationReason : undefined,
              sessionMinutes, ...bhiFields, ...ccmFields,
              markCompleted: true,
            })} className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-2xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
              {saveNote.isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Complete & Save
            </button>
          </div>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
