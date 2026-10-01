import { useEffect } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { ArrowLeft, Building2, CalendarDays, Phone, Stethoscope } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { PatientFolder } from "@/components/folder/PatientFolder";
import { ChartLookup } from "@/components/chart/ChartLookup";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { trpc } from "@/lib/trpc";
import { fmtDay } from "@shared/workforce";
import { FOLDER_SECTION_LIST, folderHref, type FolderSection } from "@shared/folder";

/** The folder for anyone who isn't on the CCM roster (schedule-only or Practice Fusion-only). Roster patients' folders live in Patient 360. */
export default function FolderPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const { key: raw } = useParams<{ key: string }>();
  const key = decodeURIComponent(raw ?? "");
  const section = new URLSearchParams(useSearch()).get("s");
  const initial = (FOLDER_SECTION_LIST as string[]).includes(section ?? "") ? (section as FolderSection) : null;
  const [, setLocation] = useLocation();
  useEffect(() => { if (/^p:\d+$/.test(key)) setLocation(folderHref(key, initial), { replace: true }); }, [key, initial, setLocation]);
  const q = trpc.workspace.folder.summary.useQuery({ key }, { enabled: /^(s:|f:)/.test(key), retry: false });
  const h = q.data;

  return (
    <CCMDashboardLayout title={h?.name ? `${h.name} · Folder` : "Patient folder"} pageTitle={false}>
      <Link href="/patients" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={15} /> Patients</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50 md:text-2xl">{h?.name ?? "Patient folder"}</h2>
          {h && (
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              {h.dob && <span className="inline-flex items-center gap-1"><CalendarDays size={13} /> DOB {fmtDay(h.dob, { month: "short", day: "numeric", year: "numeric" })}</span>}
              {h.phone && <PhoneLink phone={h.phone} context={{ patientId: null, name: h.name, source: "patient" }}><Phone size={13} /> {h.phone}</PhoneLink>}
              {h.clinicName && <span className="inline-flex items-center gap-1"><Building2 size={13} /> {h.clinicName}</span>}
              {h.providerName && <span className="inline-flex items-center gap-1"><Stethoscope size={13} /> {h.providerName}</span>}
            </div>
          )}
          {h && (
            <p className="mt-2 text-xs text-slate-500">
              {[h.sources.practiceFusion ? "In Practice Fusion" : null, h.sources.schedule ? "On the schedule" : null].filter(Boolean).join(" · ") || "Known to MyPCP"} · not on the care-management roster
            </p>
          )}
        </div>
        <ChartLookup className="w-72" />
      </div>
      {/^(s:|f:)/.test(key) && <PatientFolder subjectKey={key} initialSection={initial} />}
    </CCMDashboardLayout>
  );
}
