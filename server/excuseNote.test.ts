import { describe, expect, it } from "vitest";
import { cleanFields, guessPrefill, type DocField } from "../shared/documents";
import { NOTE_PAGE, excuseNoteLayout, letterNameOf } from "../shared/excuseNote";
import { PRACTICE_FAX, PRACTICE_PHONE, textWidth } from "../shared/stamps";
import { letterNameFor } from "./letterheadSetup";
import { matchClinic } from "../shared/costs";

// Made-up provider and office.
const note = (signer: "preparer" | `signer:${number}` = "preparer") =>
  excuseNoteLayout({ who: "Sarah Chen, MD", office: { name: "MyPCP Dr - Katy", address: "1234 Katy Fwy, Katy, TX 77494" }, today: "2026-11-16", signer });
const byId = (fields: DocField[], id: string) => fields.find((f) => f.id === id)!;

describe("Excuse note", () => {
  it("has a box on every blank, with the provider's letterhead", () => {
    const n = note();
    expect(n.fields.map((f) => f.id)).toEqual([
      "letterhead", "date", "patient_name", "patient_dob", "seen_on", "work", "school", "from", "through", "return_on",
      "no_restrictions", "restrictions_yes", "restrictions", "comments", "comments_more", "signature", "signed_on", "signed_by",
    ]);
    expect(byId(n.fields, "letterhead").design).toEqual({
      kind: "letterhead", who: "Sarah Chen, MD", place: "Katy", address: "1234 Katy Fwy, Katy, TX 77494", phone: PRACTICE_PHONE, fax: PRACTICE_FAX,
    });
    // The patient fills in from their record; today's date goes on the note, the visit and the signature.
    expect(byId(n.fields, "patient_name").prefill).toBe("patient_name");
    expect(byId(n.fields, "patient_dob").prefill).toBe("patient_dob");
    for (const id of ["date", "seen_on", "signed_on"]) expect(byId(n.fields, id).value).toBe("2026-11-16");
    // The provider's name under the signature (bold, can be corrected), and the office's phone in the wording.
    expect(byId(n.fields, "signed_by")).toMatchObject({ type: "text", value: "Sarah Chen, MD", bold: true, assignee: "preparer" });
    expect(guessPrefill(byId(n.fields, "signed_by").label, "text")).toBeNull();
    expect(n.texts.some((t) => t.text.includes(PRACTICE_PHONE))).toBe(true);
  });
  it("lines every box up on its own blank, all on the page, none overlapping", () => {
    const n = note();
    const fills = n.fields.filter((f) => (f.type === "text" || f.type === "date") && f.id !== "signed_by");
    for (const f of fills) {
      // The box's bottom edge is the blank line it sits on, and it's wide enough for a date.
      const lineTop = NOTE_PAGE.h - f.y;
      expect(n.lines.some((l) => !l.rule && Math.abs(l.top - lineTop) < 0.01 && l.x1 <= f.x && l.x2 >= f.x + f.w)).toBe(true);
      expect([f.id, f.w >= 100]).toEqual([f.id, true]);
    }
    for (const f of n.fields) {
      expect(f.x).toBeGreaterThanOrEqual(36); expect(f.x + f.w).toBeLessThanOrEqual(NOTE_PAGE.w - 36);
      expect(f.y).toBeGreaterThanOrEqual(36); expect(f.y + f.h).toBeLessThanOrEqual(NOTE_PAGE.h - 20);
    }
    const overlap = (a: DocField, b: DocField) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const a of n.fields) for (const b of n.fields) if (a !== b) expect([a.id, b.id, overlap(a, b)]).toEqual([a.id, b.id, false]);
    // Printed words never run into a box on the same line.
    for (const t of n.texts.filter((x) => !x.center)) {
      const right = t.x + textWidth(t.text, t.size, !!t.bold);
      for (const f of n.fields) {
        const top = NOTE_PAGE.h - f.y - f.h, bottom = NOTE_PAGE.h - f.y;
        if (t.b > top && t.b - t.size * 0.72 < bottom) expect([t.text, f.id, right <= f.x || t.x >= f.x + f.w]).toEqual([t.text, f.id, true]);
      }
      expect(right).toBeLessThanOrEqual(NOTE_PAGE.w - 36);
    }
    // Check boxes have their printed squares.
    for (const c of n.fields.filter((f) => f.type === "checkbox")) expect(n.squares.some((s) => s.x === c.x && Math.abs(NOTE_PAGE.h - s.top - s.size - c.y) < 0.01)).toBe(true);
  });
  it("gives the signature to the provider when they co-sign", () => {
    const mine = note();
    expect(byId(mine.fields, "signature").assignee).toBe("preparer");
    const theirs = note("signer:42");
    expect(byId(theirs.fields, "signature").assignee).toBe("signer:42");
    expect(byId(theirs.fields, "signed_on").assignee).toBe("signer:42");
    // Everything else is filled in by whoever makes the note.
    expect(theirs.fields.filter((f) => f.assignee !== "preparer").map((f) => f.id)).toEqual(["signature", "signed_on"]);
  });
  it("survives saving, and fills only the boxes meant for the record", () => {
    const saved = cleanFields(note().fields, [{ ...NOTE_PAGE, rotate: 0 }]);
    expect(saved).toHaveLength(18);
    expect(byId(saved, "signed_by").bold).toBe(true);
    expect(byId(saved, "letterhead").design).toMatchObject({ who: "Sarah Chen, MD", fax: PRACTICE_FAX });
    // The dates staff choose (excused from / through, return) are never guessed from the record.
    for (const id of ["from", "through", "return_on", "restrictions", "comments", "comments_more"]) {
      const f = byId(saved, id);
      expect([id, guessPrefill(f.label, f.type)]).toEqual([id, null]);
    }
  });
  it("prints the provider's name the way it was set for letters", () => {
    expect(letterNameOf({ letterName: "Sarah Chen, MD", name: "Chen" })).toBe("Sarah Chen, MD");
    expect(letterNameOf({ letterName: " ", name: "Chen", userName: "Sarah Chen", title: "MD" })).toBe("Sarah Chen, MD");
    expect(letterNameOf({ name: "Dr. Chen, MD", title: "MD" })).toBe("Dr. Chen, MD");
    expect(letterNameOf({ name: "Chen" })).toBe("Chen");
  });
});

describe("Letterhead setup job", () => {
  it("matches each provider record to one name, by name, alias or login name", () => {
    expect(letterNameFor({ name: "Al Hadad", aliases: ["Sudad", "Dr. Sudad"] })).toBe("Sudad Al Hadad, MD");
    expect(letterNameFor({ name: "Maggie", aliases: ["Magdalene"] })).toBe("Magdalene Inyang, FNP");
    expect(letterNameFor({ name: "Yilian" })).toBe("Yilian Almaguer Simon, FNP");
    expect(letterNameFor({ name: "Narang" })).toBe("Nisha Narang, MD");
    expect(letterNameFor({ name: "Provider", userName: "Mohamed Mansour" })).toBe("Mohamed Mansour, MD");
    // Unknown, or matching two people: left alone.
    expect(letterNameFor({ name: "Dr. New Person" })).toBeNull();
    expect(letterNameFor({ name: "Mansour", aliases: ["Narang"] })).toBeNull();
  });
  it("still matches ZocDoc locations to the office after the address gets its city and ZIP", () => {
    const offices = [{ id: 2, name: "Demo Clinic - Cypress", address: "7050 Lakeview Haven Dr, Ste 100, Houston, TX 77095" }, { id: 1, name: "Demo Clinic - Katy", address: "21398 Provincial Blvd, Katy, TX 77450" }];
    expect(matchClinic("Lakeview Haven", offices)?.id).toBe(2);
    expect(matchClinic("7050 Lakeview Haven Dr, Ste 100, Houston, TX, 77095", offices)?.id).toBe(2);
    expect(matchClinic("21398 Provincial Blvd, Katy", offices)?.id).toBe(1);
  });
});
