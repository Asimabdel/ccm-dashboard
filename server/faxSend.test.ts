import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { faxFileName, faxStatusFrom, normalizeFaxNumber } from "../shared/faxSend";
import { can } from "../shared/workspace";

describe("fax numbers", () => {
  it("accepts US numbers in any common format", () => {
    expect(normalizeFaxNumber("(713) 555-0100")).toBe("7135550100");
    expect(normalizeFaxNumber("+1 713.555.0100")).toBe("7135550100");
    expect(normalizeFaxNumber("17135550100")).toBe("7135550100");
  });
  it("rejects anything that isn't a dialable US number", () => {
    expect(normalizeFaxNumber("555-0100")).toBeNull();
    expect(normalizeFaxNumber("(013) 555-0100")).toBeNull(); // area code can't start with 0
    expect(normalizeFaxNumber("(713) 155-0100")).toBeNull(); // exchange can't start with 1
    expect(normalizeFaxNumber("")).toBeNull();
  });
});

describe("fax status and file names", () => {
  it("maps RingCentral's message status", () => {
    expect(faxStatusFrom("Queued")).toBe("queued");
    expect(faxStatusFrom("Sent")).toBe("sent");
    expect(faxStatusFrom("SendingFailed")).toBe("failed");
    expect(faxStatusFrom("DeliveryFailed")).toBe("failed");
    expect(faxStatusFrom(undefined)).toBe("queued");
  });
  it("keeps file names RingCentral accepts", () => {
    expect(faxFileName("Labs & notes #2 @ 9/30", "x")).toBe("Labs _ notes _2 _ 9_30");
    expect(faxFileName("***", "attachment-1")).toBe("___");
    expect(faxFileName("", "attachment-1")).toBe("attachment-1");
  });
});

describe("who can send", () => {
  it("everyone with patient access, nobody without", () => {
    for (const r of ["admin", "office_manager", "staff", "provider", "front_desk", "medical_assistant"]) expect(can(r, "sendFax")).toBe(true);
    expect(can("billing", "sendFax")).toBe(false);
    expect(can("user", "sendFax")).toBe(false);
  });
});

describe("what goes to RingCentral", async () => {
  const { coverSheet, multipart } = await import("./faxSendDb");
  it("the cover sheet is a one-page PDF, without the patient", async () => {
    const bytes = await coverSheet({ clinicName: "MyPCP Dr - Katy", clinicPhone: "2815550100", fromFax: "2815550101", toName: "Houston Cardiology (made up)", toFax: "7135550100", sender: "Rosa Diaz", date: "October 2, 2026", pages: 4, note: "Referral attached." });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });
  it("one JSON part for the recipient, then each file", () => {
    const { body, contentType } = multipart({ to: [{ phoneNumber: "+17135550100" }], coverIndex: 0 }, [
      { name: "Cover-sheet.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1") },
      { name: "labs.png", mimeType: "image/png", bytes: Buffer.from([1, 2, 3]) },
    ]);
    const boundary = contentType.split("boundary=")[1]!;
    expect(contentType.startsWith("multipart/mixed; boundary=")).toBe(true);
    const text = body.toString("latin1");
    const parts = text.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("Content-Type: application/json");
    expect(JSON.parse(parts[0]!.split("\r\n\r\n")[1]!.trim()).to[0].phoneNumber).toBe("+17135550100");
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="labs.png"');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});
