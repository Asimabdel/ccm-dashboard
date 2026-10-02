// Sending faxes from MyPCP (the practice's choices, 2026-10-02): through RingCentral (BAA in place),
// from each clinic's own fax number. Attach a file from the computer, from the patient's folder, a
// signed document, or forward a fax that came in. A cover sheet with a confidentiality notice goes first.

/** Everything sent in one fax, before the cover sheet (the relay to RingCentral carries up to ~4 MB). */
export const MAX_FAX_BYTES = 4_000_000;

/** What can be uploaded from the computer to fax (RingCentral turns these into fax pages). */
export const FAX_UPLOAD_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/tiff": "TIFF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/msword": "Word",
};

export type FaxAttachmentRef =
  | { kind: "upload"; key: string; name: string; mimeType: string }
  | { kind: "file"; id: number }
  | { kind: "document"; id: number }
  | { kind: "fax"; id: number };

export const OUTBOUND_FAX_STATUS = {
  sending: "Sending",
  queued: "Queued at RingCentral",
  sent: "Sent",
  failed: "Failed",
} as const;
export type OutboundFaxStatus = keyof typeof OUTBOUND_FAX_STATUS;

/** A US fax number as 10 digits, or null. Accepts (713) 555-0100, 713.555.0100, +1 713 555 0100… */
export function normalizeFaxNumber(input: string | null | undefined): string | null {
  const d = String(input ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return null;
  // Area code and exchange can't start with 0 or 1 (NANP).
  if (/^[01]/.test(ten) || /^[01]/.test(ten.slice(3))) return null;
  return ten;
}

/** RingCentral's message status → ours. */
export function faxStatusFrom(messageStatus: string | null | undefined): OutboundFaxStatus {
  const s = String(messageStatus ?? "").toLowerCase();
  if (s === "sent" || s === "delivered" || s === "received") return "sent";
  if (s.includes("fail")) return "failed";
  return "queued";
}

export const CONFIDENTIALITY_NOTICE =
  "CONFIDENTIALITY NOTICE: This fax may contain protected health information that is privileged and confidential under federal and state law. " +
  "It is intended only for the person or entity named above. If you are not the intended recipient, you are notified that any review, " +
  "disclosure, copying or distribution of this fax is strictly prohibited. If you received this fax in error, please notify the sender " +
  "immediately by telephone and destroy the documents.";

/** Safe for RingCentral (no & @ # $ % ^ * in file names). */
export const faxFileName = (name: string, fallback: string) => (name.replace(/[^\w .()-]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || fallback);
