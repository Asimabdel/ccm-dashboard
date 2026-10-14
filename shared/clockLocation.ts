// Where someone clocked in / out (2026-10-14, the practice's choices): at the clinic if the device's location is
// within the clinic's radius (default 300 m) OR they're on the clinic's internet connection. Away from the clinic
// is allowed but flagged for the manager; clocking IN needs location turned on (unless on the clinic's internet).
// Remote shifts and clinics not set up yet aren't checked. Only the result and the distance are kept, never the
// coordinates or the internet address of the person.

export const DEFAULT_CLOCK_RADIUS_M = 300;
/** How much of a reading's uncertainty we give the benefit of the doubt (a desktop's Wi-Fi location can be loose). */
export const MAX_ACCURACY_ALLOWANCE_M = 200;

export type ClockCheck = "at_clinic" | "other_clinic" | "away" | "unknown" | "remote" | "not_checked";

export interface ClinicPlace { id: number; name: string; lat: number | null; lng: number | null; radiusM: number | null; networks: string[] }
export interface DevicePosition { lat: number; lng: number; accuracy: number }

/** Metres between two points (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** A clinic is set up for the check once it has a location or an internet connection on file. */
export const isSetUp = (c: ClinicPlace) => (c.lat != null && c.lng != null) || c.networks.length > 0;

/** Normalise an internet address as the server sees it ("::ffff:1.2.3.4" → "1.2.3.4"). */
export const normalizeIp = (ip: string | null | undefined) => (ip ?? "").trim().replace(/^::ffff:/i, "").toLowerCase();

export interface ClockLocationResult { check: ClockCheck; distanceM: number | null; nearClinicId: number | null; method: "network" | "location" | null }

/**
 * Where a punch happened. `clinicId` is where they're scheduled (null with `remote` = a remote shift).
 * The clinic's internet wins; else the device location (distance minus up to 200 m of its stated accuracy).
 */
export function checkClockLocation(input: { clinicId: number | null; remote: boolean; clinics: ClinicPlace[]; ip: string | null; position: DevicePosition | null }): ClockLocationResult {
  const none = (check: ClockCheck): ClockLocationResult => ({ check, distanceM: null, nearClinicId: null, method: null });
  if (input.remote) return none("remote");
  const home = input.clinics.find((c) => c.id === input.clinicId);
  if (!home || !isSetUp(home)) return none("not_checked");
  const ip = normalizeIp(input.ip);
  const onNetwork = (c: ClinicPlace) => !!ip && c.networks.map(normalizeIp).includes(ip);
  if (onNetwork(home)) return { check: "at_clinic", distanceM: null, nearClinicId: home.id, method: "network" };
  const other = input.clinics.find((c) => c.id !== home.id && onNetwork(c));
  if (other) return { check: "other_clinic", distanceM: null, nearClinicId: other.id, method: "network" };
  const pos = input.position;
  if (!pos) return none("unknown");
  const allowance = Math.min(Math.max(pos.accuracy, 0), MAX_ACCURACY_ALLOWANCE_M);
  const within = (c: ClinicPlace) => c.lat != null && c.lng != null && distanceM(pos, { lat: c.lat, lng: c.lng }) - allowance <= (c.radiusM ?? DEFAULT_CLOCK_RADIUS_M);
  const homeDistance = home.lat != null && home.lng != null ? distanceM(pos, { lat: home.lat, lng: home.lng }) : null;
  if (within(home)) return { check: "at_clinic", distanceM: homeDistance, nearClinicId: home.id, method: "location" };
  const near = input.clinics.find((c) => c.id !== home.id && within(c));
  if (near) return { check: "other_clinic", distanceM: homeDistance, nearClinicId: near.id, method: "location" };
  // The clinic only has an internet connection on file and they're not on it: we can't measure, so it's away.
  return { check: "away", distanceM: homeDistance, nearClinicId: null, method: "location" };
}

/** "1.2 km" / "350 m". */
export function fmtDistance(m: number | null | undefined): string {
  if (m == null) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${m} m`;
}

/** What a punch's check means, in a few words for timesheets. */
export function clockCheckLabel(check: string | null | undefined, distance: number | null | undefined, nearClinic?: string | null, home?: string | null): string | null {
  if (check === "away") return `away from ${home ?? "the clinic"}${distance != null ? ` (${fmtDistance(distance)})` : ""}`;
  if (check === "other_clinic") return `at ${nearClinic ?? "another clinic"}${home ? `, not ${home}` : ""}`;
  if (check === "unknown") return "location not shared";
  return null;
}
