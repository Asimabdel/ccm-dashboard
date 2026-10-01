import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  CalendarDays, ClipboardList, ClipboardSignature, Database, Download, FileSignature, FileText, FileUp, FlaskConical, FolderOpen, HeartPulse, Image as ImageIcon,
  Loader2, Mail, Phone, Printer, Search, ShieldCheck, StickyNote, Trash2, Wallet, X,
} from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, Panel, inputCls } from "@/components/workspace/ui";
import { PatientChartPanel } from "@/components/chart/PatientChartPanel";
import { PatientFormsPanel } from "@/components/intake/PatientFormsPanel";
import { PatientPaymentsPanel } from "@/components/payments/PatientPaymentsPanel";
import { PaymentDrawer } from "@/components/payments/PaymentDrawer";
import { InsurancePanel } from "@/components/insurance/InsurancePanel";
import { TaskDrawer } from "@/components/workspace/TaskDrawer";
import { FileViewer, type ViewerFile } from "./FileViewer";
import { UploadFileDialog } from "./UploadFileDialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { FOLDER_SECTIONS, type FolderItem, type FolderSection } from "@shared/folder";

type View = FolderSection | "everything";

const SECTION_ICON: Record<FolderSection, React.ElementType> = {
  chart: Database, visits: CalendarDays, tasks: ClipboardList, comms: Mail, forms: ClipboardSignature, files: FileText,
  faxes: Printer, payments: Wallet, care: HeartPulse, insurance: ShieldCheck,
};
const KIND_ICON: Record<string, React.ElementType> = {
  visit: CalendarDays, task: ClipboardList, call: Phone, email: Mail, fax: Printer, form: ClipboardSignature, document: FileSignature,
  file: FileText, payment: Wallet, eligibility: ShieldCheck, note: StickyNote, report: FlaskConical, chart: Database,
};
const when = (d: string | null) => {
  if (!d) return "";
  const date = new Date(d.length === 10 ? `${d}T12:00:00Z` : d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: d.length === 10 ? "UTC" : "America/Chicago" });
};
const PROGRAM_LABEL: Record<string, string> = { ccm: "CCM", bhi: "BHI", apcm: "APCM", rpm: "RPM" };

/**
 * A patient's folder: everything MyPCP has about them, by sub-folder, plus an Everything view,
 * search, files staff add, and (admins) the whole folder as one PDF.
 */
export function PatientFolder({ subjectKey, initialSection }: { subjectKey: string; initialSection?: View | null }) {
  const [, setLocation] = useLocation();
  const summary = trpc.workspace.folder.summary.useQuery({ key: subjectKey }, { retry: false });
  const s = summary.data;
  const [view, setView] = useState<View>(initialSection ?? "everything");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 400); return () => clearTimeout(t); }, [q]);
  const listView = view !== "chart" && view !== "care" && view !== "insurance" && view !== "forms" && view !== "payments";
  const items = trpc.workspace.folder.items.useQuery({ key: subjectKey, section: view }, { enabled: !!s && listView && term.length < 2 });
  const search = trpc.workspace.folder.search.useQuery({ key: subjectKey, q: term }, { enabled: !!s && term.length >= 2 });
  const [taskId, setTaskId] = useState<number | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewerFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();
  const onError = (e: { message: string }) => toast.error(e.message);
  const openFile = trpc.workspace.folder.openFile.useMutation({ onError });
  const openFax = trpc.workspace.folder.openFax.useMutation({ onError });
  const openDocument = trpc.workspace.folder.openDocument.useMutation({ onError });
  const openNote = trpc.workspace.chart.note.useMutation({ onError });
  const removeFile = trpc.workspace.folder.removeFile.useMutation({ onSuccess: () => { void utils.workspace.folder.invalidate(); toast.success("Removed from the folder."); }, onError });
  const exporter = trpc.workspace.folder.export.useMutation({
    onSuccess: (r) => {
      const a = document.createElement("a");
      a.href = r.url ?? URL.createObjectURL(new Blob([Uint8Array.from(atob(r.base64 ?? ""), (c) => c.charCodeAt(0))], { type: "application/pdf" }));
      a.download = r.name;
      a.click();
      toast.success(`Folder downloaded (${r.pages} pages)${r.skipped ? `. ${r.skipped} item${r.skipped === 1 ? " is" : "s are"} listed at the end but weren't added (open them in MyPCP).` : "."}`, { duration: 8000 });
    },
    onError,
  });

  useEffect(() => { if (s && view !== "everything" && !s.sections.includes(view)) setView("everything"); }, [s, view]);

  const open = async (it: FolderItem) => {
    const o = it.open;
    try {
      if (o.type === "task") setTaskId(o.id);
      else if (o.type === "payment") setPaymentId(o.id);
      else if (o.type === "form") setLocation(`/intake-forms/${o.id}/print`);
      else if (o.type === "link") window.open(o.url, "_blank", "noopener");
      else if (o.type === "file") { const r = await openFile.mutateAsync({ id: o.id }); setViewing({ title: r.title, mimeType: r.mimeType, url: r.url, base64: r.base64 }); }
      else if (o.type === "fax") { const r = await openFax.mutateAsync({ key: subjectKey, id: o.id }); setViewing({ title: it.title, mimeType: r.mimeType, base64: r.base64 }); }
      else if (o.type === "document") {
        if (!o.ready) { setLocation(`/documents/${o.id}`); return; }
        const r = await openDocument.mutateAsync({ key: subjectKey, id: o.id });
        setViewing({ title: r.title, mimeType: "application/pdf", url: r.url, base64: r.base64 });
      } else if (o.type === "note") {
        const r = await openNote.mutateAsync(o.id);
        if (r.text != null) {
          const isHtml = /html|xml/i.test(r.contentType);
          setViewing({ title: r.title ?? it.title, mimeType: r.contentType, ...(isHtml ? { text: r.text } : { plain: r.text }) });
        } else setViewing({ title: r.title ?? it.title, mimeType: r.contentType, base64: r.base64 });
      }
    } catch { /* shown by onError */ }
  };
  const opening = openFile.isPending || openFax.isPending || openDocument.isPending || openNote.isPending;

  if (summary.isLoading) return <Loading />;
  if (summary.error) return <ErrorNote message={summary.error.message} />;
  if (!s) return null;

  const nav: { key: View; label: string; icon: React.ElementType; count?: number }[] = [
    { key: "everything", label: "Everything", icon: FolderOpen },
    ...s.sections.map((k) => ({ key: k as View, label: FOLDER_SECTIONS[k], icon: SECTION_ICON[k], count: s.counts[k] })),
  ];
  const results = term.length >= 2 ? search.data : items.data;
  const loadingList = term.length >= 2 ? search.isFetching && !search.data : items.isLoading;

  return (
    <div className="space-y-4">
      {/* Search + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={cn(inputCls, "pl-9 pr-8")} placeholder={`Search ${s.name}'s folder: notes, forms, faxes, files, the chart…`} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700" onClick={() => setQ("")} aria-label="Clear search"><X size={14} /></button>}
        </div>
        {s.canUpload && <Btn variant="secondary" onClick={() => setUploading(true)}><FileUp size={15} /> Add a file</Btn>}
        {s.canExport && (
          <Btn variant="secondary" disabled={exporter.isPending} onClick={() => exporter.mutate({ key: subjectKey })} title="One PDF with everything in this folder (e.g. for a records request)">
            {exporter.isPending ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {exporter.isPending ? "Building the PDF…" : "Download folder"}
          </Btn>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        {/* Sub-folders */}
        <nav aria-label="Sub-folders" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {nav.map((n) => (
            <button key={n.key} onClick={() => { setView(n.key); setQ(""); }}
              className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap",
                view === n.key && term.length < 2 ? "bg-slate-900 font-semibold text-white dark:bg-brand" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
              <n.icon size={15} className="shrink-0" />
              <span className="flex-1">{n.label}</span>
              {n.count != null && <span className={cn("text-xs tabular-nums", view === n.key && term.length < 2 ? "text-white/80" : "text-slate-400")}>{n.count}</span>}
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          {term.length >= 2 || listView ? (
            <Panel bodyClassName="p-0"
              title={term.length >= 2 ? `Search: "${term}"` : view === "everything" ? "Everything, newest first" : FOLDER_SECTIONS[view as FolderSection]}
              action={opening ? <Loader2 size={15} className="animate-spin text-slate-400" /> : view === "files" && s.canUpload && term.length < 2 ? <Btn size="sm" onClick={() => setUploading(true)}><FileUp size={13} /> Add a file</Btn> : undefined}>
              {loadingList ? <Loading /> : (search.error && term.length >= 2) ? <div className="p-4"><ErrorNote message={search.error.message} /></div> : !results?.length ? (
                <EmptyState icon={term.length >= 2 ? Search : FolderOpen} title={term.length >= 2 ? "Nothing matches" : "Nothing here yet"}
                  body={term.length >= 2 ? "Try another word." : view === "files" ? "Signed documents and files added to this folder show here." : undefined} />
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                  {results.map((it) => {
                    const Icon = KIND_ICON[it.kind] ?? (it.kind === "file" ? ImageIcon : FileText);
                    const clickable = it.open.type !== "none";
                    const Row = clickable ? "button" : "div";
                    return (
                      <li key={it.key} className="flex items-start gap-1">
                        <Row onClick={clickable ? () => void open(it) : undefined}
                          className={cn("flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left", clickable && "hover:bg-slate-50 dark:hover:bg-slate-800/60")}>
                          <Icon size={16} className="mt-0.5 shrink-0 text-slate-400" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{it.title}</p>
                            {it.snippet ? <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{it.snippet}</p>
                              : it.detail ? <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{it.detail}</p> : null}
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {when(it.date)}{it.status ? ` · ${it.status}` : ""}{(view === "everything" || term.length >= 2) ? ` · ${FOLDER_SECTIONS[it.section]}` : ""}
                            </p>
                          </div>
                        </Row>
                        {it.open.type === "file" && s.canRemoveFiles && (
                          <button className="mr-2 mt-3 rounded p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-600" title="Remove from the folder (kept for the record)"
                            onClick={() => { if (window.confirm(`Remove "${it.title}" from this folder? It's kept for the record but won't show here.`)) removeFile.mutate({ id: (it.open as { id: number }).id }); }}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          ) : view === "chart" ? (
            <PatientChartPanel subjectKey={subjectKey} />
          ) : view === "forms" ? (
            <PatientFormsPanel subjectKey={subjectKey} />
          ) : view === "payments" ? (
            <PatientPaymentsPanel subjectKey={subjectKey} name={s.name} clinicId={s.clinicId} />
          ) : view === "insurance" ? (
            <InsurancePanel subjectKey={subjectKey} />
          ) : view === "care" ? (
            <Panel title="Care programs">
              {!s.programs ? (
                <p className="text-sm text-slate-500">Not on the care-management roster, so not in CCM, BHI, APCM or RPM.</p>
              ) : (
                <div className="space-y-3">
                  <dl className="grid gap-3 sm:grid-cols-2">
                    {(["ccm", "bhi", "apcm", "rpm"] as const).map((k) => {
                      const status = s.programs![k];
                      const consent = s.programs![`${k}Consent` as const];
                      return (
                        <div key={k} className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800">
                          <dt className="text-xs font-semibold text-slate-500">{PROGRAM_LABEL[k]}</dt>
                          <dd className="mt-0.5 text-sm font-semibold capitalize text-slate-800 dark:text-slate-100">{status ? String(status).replace(/_/g, " ") : "Not enrolled"}{k === "apcm" && s.programs!.apcmLevel ? ` · level ${s.programs!.apcmLevel}` : ""}</dd>
                          <dd className="text-xs text-slate-500">Consent: {consent ? String(consent).replace(/_/g, " ") : "none on file"}</dd>
                        </div>
                      );
                    })}
                  </dl>
                  {s.patientId && <Link href={`/patients/${s.patientId}?tab=care`} className="inline-block text-sm font-semibold text-brand hover:underline">Open the care-management record</Link>}
                </div>
              )}
            </Panel>
          ) : null}
        </div>
      </div>

      <UploadFileDialog open={uploading} subjectKey={subjectKey} name={s.name} onClose={() => setUploading(false)} />
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
      <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />
      <PaymentDrawer id={paymentId} onClose={() => setPaymentId(null)} />
    </div>
  );
}
