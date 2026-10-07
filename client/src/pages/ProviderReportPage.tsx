import { useMemo, useState } from "react";
import { BarChart3, Download, Info } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { fmtDay, localDateStr } from "@shared/workforce";
import { WORKED_DAY_MIN, dayKind, presetRange, type RangePreset } from "@shared/providerReport";

// Okabe–Ito order (color-blind safe), assigned to providers in the table's order and never cycled. Dark mode uses
// lighter steps of the same hues so the lines stay visible on the dark surface.
const LINE_COLORS = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#D55E00", "#56B4E9", "#B8A200", "#64748B"];
const LINE_COLORS_DARK = ["#4FA3E0", "#F2B33D", "#2BC49A", "#E39AC2", "#F07A3A", "#8CCFF3", "#F0E442", "#CBD5E1"];
const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "4w", label: "Last 4 weeks" }, { key: "3m", label: "Last 3 months" }, { key: "6m", label: "Last 6 months" }, { key: "ytd", label: "This year" },
];
const n = (x: number | null) => (x == null ? "—" : x.toLocaleString(undefined, { maximumFractionDigits: 1 }));
const short = (d: string) => fmtDay(d, { month: "short", day: "numeric" });

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Provider report: each provider's patients seen as daily / weekly / monthly averages over a range, days worked,
 * light days (1–2 patients, most likely off), no-shows and cancellations, and new patients (with CCM / RPM).
 */
export default function ProviderReportPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const { theme } = useTheme();
  const colors = theme === "dark" ? LINE_COLORS_DARK : LINE_COLORS;
  const today = localDateStr();
  const [preset, setPreset] = useState<RangePreset | "custom">("3m");
  const [range, setRange] = useState(presetRange("3m", today));
  const q = trpc.workspace.providerReport.get.useQuery({ ...range, clinicId: ws.clinicId }, { enabled: !!user && !!ws.caps?.dailyReports && range.from <= range.to });
  const rows = q.data?.providers ?? [];
  const pending = rows.reduce((s, r) => s + r.summary.pendingDays, 0);

  const trend = useMemo(() => {
    const weeks = Array.from(new Set(rows.flatMap((r) => r.summary.weekly.map((w) => w.week)))).sort();
    return weeks.map((week) => Object.fromEntries([["week", short(week)], ...rows.map((r) => [r.provider, r.summary.weekly.find((w) => w.week === week)?.seen ?? 0])]));
  }, [rows]);

  const csv = () => downloadCsv(`provider-report-${range.from}-to-${range.to}.csv`, [
    ["Provider", "Days worked", "Patients per day", "Patients per week", "Patients per month", "Days per week", "Patients seen (total)", "No-shows", "No-show rate %", "Cancellations", "Cancellation rate %", "New patients", "New per week", "New per month", "New who qualify for CCM", "New who qualify for RPM", "Light days (1-2 patients)"],
    ...rows.map((r) => { const s = r.summary; return [r.provider, s.daysWorked, s.dailyAvg, s.weeklyAvg, s.monthlyAvg, s.daysPerWeek, s.totalSeen, s.noShows, s.noShowRate, s.cancellations, s.cancelRate, s.newPatients, s.newPerWeek, s.newPerMonth, s.newCcm, s.newRpm, s.lightDays.map((l) => `${l.date} (${l.seen})`).join("; ")]; }),
  ]);

  const th = "px-3 py-2.5 text-right font-medium";
  return (
    <CCMDashboardLayout title="Provider report" clinicPicker pageTitle={false}>
      <PageHeader title="Provider report" subtitle="Patients seen per day, week and month, days worked, no-shows and new patients."
        actions={rows.length > 0 ? <Btn variant="secondary" onClick={csv}><Download size={15} /> Download CSV</Btn> : undefined} />
      {ws.caps && !ws.caps.dailyReports && <ErrorNote message="The provider report is for admins and office managers." />}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <Btn key={p.key} size="sm" variant={preset === p.key ? "primary" : "secondary"} onClick={() => { setPreset(p.key); setRange(presetRange(p.key, today)); }}>{p.label}</Btn>
        ))}
        <input type="date" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, from: e.target.value })); } }}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="From" />
        <span className="text-sm text-slate-400">to</span>
        <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, to: e.target.value })); } }}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="To" />
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && pending > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>{pending} provider-day{pending === 1 ? "" : "s"} in this range {pending === 1 ? "isn't" : "aren't"} counted yet: today, or days whose visits are still "scheduled" because the schedule
            {q.data.statusesImported ? <> was last imported {new Date(q.data.statusesImported.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}</> : " hasn't been imported"}.
            Import the schedule again from Practice Fusion (with statuses) to count them.</span>
        </p>
      )}
      {q.data && rows.length === 0 && <Panel><EmptyState icon={BarChart3} title="No visits in this range" body="Nothing on the imported schedule was marked seen between these dates." /></Panel>}

      {rows.length > 0 && q.data && (
        <>
          <Panel title="Averages" subtitle={`${fmtDay(range.from, { month: "short", day: "numeric", year: "numeric" })} – ${fmtDay(range.to, { month: "short", day: "numeric", year: "numeric" })}`} bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Provider</th>
                    <th className={th}>Days worked</th><th className={th}>Per day</th><th className={th}>Per week</th><th className={th}>Per month</th>
                    <th className={th}>Days / week</th><th className={th}>Seen</th><th className={th}>No-shows</th><th className={th}>Cancelled</th>
                    <th className={th}>New patients</th><th className={th}>New / week</th><th className={th}>New → CCM · RPM</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const s = r.summary;
                    return (
                      <tr key={r.key} className="border-t border-slate-100 dark:border-slate-700/60">
                        <td className="px-4 py-2.5">
                          <p className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colors[i] ?? "#94a3b8" }} aria-hidden />{r.provider}</p>
                          {r.clinics.length > 0 && <p className="ml-[18px] text-xs text-slate-400">{r.clinics.join(", ")}</p>}
                        </td>
                        <td className={`${th} tabular-nums`}>{s.daysWorked}</td>
                        <td className={`${th} font-semibold tabular-nums text-slate-900 dark:text-white`}>{n(s.dailyAvg)}</td>
                        <td className={`${th} font-semibold tabular-nums text-slate-900 dark:text-white`}>{n(s.weeklyAvg)}</td>
                        <td className={`${th} font-semibold tabular-nums text-slate-900 dark:text-white`} title={s.monthsCounted.length ? `Complete months: ${s.monthsCounted.join(", ")}` : "No complete month in this range"}>{n(s.monthlyAvg)}</td>
                        <td className={`${th} tabular-nums`}>{n(s.daysPerWeek)}</td>
                        <td className={`${th} tabular-nums`}>{s.totalSeen.toLocaleString()}</td>
                        <td className={`${th} tabular-nums`}>{s.noShows}{s.noShowRate != null && <span className="ml-1 text-xs text-slate-400">({s.noShowRate}%)</span>}</td>
                        <td className={`${th} tabular-nums`}>{s.cancellations}{s.cancelRate != null && <span className="ml-1 text-xs text-slate-400">({s.cancelRate}%)</span>}</td>
                        <td className={`${th} tabular-nums`}>{s.newPatients}</td>
                        <td className={`${th} tabular-nums`}>{n(s.newPerWeek)}</td>
                        <td className={`${th} tabular-nums`}>{s.newCcm} · {s.newRpm}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-slate-200 bg-slate-50/60 text-slate-700 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-200">
                    <td className="px-4 py-2.5 font-semibold">Practice</td>
                    <td className={th} colSpan={5} />
                    <td className={`${th} font-semibold tabular-nums`}>{q.data.practice.seen.toLocaleString()}</td>
                    <td className={`${th} tabular-nums`}>{q.data.practice.noShows}{q.data.practice.noShowRate != null && <span className="ml-1 text-xs text-slate-400">({q.data.practice.noShowRate}%)</span>}</td>
                    <td className={`${th} tabular-nums`}>{q.data.practice.cancellations}</td>
                    <td className={`${th} tabular-nums`}>{q.data.practice.newPatients}</td>
                    <td className={th} />
                    <td className={`${th} tabular-nums`}>{q.data.practice.newCcm} · {q.data.practice.newRpm}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>

          {rows.some((r) => r.summary.lightDays.length) && (
            <Panel className="mt-4" title="Light days" subtitle={`Days with only 1–${WORKED_DAY_MIN - 1} patients seen: most likely off, so they're not counted as days worked (their patients still count in "Seen").`}>
              <ul className="space-y-1.5 text-sm">
                {rows.filter((r) => r.summary.lightDays.length).map((r) => (
                  <li key={r.key}><b className="text-slate-800 dark:text-slate-100">{r.provider}:</b>{" "}
                    <span className="text-slate-600 dark:text-slate-300">{r.summary.lightDays.map((l) => `${fmtDay(l.date)} (${l.seen})`).join(", ")}</span></li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="mt-4" title="Patients seen per week">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke="#94a3b8" strokeOpacity={0.2} vertical={false} />
                  <XAxis dataKey="week" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, fontSize: 12, background: theme === "dark" ? "#1e293b" : "#fff", borderColor: theme === "dark" ? "#334155" : "#e2e8f0", color: theme === "dark" ? "#e2e8f0" : "#0f172a" }} labelFormatter={(l) => `Week of ${l}`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-slate-600 dark:text-slate-300">{v}</span>} />
                  {rows.map((r, i) => <Line key={r.key} type="linear" dataKey={r.provider} stroke={colors[i] ?? "#94a3b8"} strokeWidth={2} dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel className="mt-4" title="Day by day" subtitle="To double-check any provider's numbers.">
            <div className="space-y-2">
              {rows.map((r) => (
                <details key={r.key} className="rounded-lg border border-slate-200 dark:border-slate-700">
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{r.provider} <span className="font-normal text-slate-400">· {r.days.length} days on the schedule</span></summary>
                  <div className="overflow-x-auto px-3 pb-3">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead className="text-slate-400"><tr><th className="py-1 text-left font-medium">Day</th><th className="py-1 text-right font-medium">Booked</th><th className="py-1 text-right font-medium">Seen</th><th className="py-1 text-right font-medium">No-shows</th><th className="py-1 text-right font-medium">Cancelled</th><th className="py-1 text-right font-medium">New</th><th className="py-1 pl-4 text-left font-medium">Counted as</th></tr></thead>
                      <tbody>
                        {r.days.map((d) => {
                          const k = dayKind(d, q.data!.today);
                          return (
                            <tr key={d.date} className="border-t border-slate-100 tabular-nums dark:border-slate-700/60">
                              <td className="py-1 text-slate-700 dark:text-slate-200">{fmtDay(d.date)}</td>
                              <td className="py-1 text-right">{d.booked}</td><td className="py-1 text-right font-semibold">{d.seen}</td><td className="py-1 text-right">{d.noShow}</td>
                              <td className="py-1 text-right">{d.cancelled}</td><td className="py-1 text-right">{d.newPatients}</td>
                              <td className={`py-1 pl-4 ${k === "worked" ? "text-emerald-700 dark:text-emerald-400" : k === "light" ? "text-amber-700 dark:text-amber-400" : "text-slate-400"}`}>
                                {k === "worked" ? "Day worked" : k === "light" ? "Light day (off)" : k === "pending" ? "Not counted yet" : "Off"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </div>
          </Panel>

          <p className="mt-5 flex items-start gap-2 text-xs text-slate-500">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span><b>Seen</b> = schedule visits marked arrived through checked out (same as the daily reports). A <b>day worked</b> has {WORKED_DAY_MIN}+ patients seen; days with 1–{WORKED_DAY_MIN - 1} are light days (most likely off). <b>Per day</b> = patients seen ÷ days worked; <b>per week</b> = ÷ weeks with a day worked; <b>per month</b> = ÷ complete calendar months in the range that they worked (hover for which). <b>No-show rate</b> = no-shows ÷ (seen + no-shows); <b>cancelled</b> % = of everything booked. <b>New patients</b> = first visit with the practice; <b>→ CCM · RPM</b> = of those, how many qualify by their diagnoses or signed that consent.</span>
          </p>
        </>
      )}
    </CCMDashboardLayout>
  );
}
