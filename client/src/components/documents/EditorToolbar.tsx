// The full-screen editor's tool bar: boxes to add, mark-up, stamps & logo, "Suggest boxes" / "Read with AI",
// and who new boxes are for. Pick a tool, then click (or drag) on the page.
import { useState } from "react";
import { Loader2, Sparkles, Stamp, Wand2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";
import type { Assignee } from "@shared/documents";
import { FILL_TOOLS, MARK_TOOLS, StampGallery, sameTool } from "./editorPanels";
import { PATIENT_OPTION, type Doc, type ToolChoice } from "./editorShared";

export function EditorToolbar({ tool, onTool, isTemplate, signers, newAssignee, onNewAssignee, onSuggest, onAiRead, suggesting, myName }: {
  tool: ToolChoice | null; onTool: (t: ToolChoice | null) => void; isTemplate: boolean; signers: Doc["signers"]; newAssignee: Assignee; onNewAssignee: (a: Assignee) => void;
  onSuggest: () => void; onAiRead?: () => void; suggesting: string | null; myName: string;
}) {
  const [stampsOpen, setStampsOpen] = useState(false);
  const stampOn = tool?.type === "stamp" || tool?.type === "logo";
  const btn = (on: boolean) => cn(
    "flex h-12 w-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10.5px] font-semibold transition-colors",
    on ? "bg-brand text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700",
  );
  const group = (label: string, children: React.ReactNode) => (
    <div className="flex shrink-0 flex-col">
      <div className="flex items-center gap-0.5">{children}</div>
      <span className="hidden text-center text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-400 xl:block">{label}</span>
    </div>
  );
  const sep = <span className="mx-1.5 h-10 w-px shrink-0 bg-slate-200 dark:bg-slate-700" />;
  const hint = tool?.type === "edittext" ? "Click the printed words you want to change, then retype them."
    : tool?.type === "stamp" || tool?.type === "logo" ? "Click on the page where it goes. Drag to set its size."
      : tool ? "Click on the page where it goes, or drag to set its size." : null;
  return (
    <div className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-1 [scrollbar-width:thin]">
        {group("Add a box", FILL_TOOLS.map((t) => (
          <button key={t.type} type="button" title={t.label} aria-pressed={sameTool(tool, t)} className={btn(sameTool(tool, t))} onClick={() => onTool(sameTool(tool, t) ? null : { type: t.type, value: t.value })}>
            <t.icon size={17} /> {t.label}
          </button>
        )))}
        {sep}
        {group("Mark up", MARK_TOOLS.map((t) => (
          <button key={`${t.type}:${t.value ?? ""}`} type="button" title={t.label} aria-pressed={sameTool(tool, t)} className={btn(sameTool(tool, t))} onClick={() => onTool(sameTool(tool, t) ? null : { type: t.type, value: t.value })}>
            <t.icon size={17} /> {t.label}
          </button>
        )))}
        {sep}
        {group("Stamps", (
          <Popover open={stampsOpen} onOpenChange={setStampsOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={btn(stampOn || stampsOpen)} aria-pressed={stampOn}><Stamp size={17} /> Stamps</button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-[70vh] w-80 overflow-y-auto p-3">
              <StampGallery tool={tool} myName={myName} onTool={(t) => { onTool(t); setStampsOpen(false); }} />
            </PopoverContent>
          </Popover>
        ))}
        {sep}
        {group("Find blanks", (
          <>
            <button type="button" className={btn(false)} disabled={!!suggesting} onClick={onSuggest} title="MyPCP reads the words on the pages (Name: ____, Signature: ____, Date: ____, [ ]) and adds a box on each blank. You check them.">
              {suggesting ? <Loader2 size={17} className="animate-spin" /> : <Wand2 size={17} />} Suggest
            </button>
            {onAiRead && (
              <button type="button" className={btn(false)} disabled={!!suggesting} onClick={onAiRead} title="The practice's AI looks at a picture of each page (scans and photos too), finds every blank and who fills it. You check its work.">
                <Sparkles size={17} /> AI read
              </button>
            )}
          </>
        ))}
        {!isTemplate && (
          <>
            {sep}
            <label className="flex shrink-0 flex-col text-[10.5px] font-semibold text-slate-500">New boxes are for
              <select className={cn(inputCls, "mt-0.5 h-8 w-40 py-0 text-xs")} value={newAssignee} onChange={(e) => onNewAssignee(e.target.value as Assignee)}>
                <option value="preparer">Me (I fill it now)</option>
                {signers.map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"} (signs later)</option>)}
                <option value="patient">{PATIENT_OPTION}</option>
              </select>
            </label>
          </>
        )}
      </div>
      {(hint || suggesting) && (
        <p className="flex items-center gap-2 border-t border-slate-100 bg-brand-soft/60 px-4 py-1 text-xs font-medium text-brand dark:border-slate-700 dark:text-teal-300" role="status">
          {suggesting ? <><Loader2 size={12} className="animate-spin" /> {suggesting}</> : <>{hint} <span className="text-slate-500">Esc to put it down.</span></>}
        </p>
      )}
    </div>
  );
}
