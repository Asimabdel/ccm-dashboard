// Phones and tablets: a box on the page is too small to type in, so filling one opens this big input.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";
import type { DocField } from "@shared/documents";

export function FillDialog({ field, onClose, onSave }: { field: DocField | null; onClose: () => void; onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { setValue(field?.value ?? ""); }, [field?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!field) return null;
  const isDate = field.type === "date";
  const title = field.label || (isDate ? "Date" : "Type your answer");
  const done = () => { onSave(value); onClose(); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{field.required ? "This one is needed." : "This one is optional."} It goes in the highlighted box on page {field.page + 1}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); done(); }} className="space-y-3">
          {isDate ? <input type="date" autoFocus className={cn(inputCls, "h-12 text-base")} value={value} onChange={(e) => setValue(e.target.value)} />
            : field.h > 30 ? <textarea autoFocus rows={4} className={cn(inputCls, "text-base")} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
            : <input type="text" autoFocus className={cn(inputCls, "h-12 text-base")} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />}
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn type="submit">Done</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
