// Master Billing: matching a bill to a patient when the insurance wrote the name differently.
// Every name, birthday, ID and number here is made up.
import { describe, expect, it } from "vitest";
import { addMember, buildPeopleIndex, compareNames, findPeople, firstNameFits, memberVariants, personByMember, pickPerson, type PersonInput } from "./billPatientMatch";

const person = (key: string, name: string, dob: string | null, more: Partial<PersonInput> = {}): PersonInput => ({ key, patientId: key.startsWith("p:") ? Number(key.slice(2)) : null, name, dob, providerIds: [], visitDays: [], ...more });

describe("how alike two names are", () => {
  it("treats a cut-off or extra last name, a hyphen, a joined name and a nickname as the same person", () => {
    expect(compareNames("Lucia Ferreira Montal", "Lucia Ferreira")?.level).toBe("strong"); // second last name on the bill, cut off
    expect(compareNames("Lucia Ferreira Montal", "Lucia Ferreira Montalvo")?.level).toBe("strong");
    expect(compareNames("LUCIA FERREIRA MONTAL", "Ferreira-Montalvo, Lucia")?.level).toBe("strong");
    expect(compareNames("Tomas Delacruz", "Tomas De La Cruz")?.level).toBe("strong");
    expect(compareNames("Bill Hargrove", "William Hargrove")?.level).toBe("strong");
    expect(compareNames("Rafael Okonkwo", "Raphael Okonkwo")?.level).toBe("strong");
    expect(compareNames("Chris Penwell", "Christopher Penwell")?.level).toBe("strong");
    expect(compareNames("Karim Selim Haddad", "Karim Haddad")?.level).toBe("strong"); // middle name only on the bill
  });

  it("needs something else to confirm a typo, a middle name used as first, a swap or a near first name", () => {
    expect(compareNames("Hellen Brightwater", "Helen Brightwater")?.level).toBe("close");
    expect(compareNames("Sandra Okonkow", "Sandra Okonkwo")?.level).toBe("close"); // two letters swapped
    expect(compareNames("Karim Selim Haddad", "Selim Haddad")?.level).toBe("close"); // goes by the middle name
    expect(compareNames("Haddad Karim", "Karim Haddad")?.level).toBe("close");
    expect(compareNames("Daniel Ostrova", "Daniela Ostrova")?.level).toBe("close"); // can be two people
    expect(compareNames("Maria Elena Vasquez", "Maria Luisa Vasquez")?.level).toBe("close"); // different middle names
  });

  it("never calls family members or different people a match", () => {
    expect(compareNames("Maria Vasquez", "Jose Vasquez")).toBeNull();
    expect(compareNames("Lucia Ferreira", "Lucia Okafor")).toBeNull();
    expect(compareNames("Lucia", "Lucia Ferreira")).toBeNull(); // one word: can't tell
    expect(compareNames("Peter Lindqvist", "Paul Lindqvist")?.level).toBe("weak"); // only a suggestion
  });
});

describe("finding the person behind a bill", () => {
  it("joins the same person's roster, schedule and Practice Fusion records (the roster key wins)", () => {
    const idx = buildPeopleIndex([
      person("f:pf1", "Lucia Ferreira", "1980-03-02"), person("p:1", "Lucia Ferreira", "1980-03-02"), person("s:lucia ferreira|1980-03-02", "Lucia Ferreira", "1980-03-02", { visitDays: ["2026-10-05"] }),
      person("p:2", "Omar Faris", null), person("f:pf2", "Omar Faris", "1975-01-01"), // no birthday on the roster: joins the only one
      person("f:pf3", "Nadia Kovac", "1990-01-01"), person("f:pf4", "Nadia Kovac", "1992-02-02"), person("p:3", "Nadia Kovac", null), // two birthdays: kept apart
    ]);
    expect(idx.byKey.get("f:pf1")?.key).toBe("p:1");
    expect(idx.byKey.get("p:1")?.visitDays.has("2026-10-05")).toBe(true);
    expect(idx.byKey.get("f:pf2")?.key).toBe("p:2");
    expect(idx.byKey.get("p:2")?.dob).toBe("1975-01-01");
    expect(new Set(["f:pf3", "f:pf4", "p:3"].map((k) => idx.byKey.get(k)?.key)).size).toBe(3);
  });

  it("picks the one clear person, and leaves a tie for the owner", () => {
    const idx = buildPeopleIndex([person("p:1", "Lucia Ferreira", "1980-03-02"), person("p:9", "Hector Ruiz", "1960-05-05")]);
    const one = pickPerson(findPeople(idx, { name: "Lucia Ferreira Montal", dates: ["2026-11-02"], providerId: null }));
    expect(one?.person.key).toBe("p:1");

    // Two people fit the cut-off name equally: no pick, unless one had a visit that day.
    const two = buildPeopleIndex([person("p:1", "Lucia Ferreira", "1980-03-02"), person("p:4", "Lucia Ferreira Montalvo", "1955-07-07")]);
    const bill = { name: "Lucia Ferreira Montal", dates: ["2026-11-02"], providerId: null };
    expect(findPeople(two, bill).filter((c) => c.level === "strong")).toHaveLength(2);
    expect(pickPerson(findPeople(two, bill))).toBeNull();
    const seen = buildPeopleIndex([person("p:1", "Lucia Ferreira", "1980-03-02"), person("p:4", "Lucia Ferreira Montalvo", "1955-07-07", { visitDays: ["2026-11-02"] })]);
    expect(pickPerson(findPeople(seen, bill))?.person.key).toBe("p:4");
  });

  it("uses a typo match only when the provider or a visit confirms it", () => {
    const bill = { name: "Hellen Brightwater", dates: ["2026-10-31"], providerId: 7 };
    expect(pickPerson(findPeople(buildPeopleIndex([person("p:5", "Helen Brightwater", "1949-09-09")]), bill))).toBeNull();
    expect(pickPerson(findPeople(buildPeopleIndex([person("p:5", "Helen Brightwater", "1949-09-09", { providerIds: [7] })]), bill))?.person.key).toBe("p:5");
    expect(pickPerson(findPeople(buildPeopleIndex([person("p:5", "Helen Brightwater", "1949-09-09", { visitDays: ["2026-09-20"] })]), bill))?.person.key).toBe("p:5");
    // A visit more than two months away doesn't count.
    expect(pickPerson(findPeople(buildPeopleIndex([person("p:5", "Helen Brightwater", "1949-09-09", { visitDays: ["2026-06-01"] })]), bill))).toBeNull();
  });

  it("offers loose look-alikes only as suggestions", () => {
    const idx = buildPeopleIndex([person("p:6", "Paul Lindqvist", "1970-01-01")]);
    expect(findPeople(idx, { name: "Peter Lindqvist", dates: [], providerId: null })).toHaveLength(0);
    expect(findPeople(idx, { name: "Peter Lindqvist", dates: [], providerId: null }, true)[0]?.level).toBe("weak");
  });
});

describe("member IDs", () => {
  it("knows the same ID with a plan prefix or a card suffix", () => {
    expect(memberVariants("XOD123456789-01")).toEqual(expect.arrayContaining(["XOD12345678901", "12345678901", "XOD123456789", "123456789"]));
    expect(memberVariants("12-3")).toEqual([]);
  });

  it("matches by member ID only when the first name fits (families share IDs)", () => {
    const idx = buildPeopleIndex([person("p:1", "Lucia Ferreira", "1980-03-02"), person("p:8", "Sofia Ferreira", "2012-04-04")]);
    const members = new Map<string, Set<string>>();
    addMember(members, "XOD123456789", "p:1");
    expect(personByMember(idx, members, "123456789", "Lucia Ferreira Montal").map((p) => p.key)).toEqual(["p:1"]);
    expect(personByMember(idx, members, "XOD123456789", "Sofia Ferreira")).toEqual([]); // the child on the parent's ID
    expect(personByMember(idx, members, "XOD123456789", "Sofia Ferreira", false).map((p) => p.key)).toEqual(["p:1"]); // as a suggestion
    expect(firstNameFits("Lu Ferreira", "Lucia Ferreira")).toBe(false);
    expect(firstNameFits("Bill Hargrove", "William Hargrove")).toBe(true);
  });
});
