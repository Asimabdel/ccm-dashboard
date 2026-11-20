import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, Copy, Download, ListChecks, Plus } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { downloadCsv } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AD_LIMITS, buildAdKit, kitRows, type KitAdGroup, type KitCampaign } from "@shared/adKit";
import { money } from "@shared/payments";
import { CopyBox, copyText } from "./AdsDialogs";

type Campaign = RouterOutputs["masterBilling"]["adsReport"]["campaignList"][number];
type Clinic = { id: number; name: string; address: string | null };

/** Google's own way of writing a search word: "phrase match" in quotes, [exact match] in brackets. */
const keywordLine = (k: { text: string; match: "phrase" | "exact" }) => (k.match === "exact" ? `[${k.text}]` : `"${k.text}"`);

/**
 * The campaign kit: a Google Search plan written for the clinics picked, ready to copy into Google Ads. "Set these up
 * in MyPCP" makes the matching campaigns here (same tracking codes), so bookings and calls are counted from day one.
 */
export function AdKitView({ clinics, campaigns }: { clinics: Clinic[]; campaigns: Campaign[] }) {
  const utils = trpc.useUtils();
  const [picked, setPicked] = useState<number[]>(() => clinics.map((c) => c.id));
  const [budget, setBudget] = useState("2000");
  const [spanish, setSpanish] = useState(true);
  const [selfPay, setSelfPay] = useState(false);
  const [sameWeek, setSameWeek] = useState(false);
  const monthly = Math.max(0, Math.round(Number(budget.replace(/[$,\s]/g, "")) || 0));
  const kit = useMemo(() => buildAdKit(clinics.filter((c) => picked.includes(c.id)), { monthlyBudget: monthly, spanish, selfPay, sameWeek }), [clinics, picked, monthly, spanish, selfPay, sameWeek]);
  const have = new Set(campaigns.map((c) => c.code));
  const missing = kit.campaigns.filter((c) => !have.has(c.code));
  const save = trpc.masterBilling.adsSaveCampaign.useMutation();
  const [busy, setBusy] = useState(false);
  const setUp = async () => {
    setBusy(true);
    try {
      for (const c of missing) {
        await save.mutateAsync({ name: c.name, channel: "google_search", code: c.code, clinicId: c.clinicId, language: c.language, monthlyBudgetCents: c.monthlyBudgetCents, status: "paused", outsideName: c.googleName, note: "From the campaign kit. Switch to Active when it starts running in Google." });
      }
      toast.success(`${missing.length} campaign${missing.length === 1 ? "" : "s"} set up here, paused until the ads run.`);
      void utils.masterBilling.adsReport.invalidate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  };
  const perDay = kit.campaigns.reduce((s, c) => s + c.dailyBudgetCents, 0);
  const thin = kit.campaigns.length > 0 && kit.campaigns.some((c) => c.dailyBudgetCents < 1500);

  return (
    <div className="space-y-5">
      <Panel title="Your Google Search plan" subtitle="Pick the clinics that have room for new patients and a monthly amount. The plan below rewrites itself. Nothing is sent to Google from here: it's yours to copy into Google Ads.">
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Clinics to advertise</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {clinics.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                    className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm", on ? "border-brand bg-brand-soft text-brand dark:bg-teal-400/15 dark:text-teal-200" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300")}>
                    {on && <Check size={13} />}{c.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700 dark:text-slate-200">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={spanish} onChange={(e) => setSpanish(e.target.checked)} /> A campaign in Spanish</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={selfPay} onChange={(e) => setSelfPay(e.target.checked)} /> Ads for people with no insurance</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={sameWeek} onChange={(e) => setSameWeek(e.target.checked)} /> We can see new patients this week</label>
            </div>
          </div>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Budget per month, all campaigns</span>
            <span className="mt-1 flex items-center gap-2"><span className="text-slate-500">$</span><input className={cn(inputCls, "w-32")} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget per month" /></span>
            <span className="mt-1 block text-xs text-slate-500">About {money(perDay)} a day</span></label>
          {thin && (
            <p className="rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900 md:col-span-2 dark:bg-amber-500/10 dark:text-amber-200">
              That comes to {money(Math.min(...kit.campaigns.map((c) => c.dailyBudgetCents)))} a day for the smallest campaign: only a click or two. Google learns faster with about $15 or more a day each, so pick fewer clinics or raise the budget.
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700/60">
          <Btn onClick={() => void setUp()} disabled={!missing.length || busy}><Plus size={14} /> {missing.length ? `Set up ${missing.length === kit.campaigns.length ? "these" : `the ${missing.length} new`} campaign${missing.length === 1 ? "" : "s"} in MyPCP` : "All set up in MyPCP"}</Btn>
          <Btn variant="secondary" onClick={() => downloadCsv("google-search-campaign-kit.csv", kitRows(kit))} disabled={!kit.campaigns.length}><Download size={14} /> Download the whole plan (spreadsheet)</Btn>
          <span className="text-xs text-slate-500">{kit.campaigns.length} campaign{kit.campaigns.length === 1 ? "" : "s"} · {kit.campaigns.reduce((s, c) => s + c.adGroups.length, 0)} ad groups · {kit.campaigns.reduce((s, c) => s + c.adGroups.reduce((n, g) => n + g.keywords.length, 0), 0)} search words</span>
        </div>
      </Panel>

      {!kit.campaigns.length && <Panel><p className="text-sm text-slate-500">Pick at least one clinic.</p></Panel>}

      {kit.campaigns.length > 0 && (
        <Panel title="Before any ad goes live" subtitle="Only you can confirm these. Each one that isn't true costs money.">
          <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
            {kit.confirm.map((c) => <li key={c} className="flex gap-2"><ListChecks size={15} className="mt-0.5 shrink-0 text-brand" />{c}</li>)}
          </ul>
        </Panel>
      )}

      {kit.campaigns.map((c) => <KitCampaignCard key={c.code} c={c} inMyPcp={have.has(c.code)} />)}

      {kit.campaigns.length > 0 && (
        <>
          <Panel title="Extras that go on every campaign" subtitle="Google calls these assets. They make the ad bigger on the page at no extra cost.">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Extra links under the ad (sitelinks)</p>
                <ul className="mt-2 space-y-2 text-sm">
                  {kit.sitelinks.map((s) => (
                    <li key={s.text} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                      <b className="text-slate-800 dark:text-slate-100">{s.text}</b><span className="block text-slate-600 dark:text-slate-300">{s.line1} {s.line2}</span><span className="block text-xs text-slate-500">{s.url}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-3">
                <div><p className="text-sm font-medium text-slate-700 dark:text-slate-200">Short extras (callouts)</p><div className="mt-2"><CopyBox text={kit.callouts.join("\n")} what="Callouts copied" mono={false} /></div></div>
                <div><p className="text-sm font-medium text-slate-700 dark:text-slate-200">Services list (structured snippet: {kit.snippets.header})</p><div className="mt-2"><CopyBox text={kit.snippets.values.join("\n")} what="Services copied" mono={false} /></div></div>
              </div>
            </div>
          </Panel>
          <Panel title="Settings to use in Google Ads">
            <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-[11rem_1fr]">
              {kit.settings.map((s) => (<div key={s.label} className="contents"><dt className="font-medium text-slate-700 dark:text-slate-200">{s.label}</dt><dd className="text-slate-600 dark:text-slate-300">{s.value}</dd></div>))}
            </dl>
          </Panel>
          <p className="text-xs text-slate-500">
            Headlines are kept to {AD_LIMITS.headline} characters and descriptions to {AD_LIMITS.description}, Google&apos;s limits. The ads say what the clinic offers and never mention a person&apos;s health. The blocked words keep the ads away from
            Medicaid, plans the clinic doesn&apos;t take, job seekers and other clinics&apos; names. Edit anything that doesn&apos;t sound like you before it runs.
          </p>
        </>
      )}
    </div>
  );
}

function KitCampaignCard({ c, inMyPcp }: { c: KitCampaign; inMyPcp: boolean }) {
  const [open, setOpen] = useState<string | null>(c.adGroups[0]?.name ?? null);
  return (
    <Panel title={c.googleName} bodyClassName="p-0"
      subtitle={`${money(c.dailyBudgetCents)} a day (${money(c.monthlyBudgetCents)} a month) · ${c.language === "es" ? "Spanish" : "English"} · ${inMyPcp ? "set up in MyPCP" : "not in MyPCP yet"}`}
      action={<Btn size="sm" variant="secondary" onClick={() => copyText(c.googleName, "Campaign name copied")}><Copy size={12} /> Copy name</Btn>}>
      <div className="space-y-3 border-b border-slate-100 p-4 text-sm dark:border-slate-700/60">
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Where it shows</p>
          <ul className="mt-1 text-slate-600 dark:text-slate-300">
            {c.areas.map((a) => <li key={a.clinicId}>{a.radiusMiles} miles around {a.address ?? a.clinicName} <span className="text-xs text-slate-500">({a.clinicName})</span></li>)}
          </ul>
        </div>
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Final URL suffix <span className="font-normal text-slate-500">(Campaign settings → Campaign URL options). This is what counts the bookings.</span></p>
          <div className="mt-1"><CopyBox text={c.suffix} what="Suffix copied" /></div>
        </div>
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Words to block <span className="font-normal text-slate-500">({c.negatives.length}; Keywords → Negative keywords, as phrase match)</span></p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Btn size="sm" variant="secondary" onClick={() => copyText(c.negatives.map((n) => `"${n}"`).join("\n"), "Blocked words copied")}><Copy size={12} /> Copy all {c.negatives.length}</Btn>
            <details className="min-w-0 flex-1 text-xs text-slate-500"><summary className="cursor-pointer">See them</summary><p className="mt-1">{c.negatives.join(" · ")}</p></details>
          </div>
        </div>
      </div>
      <ul>
        {c.adGroups.map((g) => (
          <li key={g.name} className="border-b border-slate-100 last:border-0 dark:border-slate-700/60">
            <button type="button" aria-expanded={open === g.name} onClick={() => setOpen(open === g.name ? null : g.name)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40">
              {open === g.name ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <span className="font-medium text-slate-800 dark:text-slate-100">{g.name}</span>
              <span className="text-sm text-slate-500">{g.about}</span>
              <span className="ml-auto whitespace-nowrap text-xs text-slate-500">{g.keywords.length} words · {g.headlines.length} headlines</span>
            </button>
            {open === g.name && <AdGroup g={g} finalUrl={c.finalUrl} />}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AdGroup({ g, finalUrl }: { g: KitAdGroup; finalUrl: string }) {
  const host = finalUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="grid gap-4 px-4 pb-4 text-sm lg:grid-cols-2">
      <div className="space-y-3">
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Search words <span className="font-normal text-slate-500">(paste into Keywords as they are)</span></p>
          <div className="mt-1"><CopyBox text={g.keywords.map(keywordLine).join("\n")} what="Search words copied" /></div>
        </div>
        {g.note && <p className="rounded-lg bg-amber-50 p-2.5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{g.note}</p>}
      </div>
      <div className="space-y-3">
        {/* How one mix of these lines looks on Google. */}
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <p className="text-xs text-slate-500">How it can look on Google</p>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300"><b>Sponsored</b> · {host}/{g.path1}/{g.path2}</p>
          <p className="text-base leading-snug text-blue-700 dark:text-blue-300">{g.headlines.slice(0, 3).join(" | ")}</p>
          <p className="text-slate-600 dark:text-slate-300">{g.descriptions.slice(0, 2).join(" ")}</p>
        </div>
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Headlines <span className="font-normal text-slate-500">(Google mixes them; up to {AD_LIMITS.headline} characters each)</span></p>
          <div className="mt-1"><CopyBox text={g.headlines.join("\n")} what="Headlines copied" mono={false} /></div>
        </div>
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Descriptions <span className="font-normal text-slate-500">(up to {AD_LIMITS.description} characters each)</span></p>
          <div className="mt-1"><CopyBox text={g.descriptions.join("\n")} what="Descriptions copied" mono={false} /></div>
        </div>
        <p className="text-xs text-slate-500">Web address shown: {host}/<b>{g.path1}</b>/<b>{g.path2}</b> · opens {finalUrl}</p>
      </div>
    </div>
  );
}
