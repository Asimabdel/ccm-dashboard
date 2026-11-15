// Costs in Master Billing (owner only, 2026-11-15): the practice's monthly bills (rent per clinic first) and a
// month-by-month "money in vs. money out": insurance payments loaded in Master Billing (by payment date) against
// estimated payroll, these costs and ZocDoc's per-booking charges. Only read and written through the
// Master Billing router (owner guard).
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { billClaims, billLines, clinics, practiceCosts, users, zocdocBookings } from "../drizzle/schema";
import { audit, WorkspaceError, type WorkspaceActor } from "./workspaceDb";
import { payroll } from "./payrollDb";
import { COST_CATEGORIES, costInMonth, costsByMonth, isMonth, matchClinic, moneyMonth, monthsBetween, nextMonth, type CostCategory } from "../shared/costs";
import { addDays, localDateStr } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** Payroll has time-clock hours from October 2026 on, so money in vs. out starts there. */
export const FIRST_MONEY_MONTH = "2026-10";
const lastDayOf = (m: string) => addDays(`${nextMonth(m)}-01`, -1);

export async function listCosts() {
  const d = await db();
  const rows = await d.select({ c: practiceCosts, clinicName: clinics.name, by: users.name }).from(practiceCosts)
    .leftJoin(clinics, eq(clinics.id, practiceCosts.clinicId)).leftJoin(users, eq(users.id, practiceCosts.createdByUserId))
    .orderBy(asc(practiceCosts.category), asc(clinics.name), asc(practiceCosts.startMonth), asc(practiceCosts.id));
  return rows.map(({ c, clinicName, by }) => ({
    id: c.id, name: c.name, category: c.category as CostCategory, clinicId: c.clinicId, clinicName, amountCents: c.amountCents,
    startMonth: c.startMonth, endMonth: c.endMonth, note: c.note, createdBy: by, updatedAt: c.updatedAt,
  }));
}

export interface CostInput {
  id?: number | null;
  name: string;
  category: CostCategory;
  clinicId: number | null;
  amountCents: number;
  startMonth: string;
  endMonth: string | null;
  note?: string | null;
}

/** Add a monthly cost, or change one (id). */
export async function saveCost(actor: WorkspaceActor, input: CostInput) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new WorkspaceError("Give the cost a name, e.g. Rent.");
  if (!(COST_CATEGORIES as readonly string[]).includes(input.category)) throw new WorkspaceError("Pick a kind of cost.");
  if (!isMonth(input.startMonth)) throw new WorkspaceError("Pick the month it starts.");
  if (input.endMonth && (!isMonth(input.endMonth) || input.endMonth < input.startMonth)) throw new WorkspaceError("The last month can't be before the first.");
  if (input.amountCents <= 0) throw new WorkspaceError("Enter the amount per month.");
  if (input.amountCents > 100_000_000) throw new WorkspaceError("That amount looks too high for one month.");
  const d = await db();
  if (input.clinicId) {
    const [c] = await d.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, input.clinicId)).limit(1);
    if (!c) throw new WorkspaceError("That clinic wasn't found.", "NOT_FOUND");
  }
  const values = {
    name, category: input.category, clinicId: input.clinicId ?? null, amountCents: input.amountCents,
    startMonth: input.startMonth, endMonth: input.endMonth || null, note: input.note?.trim() ? input.note.trim().slice(0, 255) : null,
  };
  let id = input.id ?? null;
  if (id) {
    const [old] = await d.select({ id: practiceCosts.id }).from(practiceCosts).where(eq(practiceCosts.id, id)).limit(1);
    if (!old) throw new WorkspaceError("That cost wasn't found.", "NOT_FOUND");
    await d.update(practiceCosts).set(values).where(eq(practiceCosts.id, id));
  } else {
    const [res] = await d.insert(practiceCosts).values({ ...values, createdByUserId: actor.id });
    id = Number((res as { insertId?: number }).insertId ?? 0) || null;
  }
  await audit(actor, "set_cost", { entityType: "practiceCost", entityId: id ?? undefined, description: `${input.id ? "Changed" : "Added"} the monthly cost "${name}" from ${input.startMonth}` });
  return { ok: true, id };
}

export async function removeCost(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [c] = await d.select({ id: practiceCosts.id, name: practiceCosts.name }).from(practiceCosts).where(eq(practiceCosts.id, id)).limit(1);
  if (!c) throw new WorkspaceError("That cost wasn't found.", "NOT_FOUND");
  await d.delete(practiceCosts).where(eq(practiceCosts.id, id));
  await audit(actor, "set_cost", { entityType: "practiceCost", entityId: id, description: `Removed the monthly cost "${c.name}"` });
  return { ok: true };
}

/**
 * The Costs tab: the cost list, money in vs. out for each month from October 2026 to now, and each clinic's
 * insurance payments next to its costs over those months.
 */
export async function costsReport(actor: WorkspaceActor) {
  const d = await db();
  const today = localDateStr();
  const thisMonth = today.slice(0, 7);
  const months = monthsBetween(FIRST_MONEY_MONTH, thisMonth);
  const from = `${months[0]}-01`, to = lastDayOf(months.at(-1)!);
  const [costs, clinicRows, paidRows, zocRows] = await Promise.all([
    listCosts(),
    d.select({ id: clinics.id, name: clinics.name, address: clinics.address }).from(clinics).orderBy(asc(clinics.name)),
    // Insurance payments by payment date, like the Summary tab with "by payment date".
    d.select({ date: billClaims.lastPaidDate, clinicId: billClaims.clinicId, paid: sql<number>`SUM(${billLines.paidCents})` })
      .from(billLines).innerJoin(billClaims, eq(billClaims.id, billLines.claimId))
      .where(and(isNull(billClaims.supersededBy), gte(billClaims.lastPaidDate, from), lte(billClaims.lastPaidDate, to)))
      .groupBy(billClaims.lastPaidDate, billClaims.clinicId),
    // ZocDoc charges by appointment date, like the ZocDoc tab, with ZocDoc's location for each.
    d.select({ date: zocdocBookings.appointmentDate, location: zocdocBookings.locationName, cost: sql<number>`SUM(${zocdocBookings.costCents})` }).from(zocdocBookings)
      .where(and(gte(zocdocBookings.appointmentDate, from), lte(zocdocBookings.appointmentDate, to))).groupBy(zocdocBookings.appointmentDate, zocdocBookings.locationName),
  ]);

  // Everything by month and clinic ("" = not tied to a clinic).
  type Cell = { insuranceCents: number; staffPayCents: number; providerPayCents: number; costsCents: number; zocdocCents: number };
  const cells = new Map<string, Cell>();
  const cell = (month: string, clinicId: number | null) => {
    const k = `${month}|${clinicId ?? ""}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { insuranceCents: 0, staffPayCents: 0, providerPayCents: 0, costsCents: 0, zocdocCents: 0 }));
    return c;
  };
  const known = new Set(clinicRows.map((c) => c.id));
  const clinicKey = (id: number | null | undefined) => (id != null && known.has(id) ? id : null);
  const insurance = new Map<string, number>(), zocdoc = new Map<string, number>();
  for (const r of paidRows) {
    if (!r.date) continue;
    const m = r.date.slice(0, 7), cents = Number(r.paid ?? 0);
    insurance.set(m, (insurance.get(m) ?? 0) + cents);
    cell(m, clinicKey(r.clinicId)).insuranceCents += cents;
  }
  // ZocDoc's location names, matched to our clinics by name or street.
  const locations = new Map<string, { location: string | null; clinicId: number | null; cents: number }>();
  for (const r of zocRows) {
    const m = r.date.slice(0, 7), cents = Number(r.cost ?? 0);
    zocdoc.set(m, (zocdoc.get(m) ?? 0) + cents);
    const clinic = matchClinic(r.location, clinicRows);
    cell(m, clinic?.id ?? null).zocdocCents += cents;
    const lk = r.location ?? "";
    const l = locations.get(lk) ?? { location: r.location, clinicId: clinic?.id ?? null, cents: 0 };
    locations.set(lk, l);
    l.cents += cents;
  }
  const costMonths = costsByMonth(costs, months);
  for (const m of months) for (const c of costs) if (costInMonth(c, m)) cell(m, clinicKey(c.clinicId)).costsCents += c.amountCents;
  // Payroll per month (estimate), split by clinic: staff by where they clocked in, providers by where they saw
  // patients, per-CCM pay by each patient's clinic. The month in progress uses pay so far.
  const pay = new Map<string, number>();
  for (const m of months) {
    const p = await payroll(actor, { view: "month", month: m }, { audit: false });
    pay.set(m, p.totals.soFar.totalCents);
    for (const r of p.rows) for (const s of r.clinicSplit) {
      const c = cell(m, clinicKey(s.clinicId));
      if (r.isProvider) c.providerPayCents += s.cents; else c.staffPayCents += s.cents;
    }
  }
  const rows = months.map((m) => moneyMonth({
    month: m, insuranceCents: insurance.get(m) ?? 0, payrollCents: pay.get(m) ?? 0, costsCents: costMonths.get(m) ?? 0, zocdocCents: zocdoc.get(m) ?? 0, inProgress: m === thisMonth,
  }));
  const places = [...clinicRows.map((c) => ({ key: String(c.id), id: c.id as number | null, name: c.name })), { key: "", id: null, name: "Not tied to a clinic" }];
  const clinicMonths = months.map((m) => ({
    month: m, inProgress: m === thisMonth,
    clinics: places.map((p) => ({ key: p.key, name: p.name, ...(cells.get(`${m}|${p.key}`) ?? { insuranceCents: 0, staffPayCents: 0, providerPayCents: 0, costsCents: 0, zocdocCents: 0 }) })),
  }));
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const zocdocLocations = Array.from(locations.values()).sort((a, b) => b.cents - a.cents)
    .map((l) => ({ location: l.location, clinicName: l.clinicId ? clinicName.get(l.clinicId) ?? null : null, cents: l.cents }));
  const [latest] = await d.select({ last: sql<string | null>`MAX(${billClaims.lastPaidDate})` }).from(billClaims).where(isNull(billClaims.supersededBy));
  await audit(actor, "view_costs", { entityType: "practiceCosts", description: `Costs and money in vs. out ${months[0]} to ${thisMonth}` });
  return {
    today, months, costs, clinics: clinicRows.map((c) => ({ id: c.id, name: c.name })), rows, clinicMonths, zocdocLocations,
    monthlyNowCents: costs.filter((c) => costInMonth(c, thisMonth)).reduce((s, c) => s + c.amountCents, 0),
    latestPaymentDate: latest?.last ?? null,
  };
}
