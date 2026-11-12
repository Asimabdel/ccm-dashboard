// Master Billing: reading payment files (835), claim-report spreadsheets, and joining one claim's
// files into one claim. Every name, number and amount here is made up.
import { describe, expect, it } from "vitest";
import { eraToEvents, isX12, parseEra835 } from "../shared/era835";
import { parseBillSheet, detectSheetMapping, sheetCents, headerSignature } from "../shared/billSheet";
import { mergeClaim, claimRefOf, CLAIM_LEVEL, NOT_LISTED, deductibleOwedCents, groupDeductible, type BillEventInput, type DeductibleLine } from "../shared/masterBilling";
import { adjustmentKind, insuranceType, statusFromText, describeAdjustment } from "../shared/billCodes";
import { parseCsvRows } from "../shared/workspace";
import { parsePdfReading } from "../shared/billPdf";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string, realRole?: string): TrpcContext {
  const user = { id: 98, openId: "mb-test", email: "mb@example.com", name: "Billing Test", loginMethod: "manus", role, realRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("who can open Master Billing", () => {
  it("refuses every role but an admin, before anything is read", async () => {
    const range = { from: "2026-01-01", to: "2026-12-31", basis: "service" as const };
    for (const role of ["billing", "staff", "provider", "front_desk", "office_manager", "medical_assistant"]) {
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.summary(range)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // An admin previewing another role ("view as") doesn't get it either.
    await expect(appRouter.createCaller(ctxFor("billing", "admin")).masterBilling.imports()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("picking hundreds of Office Ally files at once", () => {
  it("leaves out the readable .txt copies and a file picked twice", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const { prepareFiles } = await import("../client/src/lib/masterBillingFiles");
    const era = wrap(PAYMENT_1);
    const zip = (n: string, body: string) => new File([zipSync({ [`${n}.835`]: strToU8(body), [`${n}.TXT`]: strToU8("REMITTANCE ADVICE\nPAYER, CHECK\nA, B\n") })], `${n}.zip`);
    const other = era.replace("EFT12345", "EFT99999");
    const picked = await prepareFiles([zip("ERA_1", era), zip("ERA_1 (1)", era), zip("ERA_2", other), new File([strToU8("CLAIM, PAID\nX, 1\n")], "ERA_2.txt")]);
    expect(picked.filter((f) => f.kind === "era835")).toHaveLength(2);
    const notes = picked.filter((f) => f.kind === "note").map((f) => f.name);
    expect(notes).toEqual(["4 readable copies left out", "1 file picked twice"]);
    expect(picked.some((f) => f.kind === "sheet" || f.kind === "error")).toBe(false);
  });

  it("keeps a real claim report picked together with payment files", async () => {
    const { prepareFiles } = await import("../client/src/lib/masterBillingFiles");
    const picked = await prepareFiles([new File([wrap(PAYMENT_1)], "a.835"), new File(["Claim #,Patient,DOS,Billed\nA1,Ann Lee,10/05/2026,75\n"], "report.csv")]);
    expect(picked.map((f) => f.kind).sort()).toEqual(["era835", "sheet"]);
  });
});

describe("PDF EOBs read by the AI", () => {
  it("turns the reading into claims and flags numbers that don't add up", () => {
    const text = "Here you go: " + JSON.stringify({ payments: [{ payer: "MADE UP PLAN", checkNumber: "C55", checkDate: "2026-11-01", checkAmount: 80, claims: [
      { patientName: "Ann Example", accountNumber: "PCN9", status: "paid", billed: 120, paid: 80, lines: [{ date: "2026-10-01", code: "99213", billed: 120, paid: 80, coinsurance: 20, adjustments: [{ group: "CO", code: "45", amount: 20 }] }] },
      { patientName: null, accountNumber: "PCN10", status: "denied", billed: 50, paid: 0, lines: [{ date: "2026-10-02", code: "36415", billed: 50, paid: 0, adjustments: [{ group: "CO", code: "97", amount: 40 }] }] },
    ] }] });
    const r = parsePdfReading(text);
    expect(r.payments[0]).toMatchObject({ payer: "MADE UP PLAN", checkNumber: "C55", checkAmountCents: 8000 });
    expect(r.claims).toHaveLength(2);
    const paid = mergeClaim([ev(r.claims[0]!.event)]);
    expect(paid).toMatchObject({ status: "paid", billedCents: 12000, paidCents: 8000, patientOwesCents: 2000, writtenOffCents: 2000 });
    expect(r.claims[0]!.warnings).toEqual([]);
    expect(r.claims[1]!.event.clpStatus).toBe("4");
    expect(r.claims[1]!.warnings.join(" ")).toMatch(/No patient name|billed/);
    expect(r.claims[1]!.warnings.some((w) => w.includes("36415"))).toBe(true);
  });

  it("reads nothing from an answer that isn't JSON", () => {
    expect(parsePdfReading("Sorry, I can't read this.")).toEqual({ payments: [], claims: [] });
  });
});

const ISA = "ISA*00*          *00*          *ZZ*CLEARINGHOUSE  *ZZ*SAMPLECLINIC   *261105*1200*^*00501*000000001*0*T*:~";
const wrap = (body: string[]) => [ISA, "GS*HP*CH*CLINIC*20261105*1200*1*X*005010X221A1", ...body, "GE*1*1", "IEA*1*000000001"].join("~\n") + "~";

const PAYMENT_1 = [
  "ST*835*0001",
  "BPR*I*130*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20261105",
  "TRN*1*EFT12345*1512345678",
  "DTM*405*20261104",
  "N1*PR*MADE UP HEALTH PLAN",
  "REF*2U*99999",
  "N1*PE*SAMPLE CLINIC*XX*1999999999",
  "LX*1",
  "CLP*PCN1001*1*250*120*30*CI*PAYERCLM1",
  "NM1*QC*1*DOE*JANE****MI*W123456789",
  "NM1*82*1*SMITH*ALEX****XX*1888888888",
  "DTM*232*20261020",
  "SVC*HC:99214*200*100**1",
  "DTM*472*20261020",
  "CAS*CO*45*70",
  "CAS*PR*2*30",
  "AMT*B6*130",
  "SVC*HC:36415*50*20**1",
  "DTM*472*20261020",
  "CAS*CO*45*30",
  "AMT*B6*20",
  "CLP*PCN1002*4*150*0*0*CI*PAYERCLM2",
  "NM1*QC*1*ROE*RICHARD****MI*W987654321",
  "SVC*HC:99213:25*150*0**1",
  "DTM*472*20261021",
  "CAS*CO*97*150",
  "CLP*PCN1003*1*180*0*120*CI*PAYERCLM3",
  "NM1*QC*1*POE*EDGAR****MI*W555",
  "SVC*HC:99213*180*0**1",
  "DTM*472*20261022",
  "CAS*CO*45*60",
  "CAS*PR*1*120",
  "PLB*1999999999*20261231*L6:INTEREST*-10",
  "SE*33*0001",
];

let nextId = 1;
const ev = (e: BillEventInput) => ({ ...e, id: nextId++ });
const claimOf = (text: string, claimNo: string) => eraToEvents(parseEra835(text)).filter((e) => e.claimNo === claimNo);

describe("835 payment files", () => {
  const file = parseEra835(wrap(PAYMENT_1));

  it("reads the payment, its claims and lines", () => {
    expect(isX12(wrap(PAYMENT_1))).toBe(true);
    expect(file.warnings).toEqual([]);
    expect(file.checks).toHaveLength(1);
    const c = file.checks[0]!;
    expect(c).toMatchObject({ payerName: "MADE UP HEALTH PLAN", payerId: "99999", checkNumber: "EFT12345", amountCents: 13000, paymentDate: "2026-11-05", method: "ACH" });
    expect(c.claims.map((x) => x.patientControlNo)).toEqual(["PCN1001", "PCN1002", "PCN1003"]);
    const first = c.claims[0]!;
    expect(first).toMatchObject({ patientFirst: "JANE", patientLast: "DOE", memberId: "W123456789", renderingName: "ALEX SMITH", renderingNpi: "1888888888", serviceFrom: "2026-10-20" });
    expect(first.lines[0]).toMatchObject({ code: "99214", billedCents: 20000, paidCents: 10000, allowedCents: 13000, serviceDate: "2026-10-20" });
    expect(c.claims[1]!.lines[0]!.modifiers).toEqual(["25"]);
  });

  it("checks the claim payments add up to the check (interest included)", () => {
    expect(file.checks[0]!.providerAdjustments).toEqual([{ code: "L6", ref: "INTEREST", cents: -1000 }]);
    expect(file.checks[0]!.balanced).toBe(true);
    const off = parseEra835(wrap(PAYMENT_1.map((s) => (s.startsWith("BPR") ? s.replace("BPR*I*130", "BPR*I*131") : s))));
    expect(off.checks[0]!.balanced).toBe(false);
    expect(off.checks[0]!.balanceDiffCents).toBe(-100);
  });

  it("reads a file with other separators, one segment per line", () => {
    const pipe = wrap(PAYMENT_1).replace(/\*/g, "|").replace(/:/g, ">").replace(/~\n?/g, "\n");
    const parsed = parseEra835(pipe);
    expect(parsed.checks[0]!.claims).toHaveLength(3);
    expect(parsed.checks[0]!.claims[1]!.lines[0]).toMatchObject({ code: "99213", modifiers: ["25"] });
    expect(parsed.checks[0]!.balanced).toBe(true);
  });

  it("reads two payments in one file", () => {
    const second = PAYMENT_1.map((s) => s.replace("EFT12345", "CHK777").replace("ST*835*0001", "ST*835*0002").replace("SE*33*0001", "SE*33*0002"));
    const parsed = parseEra835(wrap([...PAYMENT_1, ...second]));
    expect(parsed.checks.map((c) => c.checkNumber)).toEqual(["EFT12345", "CHK777"]);
  });

  it("refuses something that isn't an 835", () => {
    expect(isX12("Patient,DOS\nA,1/1/2026")).toBe(false);
    expect(() => parseEra835("hello")).toThrow();
  });
});

describe("one claim from its files", () => {
  const text = wrap(PAYMENT_1);

  it("paid claim: billed, allowed, paid, write-off and patient share", () => {
    const m = mergeClaim(claimOf(text, "PCN1001").map(ev));
    expect(m).toMatchObject({ status: "paid", billedCents: 25000, allowedCents: 15000, paidCents: 12000, writtenOffCents: 10000, patientOwesCents: 3000, deniedCents: 0, patientName: "JANE DOE", payerName: "MADE UP HEALTH PLAN" });
    expect(m.lines.map((l) => l.code)).toEqual(["99214", "36415"]);
  });

  it("denied claim keeps the reason", () => {
    const m = mergeClaim(claimOf(text, "PCN1002").map(ev));
    expect(m).toMatchObject({ status: "denied", deniedCents: 15000, paidCents: 0, denialCodes: ["CO-97"] });
  });

  it("$0 because of the deductible is 'patient owes', not a denial", () => {
    const m = mergeClaim(claimOf(text, "PCN1003").map(ev));
    expect(m).toMatchObject({ status: "patient_owes", patientOwesCents: 12000, writtenOffCents: 6000, deniedCents: 0 });
  });

  const one = (status: string, billed: number, paid: number, cas: string[], icn: string, check: string, date: string) => [
    "ST*835*0001", `BPR*I*${paid}*C*ACH************${date}`, `TRN*1*${check}*1`, "N1*PR*MEDICARE PART B",
    "LX*1", `CLP*PCN2001*${status}*${billed}*${paid}*0*MB*${icn}`, "NM1*QC*1*LANE*LOIS****MI*1AB2CD3EF45",
    `SVC*HC:99213*${billed}*${paid}**1`, "DTM*472*20261001", ...cas, "SE*9*0001",
  ];

  it("take-back then corrected payment: only the new payment counts", () => {
    const a = eraToEvents(parseEra835(wrap(one("1", 100, 60, ["CAS*CO*45*40"], "ICN1", "C1", "20261010"))));
    const b = eraToEvents(parseEra835(wrap([
      ...one("22", -100, -60, ["CAS*CO*45*-40"], "ICN1", "C2", "20261020"),
      ...one("1", 100, 70, ["CAS*CO*45*30"], "ICN2", "C2", "20261020").map((s) => s.replace("ST*835*0001", "ST*835*0002")),
    ])));
    const m = mergeClaim([...a, ...b].map(ev));
    expect(m).toMatchObject({ status: "paid", billedCents: 10000, paidCents: 7000, writtenOffCents: 3000 });
    expect(m.lines).toHaveLength(1);
  });

  it("a take-back line's negative units are read as a count", () => {
    const rev = parseEra835(wrap(one("22", -100, -60, ["CAS*CO*45*-40"], "ICN1", "C2", "20261020").map((s) => (s.startsWith("SVC") ? s.replace(/\*\*1$/, "**-1") : s))));
    expect(rev.checks[0]!.claims[0]!.lines[0]!.units).toBe(1);
  });

  it("take-back with no new payment", () => {
    const a = eraToEvents(parseEra835(wrap(one("1", 100, 60, ["CAS*CO*45*40"], "ICN1", "C1", "20261010"))));
    const b = eraToEvents(parseEra835(wrap(one("22", -100, -60, ["CAS*CO*45*-40"], "ICN1", "C2", "20261020"))));
    const m = mergeClaim([...a, ...b].map(ev));
    expect(m).toMatchObject({ status: "taken_back", billedCents: 10000, paidCents: 0, writtenOffCents: 0 });
  });

  it("primary then secondary insurance: billed once, payments add up", () => {
    const primary = eraToEvents(parseEra835(wrap(one("19", 100, 80, ["CAS*PR*2*20"], "P1", "C1", "20261010"))));
    const secondary = eraToEvents(parseEra835(wrap(one("2", 100, 20, ["CAS*OA*23*80"], "S1", "C9", "20261025").map((s) => s.replace("MEDICARE PART B", "MADE UP SUPPLEMENT")))));
    const m = mergeClaim([...secondary, ...primary].map(ev));
    expect(m).toMatchObject({ status: "paid", billedCents: 10000, paidCents: 10000, laterPayersPaidCents: 2000, patientOwesCents: 0, writtenOffCents: 0, payerName: "MEDICARE PART B", otherPayers: ["MADE UP SUPPLEMENT"] });
  });

  it("a claim-level amount becomes its own line so lines add up to the claim", () => {
    const body = one("1", 100, 60, ["CAS*CO*45*40"], "ICN1", "C1", "20261010").map((s) => (s.startsWith("CLP") ? `${s}~CAS*OA*94*-5` : s)).join("~").split("~");
    const fixed = body.map((s) => (s.startsWith("CLP") ? s.replace("*60*0*MB", "*65*0*MB") : s));
    const m = mergeClaim(eraToEvents(parseEra835(wrap(fixed))).map(ev));
    expect(m.paidCents).toBe(6500);
    expect(m.lines.map((l) => l.code)).toEqual(["99213", CLAIM_LEVEL]);
  });

  it("a waiting claim from a report is replaced by its payment, not added to it", () => {
    const rows = parseCsvRows("Patient Account #,Patient Name,DOS,CPT,Billed,Status,Insurance\nPCN1001,\"Doe, Jane\",10/20/2026,99214,200,Accepted,Made Up Health Plan\nPCN1001,\"Doe, Jane\",10/20/2026,36415,50,Accepted,Made Up Health Plan\n");
    const sheet = parseBillSheet(rows).events;
    expect(sheet).toHaveLength(1);
    const waiting = mergeClaim(sheet.map(ev));
    expect(waiting).toMatchObject({ status: "waiting", billedCents: 25000, paidCents: 0, patientName: "Jane Doe" });
    expect(claimRefOf(sheet[0]!)).toBe(claimRefOf(claimOf(text, "PCN1001")[0]!));
    const both = mergeClaim([...sheet, ...claimOf(text, "PCN1001")].map(ev));
    expect(both).toMatchObject({ status: "paid", billedCents: 25000, paidCents: 12000, sourceUsed: "era835" });
  });

  it("a PDF of a payment already in a payment file isn't counted twice", () => {
    const era = claimOf(text, "PCN1001");
    const pdf = era.map((e) => ({ ...e, source: "pdf" as const }));
    expect(mergeClaim([...era, ...pdf].map(ev)).paidCents).toBe(12000);
  });
});

describe("claim-report spreadsheets", () => {
  it("finds the header row and guesses the columns", () => {
    const rows = parseCsvRows("Claims report,,,\nPrinted 11/10/2026,,,\nClaim #,Patient,Date of Service,Procedure Code,Charge Amount,Insurance Paid,Claim Status,Payer Name\n");
    const d = detectSheetMapping(rows);
    expect(d.headerRow).toBe(2);
    expect(d.mapping).toMatchObject({ claimNo: 0, patientName: 1, serviceDate: 2, cpt: 3, billed: 4, paid: 5, status: 6, payer: 7 });
    expect(headerSignature(d.headers)).toBe("claim #|patient|date of service|procedure code|charge amount|insurance paid|claim status|payer name");
  });

  it("reads a claim-level row (no CPT) and a denied row", () => {
    const rows = parseCsvRows("Account Number,Last Name,First Name,DOS,Total Charges,Paid,Status,Denial Reason\nA1,Roe,Rick,10/02/2026,$150.00,0,Denied,CO-16 missing info\nA2,Moe,Mia,10/03/2026,$90.00,$54.00,Paid,\n,,,,Total,$240.00,,\n");
    const r = parseBillSheet(rows);
    expect(r.events).toHaveLength(2);
    const denied = mergeClaim([ev(r.events[0]!)]);
    expect(denied).toMatchObject({ status: "denied", billedCents: 15000, deniedCents: 15000, denialCodes: ["CO-16"], patientName: "Rick Roe" });
    expect(denied.lines[0]!.code).toBe(NOT_LISTED);
    expect(mergeClaim([ev(r.events[1]!)])).toMatchObject({ status: "paid", paidCents: 5400 });
  });

  it("lets the owner fix a column guess", () => {
    const rows = parseCsvRows("Ref,Patient,Svc Dt,Amt\nX9,Ann Lee,10/05/2026,75\n");
    const r = parseBillSheet(rows, { claimNo: 0, serviceDate: 2, billed: 3 });
    expect(r.events[0]).toMatchObject({ claimNo: "X9", serviceFrom: "2026-10-05", billedCents: 7500 });
  });

  it("reads money the way reports print it", () => {
    expect(sheetCents("$1,234.50")).toBe(123450);
    expect(sheetCents("(12.00)")).toBe(-1200);
    expect(sheetCents("0")).toBe(0);
    expect(sheetCents("")).toBeNull();
    expect(sheetCents("n/a")).toBeNull();
  });
});

describe("codes in plain words", () => {
  it("sorts adjustments into patient share, write-off and denial", () => {
    expect(adjustmentKind("PR", "1")).toBe("patient");
    expect(adjustmentKind("CO", "45")).toBe("writeoff");
    expect(adjustmentKind("CO", "253")).toBe("writeoff");
    expect(adjustmentKind("OA", "23")).toBe("writeoff");
    expect(adjustmentKind("CO", "97")).toBe("denied");
    expect(adjustmentKind("CO", "16")).toBe("denied");
    expect(describeAdjustment("CO", "97")).toBe("CO-97: Included in the payment for another service (bundled)");
    expect(describeAdjustment("CO", "ZZ9")).toBe("CO-ZZ9");
  });

  it("names the kind of insurance", () => {
    expect(insuranceType("MEDICARE PART B", "MB")).toBe("Medicare");
    expect(insuranceType("NOVITAS SOLUTIONS", null)).toBe("Medicare");
    expect(insuranceType("AETNA MEDICARE", "CI")).toBe("Medicare Advantage");
    expect(insuranceType("WELLCARE TEXANPLUS", "16")).toBe("Medicare Advantage");
    expect(insuranceType("BLUE CROSS BLUE SHIELD OF TEXAS", "BL")).toBe("Commercial");
    expect(insuranceType("TEXAS MEDICAID", "MC")).toBe("Medicaid");
    expect(insuranceType("TRICARE EAST", null)).toBe("Military / VA");
    expect(insuranceType(null, null)).toBe("Other");
  });

  it("reads a report's status words", () => {
    expect(statusFromText("Accepted")).toBe("waiting");
    expect(statusFromText("In Process")).toBe("waiting");
    expect(statusFromText("Rejected by payer")).toBe("rejected");
    expect(statusFromText("DENIED")).toBe("denied");
    expect(statusFromText("Paid")).toBe("paid");
    expect(statusFromText("")).toBeNull();
  });
});

describe("high-deductible patients", () => {
  it("counts only the deductible the patient still owes", () => {
    const ded = [{ group: "PR", code: "1", cents: 15000 }, { group: "PR", code: "2", cents: 2000 }, { group: "CO", code: "45", cents: 9000 }];
    expect(deductibleOwedCents(ded, 17000)).toBe(15000); // deductible + coinsurance owed: only the deductible part
    expect(deductibleOwedCents(ded, 4000)).toBe(4000); // a second insurance paid most of it
    expect(deductibleOwedCents(ded, 0)).toBe(0); // e.g. Medicaid behind Medicare paid it all
    expect(deductibleOwedCents([{ group: "PR", code: "3", cents: 2500 }], 2500)).toBe(0); // a copay isn't a deductible
    expect(deductibleOwedCents(null, 5000)).toBe(0);
  });

  it("finds people with a deductible on several separate visits", () => {
    const line = (personKey: string, date: string, cents: number, claimId: number): DeductibleLine => ({ claimId, personKey, date, deductibleCents: cents, payerName: "DEMO PLAN", providerId: 1, clinicId: 2 });
    const found = groupDeductible([
      line("p:1", "2026-02-03", 12000, 1), line("p:1", "2026-02-03", 3000, 1), line("p:1", "2026-03-10", 9000, 2), line("p:1", "2026-05-01", 4000, 3), // 3 visits
      line("p:2", "2026-04-04", 20000, 4), // one visit only
      line("p:3", "2026-01-15", 5000, 5), line("p:3", "2026-06-20", 0, 6), line("p:3", "2026-07-01", 6000, 7), // the $0 line doesn't count
    ], 2);
    expect(found.map((p) => [p.personKey, p.visits.length, p.deductibleCents])).toEqual([["p:1", 3, 28000], ["p:3", 2, 11000]]);
    expect(found[0]!.lastDate).toBe("2026-05-01");
    expect(groupDeductible([line("p:1", "2026-02-03", 100, 1), line("p:1", "2026-03-03", 100, 2)], 3)).toEqual([]);
  });
});
