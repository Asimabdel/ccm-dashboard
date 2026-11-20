import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, ExternalLink, FileUp, Megaphone, Plus, Target, UserPlus } from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, Panel, SelectBox } from "@/components/workspace/ui";
import { downloadCsv, niceName } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  AD_JUDGE_DAYS, AD_LEAD_KIND_LABELS, AD_LOST_REASONS, AD_OUTCOME_LABELS, AD_VERDICTS, adChannel, adLanguageLabel, adVerdict,
  type AdLeadOutcome, type AdLostReason, type AdRow,
} from "@shared/ads";
import { addDays, money } from "@shared/payments";
import { localDateStr } from "@shared/workforce";
import { AdKitView } from "./AdKit";
import { CampaignDialog, CampaignPanel, LeadDialog, SpendDialog, SpendUpload } from "./AdsDialogs";

type Report = RouterOutputs["masterBilling"]["adsReport"];
type Campaign = Report["campaignList"][number];
type LeadFilter = "all" | "waiting" | "not_called" | "booked" | "came_in" | "upcoming" | "pending" | "lost" | "repeat" | "existing" | "spam";

type Preset = "3m" | "month" | "lastMonth" | "ytd" | "12m";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "3m", label: "Last 3 months" }, { key: "month", label: "This month" }, { key: "lastMonth", label: "Last month" }, { key: "ytd", label: "This year" }, { key: "12m", label: "Last 12 months" },
];
function presetRange(p: Preset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (p) {
    case "3m": return { from: addDays(today, -91), to: today };
    case "month": return { from: first(y, m), to: today };
    case "lastMonth": { const ly = m === 1 ? y - 1 : y; const lm = m === 1 ? 12 : m - 1; return { from: first(ly, lm), to: addDays(first(y, m), -1) }; }
    case "ytd": return { from: `${y}-01-01`, to: today };
    case "12m": return { from: addDays(today, -365), to: today };
  }
}

const LEAD_FILTERS: { key: LeadFilter; label: string }[] = [
  { key: "all", label: "Everyone" }, { key: "waiting", label: "Waiting for a call now" }, { key: "not_called", label: "Never called" }, { key: "booked", label: "Booked" },
  { key: "came_in", label: "Came in" }, { key: "upcoming", label: "Has a visit booked" }, { key: "pending", label: "Too soon to tell" }, { key: "lost", label: "Never came in (lost)" },
  { key: "existing", label: "Already our patient" }, { key: "repeat", label: "Same person again" }, { key: "spam", label: "Tests and junk" },
];
const REASON_LABEL = Object.fromEntries(AD_LOST_REASONS.map((r) => [r.key, r.label])) as Record<AdLostReason, string>;
const VERDICT_TONE = {
  good: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300", warn: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  bad: "bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300", neutral: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
} as const;

const monthLabel = (m: string) => (/^\d{4}-\d{2}$/.test(m) ? new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : m);
const dayTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const shortDay = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const per = (cents: number, n: number) => (n ? money(Math.round(cents / n)) : "–");
const ratio = (paid: number, spent: number) => (spent ? `$${(paid / spent).toFixed(2)}` : "–");
const waitText = (min: number | null) => (min == null ? "–" : min < 60 ? `${min} min` : min < 480 ? `${(min / 60).toFixed(1)} office hrs` : `${Math.round(min / 480)} office day${Math.round(min / 480) === 1 ? "" : "s"}`);
const th = "px-3 py-2 text-right font-medium";
const td = "px-3 py-2 text-right tabular-nums";

/**
 * Ads (owner only): what each campaign costs and what its leads became, followed the same way the ZocDoc tab
 * follows bookings. Leads come in by themselves: a website booking that carries a campaign's tracking code, or a
 * call to a campaign's own phone number. Spend is typed in or uploaded from Google's / Facebook's report.
 */
export function AdsTab() {
  const today = localDateStr();
  const [view, setView] = useState<"results" | "kit">("results");
  const [preset, setPreset] = useState<Preset | "custom">("3m");
  const [range, setRange] = useState(presetRange("3m", today));
  const [dialog, setDialog] = useState<null | { kind: "campaign"; campaign: Campaign | null } | { kind: "spend"; campaignId: number | null } | { kind: "upload" } | { kind: "lead" }>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState<LeadFilter>("all");
  const [leadCampaign, setLeadCampaign] = useState<number | null>(null);
  const leadsRef = useRef<HTMLDivElement>(null);
  const q = trpc.masterBilling.adsReport.useQuery(range);
  const bench = trpc.masterBilling.adsBenchmark.useQuery(undefined, { staleTime: 30 * 60_000 });
  const d = q.data;
  const t = d?.totals;
  const benchCents = bench.data?.costPerPatientCents ?? 10_000;
  const showLeads = (f: LeadFilter, campaignId: number | null = null) => { setFilter(f); setLeadCampaign(campaignId); setTimeout(() => leadsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
  const open = d?.campaignList.find((c) => c.id === openId) ?? null;
  const rowOf = (id: number) => d?.campaigns.find((r) => r.key === String(id));

  const campaignsCsv = () => d && downloadCsv(`ads-by-campaign-${range.from}-to-${range.to}.csv`, [
    ["Campaign", "Where", "Clinic", "Language", "Spent", "Clicks", "Leads", "New-patient leads", "Called within 15 min", "Booked", "Came in", "Judged", "Insurance paid", "Cost per patient", "Insurance per $1"],
    ...d.campaignList.map((c) => {
      const r = rowOf(c.id);
      return [c.name, adChannel(c.channel).label, c.clinicName ?? "All clinics", adLanguageLabel(c.language), ((r?.spendCents ?? 0) / 100).toFixed(2), r?.clicks ?? 0, r?.leads ?? 0, r?.counted ?? 0, r?.calledFast ?? 0,
        r?.booked ?? 0, r?.cameIn ?? 0, r?.judged ?? 0, ((r?.paidCents ?? 0) / 100).toFixed(2), r?.cameIn ? (r.spendCents / r.cameIn / 100).toFixed(2) : "", r?.spendCents ? (r.paidCents / r.spendCents).toFixed(2) : ""];
    }),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-600" role="tablist" aria-label="Ads view">
          {([["results", "Results"], ["kit", "Campaign kit"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium", view === k ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>{label}</button>
          ))}
        </div>
        {view === "results" && (
          <>
            {PRESETS.map((p) => <Btn key={p.key} size="sm" variant={preset === p.key ? "primary" : "secondary"} onClick={() => { setPreset(p.key); setRange(presetRange(p.key, today)); }}>{p.label}</Btn>)}
            <input type="date" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, from: e.target.value })); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, to: e.target.value })); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="To" />
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Btn size="sm" variant="secondary" onClick={() => setDialog({ kind: "spend", campaignId: null })} disabled={!d?.campaignList.length}><Plus size={13} /> Add spend</Btn>
          <Btn size="sm" variant="secondary" onClick={() => setDialog({ kind: "upload" })} disabled={!d?.campaignList.length}><FileUp size={13} /> Upload spend report</Btn>
          <Btn size="sm" onClick={() => setDialog({ kind: "campaign", campaign: null })}><Plus size={13} /> Add campaign</Btn>
        </div>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}

      {d && view === "kit" && <AdKitView clinics={d.clinicList} campaigns={d.campaignList} />}

      {d && view === "results" && (
        <>
          <NumberToBeat bench={bench.data} loading={bench.isLoading} />

          {!d.campaignList.length ? (
            <Panel>
              <EmptyState icon={Megaphone} title="No ad campaigns yet"
                body={<>Start with the <b>Campaign kit</b>: it writes a Google Search plan for your clinics (search words, ads in English and Spanish, budgets) and sets the campaigns up here so every booking and call is counted. Or add a campaign by hand for an ad you already run.</>}
                action={<div className="flex flex-wrap justify-center gap-2"><Btn onClick={() => setView("kit")}><Target size={15} /> Open the campaign kit</Btn><Btn variant="secondary" onClick={() => setDialog({ kind: "campaign", campaign: null })}><Plus size={15} /> Add a campaign</Btn></div>} />
              <HowItWorks />
            </Panel>
          ) : t && (
            <>
              {d.speed.waitingNow > 0 && (
                <button type="button" onClick={() => showLeads("waiting")} className="flex w-full items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-left hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/10">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-300" />
                  <span className="text-sm text-rose-900 dark:text-rose-100"><b>{d.speed.waitingNow} ad lead{d.speed.waitingNow === 1 ? " has" : "s have"} waited more than 15 office minutes for a call.</b> These were paid for and are comparing clinics right now. Click to see who.</span>
                </button>
              )}

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="Spent on ads" value={money(t.spendCents)} hint={`${t.clicks.toLocaleString()} clicks${d.spendThrough ? ` · spend entered through ${shortDay(d.spendThrough)}` : " · no spend entered yet"}`} />
                <MetricCard label="Leads" value={t.leads.toLocaleString()} hint={`${t.webLeads} website · ${t.callLeads} calls${t.spendCents && t.leads ? ` · ${per(t.spendCents, t.leads)} each` : ""}`} />
                <MetricCard label="Called within 15 minutes" value={pct(d.speed.within15, d.speed.called)} tone={d.speed.called && d.speed.within15 / d.speed.called < 0.6 ? "bad" : "good"}
                  hint={d.speed.called ? `${d.speed.within15} of ${d.speed.called} · the middle wait is ${waitText(d.speed.medianMinutes)}` : "nobody to time yet"} />
                <MetricCard label="Booked a visit" value={pct(t.booked, t.counted)} hint={`${t.booked} of ${t.counted} new-patient leads`} />
                <MetricCard label="Came in" value={pct(t.cameIn, t.judged)} tone={t.judged >= 8 && t.cameIn / t.judged < 0.4 ? "warn" : "neutral"}
                  hint={`${t.cameIn} of ${t.judged} judged${t.counted - t.judged > 0 ? ` · ${t.counted - t.judged} too soon to tell` : ""}`} />
                <MetricCard label="Cost per patient who came in" value={per(t.spendCents, t.cameIn)} tone={t.cameIn ? (t.spendCents / t.cameIn <= benchCents ? "good" : "warn") : "neutral"}
                  hint={t.cameIn ? `ZocDoc costs ${money(benchCents)} per patient` : "ad cost ÷ patients who came in"} />
                <MetricCard label="Insurance paid" value={money(t.paidCents)} tone="good" hint={`${money(t.owesCents)} more billed to the patients`} />
                <MetricCard label="Insurance per $1 spent" value={ratio(t.paidCents, t.spendCents)} tone={t.spendCents && t.paidCents >= t.spendCents ? "good" : "neutral"} hint="fills in for months as insurance pays" />
              </div>

              <Funnel t={t} />

              <Panel title="Campaigns" bodyClassName="p-0" action={<Btn size="sm" variant="secondary" onClick={campaignsCsv}>CSV</Btn>}
                subtitle="Click a campaign for its tracking link, phone number, budget and spend. The verdict compares each one with what ZocDoc costs per patient.">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1040px] text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Campaign</th><th className={th}>Spent</th><th className={th}>Clicks</th><th className={th}>Leads</th><th className={th}>Per lead</th>
                        <th className={th}>Called fast</th><th className={th}>Booked</th><th className={th}>Came in</th><th className={th}>Per patient</th><th className={th}>Insurance paid</th><th className={th}>Per $1</th>
                        <th className="px-3 py-2 text-left font-medium">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.campaignList.map((c) => {
                        const r = rowOf(c.id);
                        const v = r ? adVerdict(r, benchCents, c.paid) : c.paid ? "too_soon" : "free";
                        return (
                          <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                            <td className="px-3 py-2">
                              <span className="font-medium text-slate-900 dark:text-slate-100">{c.name}</span>
                              {c.status !== "active" && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">{c.status}</span>}
                              <span className="block text-xs text-slate-500">{adChannel(c.channel).label} · {c.clinicName ?? "All clinics"} · {adLanguageLabel(c.language)}{c.pace ? ` · ${money(c.spentThisMonthCents)} of ${money(c.monthlyBudgetCents)} this month` : ""}</span>
                            </td>
                            <td className={td}>{money(r?.spendCents ?? 0)}</td><td className={td}>{(r?.clicks ?? 0).toLocaleString()}</td>
                            <td className={td}>{r?.leads ?? 0}</td><td className={td}>{per(r?.spendCents ?? 0, r?.leads ?? 0)}</td>
                            <td className={td}>{r?.counted ? pct(r.calledFast, r.counted) : "–"}</td><td className={td}>{r?.booked ?? 0}</td>
                            <td className={td}>{r?.judged ? `${r.cameIn} (${pct(r.cameIn, r.judged)})` : r?.counted ? "too soon" : "–"}</td>
                            <td className={td}>{per(r?.spendCents ?? 0, r?.cameIn ?? 0)}</td><td className={td}>{money(r?.paidCents ?? 0)}</td><td className={td}>{ratio(r?.paidCents ?? 0, r?.spendCents ?? 0)}</td>
                            <td className="px-3 py-2"><span title={AD_VERDICTS[v].note} className={cn("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", VERDICT_TONE[AD_VERDICTS[v].tone])}>{AD_VERDICTS[v].label}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Leaks d={d} onShow={showLeads} />

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="By month" bodyClassName="p-0" subtitle="Spend in the month it was paid; leads and patients in the month they first got in touch."><RowTable rows={d.months} label="Month" fmt={monthLabel} /></Panel>
                <Panel title="By where the ad ran" bodyClassName="p-0"><RowTable rows={d.channels} label="Where" /></Panel>
                <Panel title="By clinic" bodyClassName="p-0" subtitle="The clinic each campaign is aimed at."><RowTable rows={d.clinics} label="Clinic" /></Panel>
                <Panel title="By language" bodyClassName="p-0"><RowTable rows={d.languages} label="Language" /></Panel>
              </div>

              {d.keywords.length > 0 && (
                <Panel title="Search words that brought bookings" bodyClassName="p-0" subtitle="What people typed before they booked on the website. Google's own report has the cost of each word; this shows which ones became patients.">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[480px] text-sm">
                      <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                        <tr><th className="px-3 py-2 text-left font-medium">Search words</th><th className={th}>Leads</th><th className={th}>Booked</th><th className={th}>Came in</th><th className={th}>Insurance paid</th></tr>
                      </thead>
                      <tbody>
                        {d.keywords.map((k) => (
                          <tr key={k.key} className="border-t border-slate-100 dark:border-slate-700/60">
                            <td className="px-3 py-2">{k.key}</td><td className={td}>{k.leads}</td><td className={td}>{k.booked}</td><td className={td}>{k.cameIn}</td><td className={td}>{money(k.paidCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <div ref={leadsRef}>
                <Leads range={range} filter={filter} setFilter={setFilter} campaignId={leadCampaign} setCampaignId={setLeadCampaign} campaigns={d.campaignList} onAdd={() => setDialog({ kind: "lead" })} />
              </div>

              <p className="text-xs text-slate-500">
                A lead is one person&apos;s first contact from a campaign: a website booking that came through the campaign&apos;s link, or a call to its phone number. The same person again within 90 days stays one lead, and
                someone who was already a patient isn&apos;t counted as a new one. &ldquo;Came in&rdquo; means a visit on the schedule, a signed chart visit, or an insurance claim on or after the day they got in touch; a lead with
                none of those after {AD_JUDGE_DAYS} days counts as lost. Insurance paid comes from the payment files in Master Billing, so recent months fill in as insurance pays. These are revenue, not profit.
                {d.spam ? ` ${d.spam} test or junk request${d.spam === 1 ? " is" : "s are"} left out.` : ""}
              </p>
            </>
          )}
        </>
      )}

      {dialog?.kind === "campaign" && d && <CampaignDialog campaign={dialog.campaign} clinics={d.clinicList} onClose={() => setDialog(null)} onSaved={(id) => { setDialog(null); setOpenId(id); }} />}
      {dialog?.kind === "spend" && d && <SpendDialog campaigns={d.campaignList} campaignId={dialog.campaignId} today={today} onClose={() => setDialog(null)} />}
      {dialog?.kind === "upload" && d && <SpendUpload campaigns={d.campaignList} today={today} onClose={() => setDialog(null)} />}
      {dialog?.kind === "lead" && d && <LeadDialog campaigns={d.campaignList} today={today} onClose={() => setDialog(null)} />}
      {open && !dialog && (
        <CampaignPanel campaign={open} row={rowOf(open.id) ?? null} benchCents={benchCents} onClose={() => setOpenId(null)}
          onEdit={() => setDialog({ kind: "campaign", campaign: open })} onSpend={() => setDialog({ kind: "spend", campaignId: open.id })}
          onLeads={() => { setOpenId(null); showLeads("all", open.id); }} />
      )}
    </div>
  );
}

/** What a patient who came in costs through ZocDoc: the number every campaign is compared with. */
function NumberToBeat({ bench, loading }: { bench: RouterOutputs["masterBilling"]["adsBenchmark"] | undefined; loading: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <Target size={18} className="mt-0.5 shrink-0 text-brand" />
      <p className="text-sm text-slate-700 dark:text-slate-200">
        <b>The number to beat: {loading || !bench ? "…" : money(bench.costPerPatientCents)} per new patient who actually comes in.</b>{" "}
        {loading || !bench ? "Working it out from your ZocDoc numbers." : bench.source === "zocdoc"
          ? <>That is what ZocDoc cost over the last 12 months ({bench.cameIn.toLocaleString()} patients came in{bench.perDollar ? `, about $${bench.perDollar.toFixed(2)} back from insurance per $1` : ""}). An ad that brings patients in for less is worth more budget; one that costs more should be fixed or paused.</>
          : <>No ZocDoc report is loaded, so this is a round starting number. Upload a ZocDoc report in the ZocDoc tab to use your own.</>}
      </p>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["Set up a campaign", "Each one gets a short tracking code and, if you want, its own phone number."],
    ["Put the code in the ad", "Paste the campaign's link ending into Google or Facebook once. From then on a website booking from that ad is counted by itself."],
    ["Enter what it cost", "Type the month's spend, or upload the report Google and Facebook let you download."],
    ["Watch what comes back", "For every lead: how fast we called, whether they booked, whether they came in, and what insurance paid."],
  ];
  return (
    <ol className="mx-auto mt-2 grid max-w-3xl gap-3 px-4 pb-5 sm:grid-cols-2">
      {steps.map(([title, body], i) => (
        <li key={title} className="flex gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">{i + 1}</span>
          <span className="text-sm"><b className="text-slate-800 dark:text-slate-100">{title}.</b> <span className="text-slate-600 dark:text-slate-300">{body}</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Click → lead → called → booked → came in, each as a share of the step before. */
function Funnel({ t }: { t: AdRow }) {
  const steps = [
    { label: "Clicks on the ads", n: t.clicks, of: null as number | null },
    { label: "New-patient leads", n: t.counted, of: t.clicks || null },
    { label: "Called", n: t.called, of: t.counted },
    { label: "Booked a visit", n: t.booked, of: t.counted },
    { label: "Came in", n: t.cameIn, of: t.booked },
  ];
  const max = Math.max(1, t.counted);
  return (
    <Panel title="From ad to patient" subtitle="Each line is a share of the one above it. The biggest drop is where to look first.">
      <ul className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.label} className="grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-2 text-sm sm:grid-cols-[10rem_1fr_7rem] sm:gap-3">
            <span className="text-slate-600 dark:text-slate-300">{s.label}</span>
            <span className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800">
              {i > 0 && <span className="block h-2.5 rounded-full bg-brand" style={{ width: `${Math.min(100, (s.n / max) * 100)}%` }} />}
            </span>
            <span className="text-right tabular-nums text-slate-900 dark:text-slate-100">{s.n.toLocaleString()}{s.of ? <span className="ml-1.5 text-xs text-slate-500">{pct(s.n, s.of)}</span> : null}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function RowTable({ rows, label, fmt }: { rows: AdRow[]; label: string; fmt?: (k: string) => string }) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-slate-500">Nothing in this range.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          <tr><th className="px-3 py-2 text-left font-medium">{label}</th><th className={th}>Spent</th><th className={th}>Leads</th><th className={th}>Came in</th><th className={th}>Per patient</th><th className={th}>Insurance paid</th><th className={th}>Per $1</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100 dark:border-slate-700/60">
              <td className="px-3 py-2">{fmt ? fmt(r.label) : r.label}</td><td className={td}>{money(r.spendCents)}</td><td className={td}>{r.leads}</td>
              <td className={td}>{r.judged ? `${r.cameIn} (${pct(r.cameIn, r.judged)})` : r.counted ? "too soon" : "–"}</td>
              <td className={td}>{per(r.spendCents, r.cameIn)}</td><td className={td}>{money(r.paidCents)}</td><td className={td}>{ratio(r.paidCents, r.spendCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Where paid-for leads are lost, in the order the patient meets each step. */
function Leaks({ d, onShow }: { d: Report; onShow: (f: LeadFilter) => void }) {
  const lost = d.lost;
  const max = Math.max(1, ...lost.reasons.map((r) => r.leads));
  const note = Object.fromEntries(AD_LOST_REASONS.map((r) => [r.key, r.note])) as Record<AdLostReason, string>;
  return (
    <Panel title="Where leads are lost" subtitle={lost.judged ? `${lost.lost} of ${lost.judged} new-patient leads old enough to judge never came in (${pct(lost.lost, lost.judged)}).` : "Fills in once leads are a month old."}
      action={lost.lost > 0 ? <Btn size="sm" variant="secondary" onClick={() => onShow("lost")}>See who</Btn> : undefined}>
      <ul className="space-y-2.5">
        {lost.reasons.map((r) => (
          <li key={r.key} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-2 text-sm sm:grid-cols-[12rem_1fr_3rem] sm:gap-3" title={note[r.key]}>
            <span className="text-slate-700 dark:text-slate-200">{REASON_LABEL[r.key]}</span>
            <span className="h-2 rounded-full bg-slate-100 dark:bg-slate-800"><span className="block h-2 rounded-full bg-rose-500/80" style={{ width: `${(r.leads / max) * 100}%` }} /></span>
            <span className="text-right tabular-nums">{r.leads}</span>
          </li>
        ))}
      </ul>
      {d.clicksNoLeads.campaigns > 0 && (
        <p className="mt-4 rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <b>{money(d.clicksNoLeads.spendCents)} went to {d.clicksNoLeads.clicks.toLocaleString()} clicks on {d.clicksNoLeads.campaigns} campaign{d.clicksNoLeads.campaigns === 1 ? "" : "s"} that brought no lead at all.</b>{" "}
          Either the tracking link isn&apos;t on the ad, or people land on the page and leave. Check the link first.
        </p>
      )}
    </Panel>
  );
}

function Leads({ range, filter, setFilter, campaignId, setCampaignId, campaigns, onAdd }: {
  range: { from: string; to: string }; filter: LeadFilter; setFilter: (f: LeadFilter) => void; campaignId: number | null; setCampaignId: (id: number | null) => void; campaigns: Campaign[]; onAdd: () => void;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filter, campaignId, range.from, range.to]);
  const q = trpc.masterBilling.adsLeads.useQuery({ ...range, filter, campaignId, page });
  const utils = trpc.useUtils();
  const mark = trpc.masterBilling.adsSetLeadOutcome.useMutation({
    onSuccess: () => { void utils.masterBilling.adsLeads.invalidate(); void utils.masterBilling.adsReport.invalidate(); }, onError: (e) => toast.error(e.message),
  });
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <Panel title="Leads" bodyClassName="p-0" subtitle="Everyone the ads brought in, newest first. Only you see this list."
      action={<div className="flex flex-wrap items-center gap-2">
        <SelectBox ariaLabel="Campaign" value={campaignId ? String(campaignId) : ""} onChange={(v) => setCampaignId(v ? Number(v) : null)} className="h-8 py-1 text-xs">
          <option value="">All campaigns</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectBox>
        <SelectBox ariaLabel="Show" value={filter} onChange={(v) => setFilter(v as LeadFilter)} className="h-8 py-1 text-xs">{LEAD_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</SelectBox>
        <Btn size="sm" variant="secondary" onClick={onAdd}><UserPlus size={13} /> Add a lead</Btn>
      </div>}>
      {q.isLoading && <div className="p-4"><Loading /></div>}
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {d && (d.rows.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">When</th><th className="px-3 py-2 text-left font-medium">Who</th><th className="px-3 py-2 text-left font-medium">Campaign</th>
                  <th className="px-3 py-2 text-left font-medium">How</th><th className={th}>Wait for a call</th><th className="px-3 py-2 text-left font-medium">What happened</th><th className={th}>Insurance paid</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 align-top dark:border-slate-700/60">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{dayTime(r.at)}</td>
                    <td className="px-3 py-2">
                      {r.subjectKey
                        ? <Link href={`/patients/${encodeURIComponent(r.subjectKey)}`} className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">{niceName(r.name) || "Patient"} <ExternalLink size={12} /></Link>
                        : <span>{niceName(r.name) || <span className="text-slate-400">No name yet</span>}</span>}
                      <span className="block text-xs text-slate-500">{r.phone ?? "no phone"}{r.existing ? " · already our patient" : r.repeat ? " · same person as an earlier lead" : !r.subjectKey ? " · not in MyPCP yet" : ""}</span>
                    </td>
                    <td className="px-3 py-2">{r.campaignName}{r.keyword ? <span className="block text-xs text-slate-500">searched: {r.keyword}</span> : null}</td>
                    <td className="px-3 py-2">
                      {r.bookingRequestId ? <Link href={`/bookings?b=${r.bookingRequestId}`} className="text-blue-700 hover:underline dark:text-blue-300">{AD_LEAD_KIND_LABELS.web}</Link> : AD_LEAD_KIND_LABELS[r.kind]}
                      {r.device ? <span className="block text-xs text-slate-500">on a {r.device}</span> : null}
                    </td>
                    <td className={cn(td, r.waiting && "font-semibold text-rose-700 dark:text-rose-300")}>{r.spam || r.kind === "manual" ? "–" : r.waiting ? "still waiting" : r.answered ? "we picked up" : r.called ? waitText(r.minutesToCall) : "never called"}</td>
                    <td className="px-3 py-2">
                      {r.spam ? <span className="text-slate-400">Test or junk</span> : (
                        <span className={cn(r.outcome === "came_in" ? "text-emerald-700 dark:text-emerald-300" : r.outcome === "never" ? "text-rose-700 dark:text-rose-300" : r.outcome === "upcoming" ? "text-blue-700 dark:text-blue-300" : "text-slate-500")}>
                          {r.outcome === "came_in" ? `Came in ${shortDay(r.firstVisit)}` : r.outcome === "never" && r.lostReason ? REASON_LABEL[r.lostReason] : r.outcome === "pending" && r.booked ? "Booked, waiting for the visit" : AD_OUTCOME_LABELS[r.outcome]}
                        </span>
                      )}
                      {!r.bookingRequestId && (
                        <select aria-label="Mark how it went" value={r.markedOutcome ?? ""} disabled={mark.isPending} onChange={(e) => mark.mutate({ id: r.id, outcome: (e.target.value || null) as AdLeadOutcome | null })}
                          className="mt-1 block rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800">
                          <option value="">Mark how it went…</option><option value="scheduled">Booked a visit</option><option value="not_booked">Didn&apos;t book</option><option value="spam">Test or junk</option>
                        </select>
                      )}
                    </td>
                    <td className={td}>{r.paidCents ? money(r.paidCents) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500 dark:border-slate-700/60">
            <span>{d.total.toLocaleString()} lead{d.total === 1 ? "" : "s"}</span>
            {pages > 1 && <span className="flex items-center gap-2"><Btn size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Back</Btn>Page {page} of {pages}<Btn size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Btn></span>}
          </div>
        </>
      ) : <p className="px-4 py-6 text-sm text-slate-500">Nobody here.</p>)}
    </Panel>
  );
}
