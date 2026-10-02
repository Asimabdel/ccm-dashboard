import { useState } from "react";
import { inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";

/** A list edited as text: one item per line. */
export function LinesField({ label, value, onChange, rows = 4 }: { label: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{label} <span className="font-normal text-slate-400">(one per line)</span></span>
      <textarea value={text} rows={Math.max(rows, value.length + 1)} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)); }} className={cn(inputCls, "h-auto py-2 leading-relaxed")} />
    </label>
  );
}

export function TextField({ label, value, onChange, rows = 2, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {rows === 1
        ? <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputCls} />
        : <textarea value={value} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, "h-auto py-2 leading-relaxed")} />}
    </label>
  );
}

export const Bullets = ({ items }: { items: string[] }) => <ul className="list-disc space-y-1 ps-5 text-sm text-slate-700 dark:text-slate-200">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
