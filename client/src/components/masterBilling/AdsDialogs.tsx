import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Copy, Download, Pencil, Plus, Trash2, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { readTableFile } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  AD_CHANNELS, AD_LANGUAGES, AD_STATUSES, AD_VERDICTS, adChannel, adCode, adLanguageLabel, adVerdict, isAdCode, matchSpendCampaign, parseSpendFile, spreadSpend,
  type AdChannel, type AdLanguage, type AdRow, type AdStatus,
} from "@shared/ads";
import { addDays, money } from "@shared/payments";
import { formatPhone } from "@shared/phone";

type Campaign = RouterOutputs["masterBilling"]["adsReport"]["campaignList"][number];
type Clinic = { id: number; name: string };

const label = "block text-sm";
const labelText = "text-slate-600 dark:text-slate-300";
const dollars = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });

export function copyText(text: string, what = "Copied") {
  void navigator.clipboard.writeText(text).then(() => toast.success(`${what}.`), () => toast.error("Couldn't copy. Select the text and copy it by hand."));
}
export function CopyBox({ text, what, mono = true }: { text: string; what?: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/60">
      <code className={cn("min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-slate-800 dark:text-slate-100", !mono && "font-sans text-sm")}>{text}</code>
      <Btn size="sm" variant="secondary" type="button" onClick={() => copyText(text, what)}><Copy size={12} /> Copy</Btn>
    </div>
  );
}

/** Add a campaign or change one. The tracking code is made from the name until it's typed over. */
export function CampaignDialog({ campaign, clinics, onClose, onSaved }: { campaign: Campaign | null; clinics: Clinic[]; onClose: () => void; onSaved: (id: number) => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(campaign?.name ?? "");
  const [channel, setChannel] = useState<AdChannel>(campaign?.channel ?? "google_search");
  const [clinicId, setClinicId] = useState(campaign?.clinicId ? String(campaign.clinicId) : "");
  const [language, setLanguage] = useState<AdLanguage>((campaign?.language as AdLanguage) ?? "en");
  const [code, setCode] = useState(campaign?.code ?? "");
  const [codeTyped, setCodeTyped] = useState(!!campaign);
  const [phone, setPhone] = useState(campaign?.trackingPhone ? formatPhone(campaign.trackingPhone) : "");
  const [budget, setBudget] = useState(campaign?.monthlyBudgetCents ? String(campaign.monthlyBudgetCents / 100) : "");
  const [status, setStatus] = useState<AdStatus>(campaign?.status ?? "active");
  const [landingUrl, setLandingUrl] = useState(campaign?.landingUrl ?? "");
  const [outsideName, setOutsideName] = useState(campaign?.outsideName ?? "");
  const [note, setNote] = useState(campaign?.note ?? "");
  const theCode = codeTyped ? code.trim().toLowerCase() : adCode(name);
  const save = trpc.masterBilling.adsSaveCampaign.useMutation({
    onSuccess: (r) => { toast.success("Saved."); void utils.masterBilling.adsReport.invalidate(); onSaved(r.id); }, onError: (e) => toast.error(e.message),
  });
  const budgetCents = budget.trim() ? dollars(budget) : null;
  const valid = !!name.trim() && isAdCode(theCode) && (budgetCents == null || (Number.isFinite(budgetCents) && budgetCents >= 0)) && (!phone.trim() || phone.replace(/\D/g, "").length >= 10) && (!landingUrl.trim() || /^https:\/\/\S+$/.test(landingUrl.trim()));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{campaign ? `Change: ${campaign.name}` : "Add an ad campaign"}</DialogTitle>
          <DialogDescription>One campaign for each ad you want to tell apart: a place it runs, a clinic, a language. Only you can see this.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ id: campaign?.id ?? null, name: name.trim(), channel, code: theCode, clinicId: clinicId ? Number(clinicId) : null, language, trackingPhone: phone.trim() || null, monthlyBudgetCents: budgetCents, status, landingUrl: landingUrl.trim() || null, outsideName: outsideName.trim() || null, note: note.trim() || null });
        }}>
          <label className={label}><span className={labelText}>Name</span>
            <input className={cn(inputCls, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Google Search - Katy" autoFocus /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}><span className={labelText}>Where it runs</span>
              <select aria-label="Where it runs" className={cn(inputCls, "mt-1")} value={channel} onChange={(e) => setChannel(e.target.value as AdChannel)}>{AD_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
            <label className={label}><span className={labelText}>Clinic</span>
              <select aria-label="Clinic" className={cn(inputCls, "mt-1")} value={clinicId} onChange={(e) => setClinicId(e.target.value)}><option value="">All clinics</option>{clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className={label}><span className={labelText}>Language of the ad</span>
              <select aria-label="Language" className={cn(inputCls, "mt-1")} value={language} onChange={(e) => setLanguage(e.target.value as AdLanguage)}>{AD_LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</select></label>
            <label className={label}><span className={labelText}>Budget per month (optional)</span>
              <input className={cn(inputCls, "mt-1")} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 500" /></label>
            <label className={label}><span className={labelText}>Tracking code</span>
              <input className={cn(inputCls, "mt-1 font-mono")} value={theCode} onChange={(e) => { setCodeTyped(true); setCode(e.target.value); }} maxLength={40} placeholder="g-katy-en" aria-invalid={!!theCode && !isAdCode(theCode)} />
              <span className="mt-1 block text-xs text-slate-500">Goes in the ad&apos;s link. Lowercase letters, numbers and dashes.</span></label>
            <label className={label}><span className={labelText}>Its own phone number (optional)</span>
              <input className={cn(inputCls, "mt-1")} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(346) 555-0100" />
              <span className="mt-1 block text-xs text-slate-500">A number used only in this ad, so calls can be counted.</span></label>
            <label className={label}><span className={labelText}>Status</span>
              <select aria-label="Status" className={cn(inputCls, "mt-1")} value={status} onChange={(e) => setStatus(e.target.value as AdStatus)}>{AD_STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</select></label>
            <label className={label}><span className={labelText}>Its name in the spend report (optional)</span>
              <input className={cn(inputCls, "mt-1")} value={outsideName} onChange={(e) => setOutsideName(e.target.value)} maxLength={160} placeholder="as Google or Facebook names it" /></label>
          </div>
          <label className={label}><span className={labelText}>Page the ad opens (optional)</span>
            <input className={cn(inputCls, "mt-1")} value={landingUrl} onChange={(e) => setLandingUrl(e.target.value)} maxLength={255} placeholder="https://mypcpdr.com/ (the home page if left empty)" /></label>
          <label className={label}><span className={labelText}>Note (optional)</span>
            <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} /></label>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn type="submit" disabled={!valid || save.isPending}>Save</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One campaign: how to connect it (link, QR code, phone), how it's doing, what it cost by month. */
export function CampaignPanel({ campaign: c, row, benchCents, onClose, onEdit, onSpend, onLeads }: {
  campaign: Campaign; row: AdRow | null; benchCents: number; onClose: () => void; onEdit: () => void; onSpend: () => void; onLeads: () => void;
}) {
  const utils = trpc.useUtils();
  const spend = trpc.masterBilling.adsCampaignSpend.useQuery({ campaignId: c.id });
  const remove = trpc.masterBilling.adsRemoveCampaign.useMutation({
    onSuccess: (r) => { toast.success(r.ended ? "Ended. Its numbers stay in the report." : "Removed."); void utils.masterBilling.adsReport.invalidate(); onClose(); }, onError: (e) => toast.error(e.message),
  });
  const [qr, setQr] = useState<string | null>(null);
  const printed = c.channel === "mail" || c.channel === "nextdoor" || c.channel === "other";
  useEffect(() => { if (printed) void QRCode.toDataURL(c.link.url, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then(setQr).catch(() => setQr(null)); }, [printed, c.link.url]);
  const v = row ? adVerdict(row, benchCents, c.paid) : c.paid ? "too_soon" : "free";
  const where = c.channel === "google_search"
    ? "In Google Ads: open the campaign → Settings → Campaign URL options → Final URL suffix. Paste this, once:"
    : c.channel === "facebook" ? "In Ads Manager: open the ad → Tracking → URL parameters. Paste this:"
    : c.channel === "google_profile" ? "On the clinic's Google page: Bookings → the booking link. Use this address:"
    : "Use this address in the ad or post. On paper, print the QR code:";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{c.name}</DialogTitle>
          <DialogDescription>{adChannel(c.channel).label} · {c.clinicName ?? "All clinics"} · {adLanguageLabel(c.language)} · {c.status}{c.note ? ` · ${c.note}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className={cn("rounded-lg p-2.5", { good: "bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200", warn: "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200", bad: "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200", neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" }[AD_VERDICTS[v].tone])}>
            <b>{AD_VERDICTS[v].label}.</b> {AD_VERDICTS[v].note}
          </div>

          <section>
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">1. The link that counts its bookings</h3>
            <p className="mt-1 text-slate-600 dark:text-slate-300">{where}</p>
            <div className="mt-2"><CopyBox text={c.channel === "google_search" || c.channel === "facebook" ? c.link.suffix : c.link.url} what="Link copied" /></div>
            {printed && qr && (
              <div className="mt-2 flex items-center gap-3">
                <img src={qr} alt={`QR code for ${c.name}`} className="h-28 w-28 rounded border border-slate-200 bg-white p-1 dark:border-slate-700" />
                <a href={qr} download={`qr-${c.code}.png`} className="inline-flex items-center gap-1.5 text-blue-700 hover:underline dark:text-blue-300"><Download size={14} /> Download the QR code</a>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">Anyone who books on the website after arriving through this link is counted under this campaign, by itself. The code is <code>{c.code}</code>.</p>
          </section>

          <section>
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">2. Its own phone number {c.trackingPhone ? "" : "(not set)"}</h3>
            {c.trackingPhone
              ? <p className="mt-1 text-slate-600 dark:text-slate-300">Calls to <b>{formatPhone(c.trackingPhone)}</b> are counted as this campaign&apos;s leads. A call nobody picks up becomes a &ldquo;call back&rdquo; task for the front desk within a couple of minutes.</p>
              : <p className="mt-1 text-slate-600 dark:text-slate-300">Many people call instead of booking online. To count them: add a phone number in RingCentral, send it to this clinic&apos;s front desk, use it only in this ad, and enter it here (Change). Until then only website bookings are counted.</p>}
          </section>

          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">3. What it cost</h3>
              <Btn size="sm" variant="secondary" onClick={onSpend}><Plus size={12} /> Add spend</Btn>
            </div>
            {c.pace && (
              <p className={cn("mt-1", c.pace.pace === "over" ? "text-amber-700 dark:text-amber-300" : "text-slate-600 dark:text-slate-300")}>
                This month: {money(c.spentThisMonthCents)} of a {money(c.monthlyBudgetCents)} budget ({c.pace.pace === "over" ? "ahead of" : c.pace.pace === "under" ? "behind" : "on"} pace; {money(c.pace.expectedCents)} would be even).
              </p>
            )}
            {spend.data?.length ? (
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-1 text-left font-medium">Month</th><th className="py-1 text-right font-medium">Spent</th><th className="py-1 text-right font-medium">Clicks</th><th className="py-1 text-right font-medium">Per click</th></tr></thead>
                <tbody>{spend.data.map((m) => (
                  <tr key={m.month} className="border-t border-slate-100 dark:border-slate-700/60"><td className="py-1">{monthLabel(m.month)}</td><td className="py-1 text-right tabular-nums">{money(m.costCents)}</td><td className="py-1 text-right tabular-nums">{m.clicks.toLocaleString()}</td><td className="py-1 text-right tabular-nums">{m.clicks ? money(Math.round(m.costCents / m.clicks)) : "–"}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="mt-1 text-slate-500">{spend.isLoading ? "Loading…" : c.paid ? "No spend entered yet." : "Nothing is spent on this one."}</p>}
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-700/60">
            <Btn variant="danger" size="sm" disabled={remove.isPending} onClick={() => { if (window.confirm(`Remove "${c.name}"? If it has leads or spend it is ended instead, and its numbers stay.`)) remove.mutate({ id: c.id }); }}><Trash2 size={13} /> Remove</Btn>
            <div className="flex gap-2">
              <Btn variant="secondary" size="sm" onClick={onLeads}><Users size={13} /> Its leads{row ? ` (${row.leads})` : ""}</Btn>
              <Btn size="sm" onClick={onEdit}><Pencil size={13} /> Change</Btn>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One amount for a stretch of days (a month's bill, a flyer run). */
export function SpendDialog({ campaigns, campaignId, today, onClose }: { campaigns: Campaign[]; campaignId: number | null; today: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const monthStart = `${today.slice(0, 7)}-01`;
  const [id, setId] = useState(String(campaignId ?? campaigns[0]?.id ?? ""));
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [amount, setAmount] = useState("");
  const [clicks, setClicks] = useState("");
  const save = trpc.masterBilling.adsSaveSpend.useMutation({
    onSuccess: (r) => { toast.success(`Saved across ${r.days} day${r.days === 1 ? "" : "s"}.`); void utils.masterBilling.adsReport.invalidate(); void utils.masterBilling.adsCampaignSpend.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const cents = dollars(amount);
  const valid = !!id && Number.isFinite(cents) && cents >= 0 && amount.trim() !== "" && from <= to;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add ad spend</DialogTitle>
          <DialogDescription>What a campaign cost over some days. It is spread evenly across them, and replaces anything already entered for those days. For Google or Facebook, uploading their report is faster and has the clicks.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate({ campaignId: Number(id), from, to, costCents: cents, clicks: clicks.trim() ? Math.max(0, Math.round(Number(clicks))) : null }); }}>
          <label className={label}><span className={labelText}>Campaign</span>
            <select aria-label="Campaign" className={cn(inputCls, "mt-1")} value={id} onChange={(e) => setId(e.target.value)}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}><span className={labelText}>First day</span><input type="date" className={cn(inputCls, "mt-1")} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className={label}><span className={labelText}>Last day</span><input type="date" className={cn(inputCls, "mt-1")} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            <label className={label}><span className={labelText}>Amount</span><input className={cn(inputCls, "mt-1")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 650.00" autoFocus /></label>
            <label className={label}><span className={labelText}>Clicks (optional)</span><input className={cn(inputCls, "mt-1")} inputMode="numeric" value={clicks} onChange={(e) => setClicks(e.target.value)} /></label>
          </div>
          <div className="flex justify-end gap-2"><Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn><Btn type="submit" disabled={!valid || save.isPending}>Save</Btn></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A spend report downloaded from Google Ads or Facebook Ads: read here, matched to our campaigns, saved by day. */
export function SpendUpload({ campaigns, today, onClose }: { campaigns: Campaign[]; today: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const send = trpc.masterBilling.adsImportSpend.useMutation();
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => (file ? parseSpendFile(file.rows) : null), [file]);
  const names = useMemo(() => Array.from(new Set((parsed?.rows ?? []).map((r) => r.campaignName))), [parsed]);
  const campaignFor = (n: string) => (n in picks ? picks[n]! : String(matchSpendCampaign(n, campaigns)?.id ?? ""));
  const totals = (n: string) => (parsed?.rows ?? []).filter((r) => r.campaignName === n).reduce((s, r) => ({ cents: s.cents + r.costCents, clicks: s.clicks + r.clicks }), { cents: 0, clicks: 0 });
  const pick = async (f: File | undefined) => {
    setError(null); setFile(null); setPicks({});
    if (!f) return;
    const r = await readTableFile(f);
    if ("error" in r) setError(r.error); else setFile(r);
  };
  const matched = names.filter((n) => campaignFor(n));
  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      const rows: { campaignId: number; day: string; costCents: number; clicks: number; impressions: number }[] = [];
      for (const r of parsed.rows) {
        const id = Number(campaignFor(r.campaignName));
        if (!id) continue;
        if (r.day) rows.push({ campaignId: id, day: r.day, costCents: r.costCents, clicks: r.clicks, impressions: r.impressions });
        else {
          // No day on the row: the same amount each day of the dates chosen.
          const days = spreadSpend(from, to, r.costCents), cl = spreadSpend(from, to, r.clicks), im = spreadSpend(from, to, r.impressions);
          days.forEach((x, i) => rows.push({ campaignId: id, day: x.day, costCents: x.costCents, clicks: cl[i]?.costCents ?? 0, impressions: im[i]?.costCents ?? 0 }));
        }
      }
      let saved = 0, total = 0;
      for (let i = 0; i < rows.length; i += 2000) { const r = await send.mutateAsync({ fileName: file!.name, rows: rows.slice(i, i + 2000) }); saved += r.saved; total += r.totalCents; }
      toast.success(`Saved ${money(total)} across ${saved} campaign-day${saved === 1 ? "" : "s"}.`);
      void utils.masterBilling.adsReport.invalidate(); void utils.masterBilling.adsCampaignSpend.invalidate();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload a spend report</DialogTitle>
          <DialogDescription>
            In Google Ads: Campaigns → pick the dates → Columns: add <b>Day</b> under Segment → Download → .csv. In Facebook Ads Manager: Campaigns → Breakdown: By day → Export. Uploading the same days again replaces them, so nothing is counted twice.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <input type="file" accept=".csv,.xlsx" aria-label="Spend report file" onChange={(e) => void pick(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-slate-700 dark:file:text-slate-100" />
          {error && <p className="text-rose-700 dark:text-rose-300">{error}</p>}
          {parsed?.problem && <p className="text-rose-700 dark:text-rose-300">{parsed.problem}</p>}
          {parsed && !parsed.problem && (
            <>
              <p className="text-slate-600 dark:text-slate-300">{parsed.rows.length.toLocaleString()} rows read{parsed.skipped ? ` (${parsed.skipped} skipped: no amount or no day)` : ""}. Check each campaign in the file is matched to yours:</p>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-1 text-left font-medium">In the file</th><th className="py-1 text-right font-medium">Spent</th><th className="py-1 text-right font-medium">Clicks</th><th className="py-1 pl-3 text-left font-medium">Your campaign</th></tr></thead>
                <tbody>{names.map((n) => (
                  <tr key={n} className="border-t border-slate-100 dark:border-slate-700/60">
                    <td className="py-1.5 pr-2">{n}</td><td className="py-1.5 text-right tabular-nums">{money(totals(n).cents)}</td><td className="py-1.5 text-right tabular-nums">{totals(n).clicks.toLocaleString()}</td>
                    <td className="py-1.5 pl-3">
                      <select aria-label={`Campaign for ${n}`} value={campaignFor(n)} onChange={(e) => setPicks((p) => ({ ...p, [n]: e.target.value }))} className={cn(inputCls, "py-1", !campaignFor(n) && "border-amber-400")}>
                        <option value="">Leave it out</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
              {!parsed.hasDays && (
                <div className="rounded-lg bg-amber-50 p-2.5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  This file has no day on each row, so say which days it covers (the amounts are spread evenly):
                  <span className="mt-2 flex items-center gap-2"><input type="date" aria-label="First day" className={cn(inputCls, "w-auto")} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /> to <input type="date" aria-label="Last day" className={cn(inputCls, "w-auto")} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-end gap-2"><Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn><Btn type="button" disabled={!parsed || !!parsed.problem || !matched.length || saving} onClick={() => void save()}>{saving ? "Saving…" : `Save ${matched.length} campaign${matched.length === 1 ? "" : "s"}`}</Btn></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A lead typed in: someone who said where they heard about the clinic. */
export function LeadDialog({ campaigns, today, onClose }: { campaigns: Campaign[]; today: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [id, setId] = useState(String(campaigns[0]?.id ?? ""));
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const save = trpc.masterBilling.adsAddLead.useMutation({
    onSuccess: () => { toast.success("Added."); void utils.masterBilling.adsReport.invalidate(); void utils.masterBilling.adsLeads.invalidate(); onClose(); }, onError: (e) => toast.error(e.message),
  });
  const valid = !!id && (!!name.trim() || phone.replace(/\D/g, "").length >= 10);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a lead by hand</DialogTitle>
          <DialogDescription>For someone who told you which ad they saw (a flyer, a mailer, a Facebook post). With their phone number, MyPCP finds them once they are a patient and follows their visits.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate({ campaignId: Number(id), name: name.trim(), phone: phone.trim() || null, day, note: note.trim() || null }); }}>
          <label className={label}><span className={labelText}>Campaign</span>
            <select aria-label="Campaign" className={cn(inputCls, "mt-1")} value={id} onChange={(e) => setId(e.target.value)}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}><span className={labelText}>Name</span><input className={cn(inputCls, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></label>
            <label className={label}><span className={labelText}>Phone</span><input className={cn(inputCls, "mt-1")} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
            <label className={label}><span className={labelText}>Day they got in touch</span><input type="date" className={cn(inputCls, "mt-1")} value={day} max={today} onChange={(e) => setDay(e.target.value)} /></label>
            <label className={label}><span className={labelText}>Note (optional)</span><input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} /></label>
          </div>
          <div className="flex justify-end gap-2"><Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn><Btn type="submit" disabled={!valid || save.isPending}>Add</Btn></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
