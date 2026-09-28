import { useEffect } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { ErrorNote, PageHeader } from "@/components/workspace/ui";
import { PatientChartPanel } from "@/components/chart/PatientChartPanel";
import { ChartLookup } from "@/components/chart/ChartLookup";
import { trpc } from "@/lib/trpc";
import { fmtDay } from "@shared/workforce";

/** The chart for anyone who isn't on the CCM roster (schedule-only or Practice Fusion-only). */
export default function ChartPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const { key: raw } = useParams<{ key: string }>();
  const key = decodeURIComponent(raw ?? "");
  const [, setLocation] = useLocation();
  const ws = useWorkspace();
  useEffect(() => { if (/^p:\d+$/.test(key)) setLocation(`/patients/${key.slice(2)}?tab=chart`, { replace: true }); }, [key, setLocation]);
  const header = trpc.workspace.chart.header.useQuery(key, { enabled: /^(s:|f:)/.test(key) && !!ws.caps?.chartBasic, retry: false });
  const h = header.data;

  return (
    <CCMDashboardLayout title={h?.name ? `${h.name} — Chart` : "Chart"} pageTitle={false}>
      <Link href="/patients" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4"><ArrowLeft size={15} /> Patients</Link>
      <PageHeader
        title={h?.name ?? "Patient chart"}
        subtitle={h?.dob ? `DOB ${fmtDay(h.dob, { month: "short", day: "numeric", year: "numeric" })} · not on the care-management roster` : undefined}
        actions={<ChartLookup className="w-80" />}
      />
      {ws.caps && !ws.caps.chartBasic ? <ErrorNote message="You don't have access to patient charts." /> : /^(s:|f:)/.test(key) ? <PatientChartPanel subjectKey={key} /> : null}
    </CCMDashboardLayout>
  );
}
