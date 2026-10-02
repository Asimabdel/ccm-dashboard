import { describe, expect, it } from "vitest";
import { parseEmailReading } from "../shared/email";
import { makePersonMatcher } from "../shared/fax";

describe("AI read of an unmatched email", () => {
  it("takes the patient's name, date of birth and phone from the model's JSON (made-up people)", () => {
    expect(parseEmailReading('Sure! {"patientName": "Ophelia Demoperson", "dob": "1950-03-15", "phone": "(281) 555-0199", "writerIsPatient": false}'))
      .toEqual({ patientName: "Ophelia Demoperson", dob: "1950-03-15", phone: "2815550199", writerIsPatient: false });
  });

  it("drops anything that can't be used to match: one-word names, bad or future dates, short phones, 'null' strings", () => {
    expect(parseEmailReading('{"patientName": "Ophelia", "dob": "2999-01-01", "phone": "555", "writerIsPatient": "yes"}'))
      .toEqual({ patientName: null, dob: null, phone: null, writerIsPatient: null });
    expect(parseEmailReading('{"patientName": "null", "dob": "03/15/1950"}')).toMatchObject({ patientName: null, dob: null });
    expect(parseEmailReading("no json here")).toBeNull();
  });

  it("routes only on name + date of birth matching one person; a name alone is a suggestion", () => {
    const people = [
      { key: "p:1", patientId: 1, name: "Ophelia Demoperson", dob: "1950-03-15" },
      { key: "f:9", patientId: null, name: "Ophelia Demoperson", dob: "1988-07-01" },
      { key: "s:x", patientId: null, name: "Tobias Exampleton", dob: "1970-01-02" },
    ];
    const match = makePersonMatcher(people);
    expect(match("Ophelia Demoperson", "1950-03-15")).toEqual({ person: people[0], sure: true });
    expect(match("Ophelia Demoperson", null)).toBeNull(); // two people with that name
    expect(match("Tobias Exampleton", null)).toEqual({ person: people[2], sure: false });
  });
});
