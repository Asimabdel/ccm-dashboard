import { describe, expect, it } from "vitest";
import { checkClockLocation, clockCheckLabel, distanceM, fmtDistance, type ClinicPlace } from "../shared/clockLocation";

// Two clinics ~10 km apart (fictional coordinates in west Houston).
const katy: ClinicPlace = { id: 1, name: "Katy", lat: 29.7858, lng: -95.8245, radiusM: null, networks: ["203.0.113.10"] };
const cypress: ClinicPlace = { id: 2, name: "Cypress", lat: 29.9691, lng: -95.6972, radiusM: 300, networks: [] };
const notSetUp: ClinicPlace = { id: 3, name: "New clinic", lat: null, lng: null, radiusM: null, networks: [] };
const clinics = [katy, cypress, notSetUp];
const at = (lat: number, lng: number, accuracy = 20) => ({ lat, lng, accuracy });

describe("clock-in location", () => {
  it("measures distance", () => {
    expect(distanceM({ lat: 29.7858, lng: -95.8245 }, { lat: 29.7858, lng: -95.8245 })).toBe(0);
    expect(distanceM(katy as { lat: number; lng: number }, cypress as { lat: number; lng: number })).toBeGreaterThan(20_000);
    expect(fmtDistance(350)).toBe("350 m");
    expect(fmtDistance(1234)).toBe("1.2 km");
  });

  it("the clinic's internet counts as at the clinic, even with no location", () => {
    expect(checkClockLocation({ clinicId: 1, remote: false, clinics, ip: "::ffff:203.0.113.10", position: null })).toMatchObject({ check: "at_clinic", method: "network" });
  });

  it("device location within the radius (plus some of its accuracy) is at the clinic", () => {
    expect(checkClockLocation({ clinicId: 1, remote: false, clinics, ip: "198.51.100.7", position: at(29.7860, -95.8247) }).check).toBe("at_clinic");
    // ~450 m away with a 200 m-accurate reading: 450 − 200 ≤ 300.
    expect(checkClockLocation({ clinicId: 1, remote: false, clinics, ip: null, position: at(29.7898, -95.8245, 250) }).check).toBe("at_clinic");
  });

  it("far away is flagged with the distance; at another clinic says which", () => {
    const away = checkClockLocation({ clinicId: 1, remote: false, clinics, ip: null, position: at(29.76, -95.37) });
    expect(away.check).toBe("away");
    expect(away.distanceM).toBeGreaterThan(40_000);
    const other = checkClockLocation({ clinicId: 1, remote: false, clinics, ip: null, position: at(29.9690, -95.6970) });
    expect(other).toMatchObject({ check: "other_clinic", nearClinicId: 2 });
    expect(clockCheckLabel(other.check, other.distanceM, "Cypress", "Katy")).toBe("at Cypress, not Katy");
  });

  it("no location and not on the clinic's internet: unknown (clocking in then needs location on)", () => {
    expect(checkClockLocation({ clinicId: 1, remote: false, clinics, ip: "198.51.100.7", position: null }).check).toBe("unknown");
  });

  it("remote shifts and clinics not set up aren't checked", () => {
    expect(checkClockLocation({ clinicId: null, remote: true, clinics, ip: null, position: null }).check).toBe("remote");
    expect(checkClockLocation({ clinicId: 3, remote: false, clinics, ip: null, position: null }).check).toBe("not_checked");
    expect(checkClockLocation({ clinicId: null, remote: false, clinics, ip: null, position: null }).check).toBe("not_checked");
  });
});
