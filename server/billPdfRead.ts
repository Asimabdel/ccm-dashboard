// Master Billing: AI reading of EOB PDFs, with the practice's AWS Bedrock model (the same one the fax
// inbox uses, covered by the AWS BAA). The PDF is read a couple of pages per request so each request
// stays under the 30-second limit; the browser asks for the page groups one after another.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PDFDocument } from "pdf-lib";
import { BILL_PDF_PROMPT, parsePdfReading } from "../shared/billPdf";
import { importBytes } from "./masterBillingDb";
import { WorkspaceError } from "./workspaceDb";

export const PDF_PAGES_PER_READ = 2;
/** Bedrock takes documents up to 4.5 MB. */
const MAX_AI_BYTES = 4_400_000;

const aiReady = () => !!process.env.BEDROCK_MODEL_ID;
/** Local testing only (never on Lambda): a made-up reading so the review screen can be tried without AWS. */
const fakeReader = () => !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.MASTER_BILLING_FAKE_PDF === "1";

let bedrock: BedrockRuntimeClient | null = null;
async function ask(pdf: Uint8Array): Promise<string> {
  bedrock ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1" });
  const out = await bedrock.send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL_ID!,
    messages: [{ role: "user", content: [{ document: { format: "pdf", name: "payment pages", source: { bytes: pdf } } }, { text: BILL_PDF_PROMPT }] }],
    inferenceConfig: { maxTokens: 6000, temperature: 0 },
  }));
  return (out.output?.message?.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("");
}

async function load(importId: number): Promise<PDFDocument> {
  const bytes = await importBytes(importId);
  if (bytes.subarray(0, 1024).indexOf("%PDF") < 0) throw new WorkspaceError("That file isn't a PDF.");
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new WorkspaceError("MyPCP couldn't open that PDF. Try saving it again as a PDF (Print → Save as PDF) and upload that.");
  }
}

/** How many pages, and how many reads it will take. */
export async function pdfInfo(importId: number) {
  if (!aiReady() && !fakeReader()) throw new WorkspaceError("AI reading isn't set up here, so PDFs can't be read. Upload the 835 payment file instead.");
  const pdf = await load(importId);
  const pages = pdf.getPageCount();
  return { pages, perRead: PDF_PAGES_PER_READ, reads: Math.ceil(pages / PDF_PAGES_PER_READ) };
}

/** Read pages [from, from + PDF_PAGES_PER_READ) (0-based). Nothing is saved: the owner checks it first. */
export async function readPdfPages(importId: number, from: number) {
  if (fakeReader() && !aiReady()) return { ...parsePdfReading(FAKE_READING), from, to: from + 1 };
  if (!aiReady()) throw new WorkspaceError("AI reading isn't set up here.");
  const src = await load(importId);
  const total = src.getPageCount();
  if (from < 0 || from >= total) throw new WorkspaceError("There are no more pages.");
  const to = Math.min(total, from + PDF_PAGES_PER_READ);
  const part = await PDFDocument.create();
  const copied = await part.copyPages(src, Array.from({ length: to - from }, (_, i) => from + i));
  copied.forEach((p) => part.addPage(p));
  const bytes = await part.save();
  if (bytes.length > MAX_AI_BYTES) throw new WorkspaceError(`Pages ${from + 1}–${to} are too large to read automatically.`);
  let text: string;
  try {
    text = await ask(bytes);
  } catch (e) {
    console.warn("[MasterBilling] PDF read failed:", (e as Error).message);
    throw new WorkspaceError(`The AI couldn't read pages ${from + 1}–${to}. Try again, or upload the 835 payment file instead.`);
  }
  return { ...parsePdfReading(text), from, to };
}

// Made-up EOB answer for local testing (MASTER_BILLING_FAKE_PDF=1, never on Lambda).
const FAKE_READING = JSON.stringify({
  payments: [{
    payer: "SAMPLE HEALTH PLAN", checkNumber: "PDF-0001", checkDate: "2026-11-02", checkAmount: 88,
    claims: [
      { patientName: "Test Patient One", memberId: "ZZ100", accountNumber: "DEMO-PDF-1", payerClaimNumber: "ICN-PDF-1", provider: "Demo Provider", status: "paid", billed: 160, allowed: 110, paid: 88, patientResponsibility: 22,
        lines: [{ date: "2026-10-15", code: "99214", modifiers: [], units: 1, billed: 160, allowed: 110, paid: 88, coinsurance: 22, adjustments: [{ group: "CO", code: "45", amount: 50 }], remarks: [] }] },
      { patientName: "Test Patient Two", memberId: "ZZ200", accountNumber: "DEMO-PDF-2", payerClaimNumber: "ICN-PDF-2", provider: "Demo Provider", status: "denied", billed: 95, allowed: 0, paid: 0, patientResponsibility: 0,
        lines: [{ date: "2026-10-16", code: "99213", modifiers: [], units: 1, billed: 95, allowed: 0, paid: 0, adjustments: [{ group: "CO", code: "16", amount: 95 }], remarks: ["M76"] }] },
    ],
  }],
});
