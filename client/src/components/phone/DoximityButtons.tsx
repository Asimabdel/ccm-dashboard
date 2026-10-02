import { toast } from "sonner";
import { Phone, Video } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { DOXIMITY_WEB_DIALER, doximityAppLink, type DoximityCall } from "@shared/doximity";
import { formatPhone, normalizePhone } from "@shared/phone";
import { cn } from "@/lib/utils";

const onPhone = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/**
 * "Call" / "Video" through the provider's own Doximity Dialer (the patient sees the office number).
 * Providers only. On a phone it opens the Doximity app with the number; on a computer it copies the
 * number and opens Doximity's web Dialer.
 */
export function DoximityButtons({ phone, kinds = ["voice", "video"], className }: { phone: string | null | undefined; kinds?: DoximityCall[]; className?: string }) {
  const { user } = useAuth();
  if (user?.role !== "provider") return null;
  const digits = normalizePhone(phone);
  if (!digits || digits.length !== 10) return null;

  const desktop = async (kind: DoximityCall) => {
    try { await navigator.clipboard.writeText(digits); } catch { /* clipboard blocked: the toast shows the number */ }
    window.open(DOXIMITY_WEB_DIALER, "_blank", "noopener");
    toast.message(`Number copied: ${formatPhone(digits)}`, { description: `Paste it in Doximity Dialer to start the ${kind === "video" ? "video visit" : "call"}.` });
  };

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {kinds.map((kind) => {
        const label = kind === "video" ? "Video visit (Doximity)" : "Call with Doximity";
        const Icon = kind === "video" ? Video : Phone;
        const cls = "inline-flex items-center gap-1 rounded-md border border-[#2e7bd8]/30 bg-[#2e7bd8]/10 px-1.5 py-0.5 text-[11px] font-semibold text-[#1f5fae] hover:bg-[#2e7bd8]/20 dark:text-[#8db8f0]";
        return onPhone()
          ? <a key={kind} href={doximityAppLink(digits, kind)!} className={cls} title={label} aria-label={label} onClick={(e) => e.stopPropagation()}><Icon size={11} /> {kind === "video" ? "Video" : "Doximity"}</a>
          : <button key={kind} type="button" className={cls} title={`${label}: copies the number and opens Doximity's Dialer`} aria-label={label} onClick={(e) => { e.stopPropagation(); void desktop(kind); }}><Icon size={11} /> {kind === "video" ? "Video" : "Doximity"}</button>;
      })}
    </span>
  );
}
