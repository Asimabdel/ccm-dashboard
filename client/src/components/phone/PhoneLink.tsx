import type React from "react";
import { Phone } from "lucide-react";
import { formatPhone, normalizePhone } from "@shared/phone";
import { cn } from "@/lib/utils";
import { rcDial, useRingCentral, type DialContext } from "./ringcentralStore";

/**
 * A phone number you can click to call. With RingCentral connected it dials through the
 * phone built into the app (and the call is logged against this patient); otherwise it's
 * a normal tel: link, which the RingCentral desktop app can also handle.
 */
export function PhoneLink({ phone, context, className, children, icon = false, title }: {
  phone: string | null | undefined;
  context?: DialContext;
  className?: string;
  children?: React.ReactNode;
  icon?: boolean;
  title?: string;
}) {
  const rc = useRingCentral();
  const digits = normalizePhone(phone);
  if (!phone) return null;
  if (!digits) return <span className={className}>{phone}</span>;
  return (
    <a
      href={`tel:+1${digits}`}
      title={title ?? (rc.loaded ? "Call with RingCentral" : "Call")}
      onClick={(e) => { e.stopPropagation(); if (rcDial(digits, context)) e.preventDefault(); }}
      className={cn("inline-flex items-center gap-1 hover:underline", className)}
    >
      {icon && <Phone size={12} className="shrink-0" />}
      {children ?? formatPhone(phone)}
    </a>
  );
}
