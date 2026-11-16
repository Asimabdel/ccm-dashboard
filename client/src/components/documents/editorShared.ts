// Small things the Documents editor's parts share.
import { useEffect, useState } from "react";
import type { RouterOutputs } from "@/lib/trpc";
import type { FieldType } from "@shared/documents";

export type Doc = RouterOutputs["workspace"]["documents"]["get"];
export type SigMap = Record<string, { png: string; name: string | null }>;

/** The tool that is "in hand": the next click on a page adds one of these. */
/** "edittext" is not a box of its own: it picks up printed words and swaps them for white-out + a text box. */
export interface ToolChoice { type: FieldType | "edittext"; value?: string }

// One color per person filling boxes: you (teal), then each signer.
export const PALETTE = [
  { border: "border-teal-600", bg: "bg-teal-500/10", text: "text-teal-800", dot: "bg-teal-600" },
  { border: "border-violet-600", bg: "bg-violet-500/10", text: "text-violet-800", dot: "bg-violet-600" },
  { border: "border-amber-600", bg: "bg-amber-500/10", text: "text-amber-800", dot: "bg-amber-600" },
  { border: "border-sky-600", bg: "bg-sky-500/10", text: "text-sky-800", dot: "bg-sky-600" },
  { border: "border-rose-600", bg: "bg-rose-500/10", text: "text-rose-800", dot: "bg-rose-600" },
];
export type BoxColor = (typeof PALETTE)[number];

/** Ink on the (always white) PDF page, whatever the app's theme. */
export const INK = "#0f172a";

/** Phones and tablets: boxes on the page are too small to type in, so filling one opens a big input instead. */
export function useTouchScreen() {
  const query = "(max-width: 640px), (pointer: coarse)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return on;
}
