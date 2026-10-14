// The device's location for a clock in / out (2026-10-14): asked only at that moment, sent once, never stored by
// MyPCP (the server keeps only "at the clinic / away" and the distance). Resolves null when the person says no,
// the device can't tell, or it takes too long; clocking in then works only on the clinic's internet.

export interface ClockPosition { lat: number; lng: number; accuracy: number }

export function getClockPosition(timeoutMs = 10_000): Promise<ClockPosition | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: ClockPosition | null) => { if (!done) { done = true; resolve(v); } };
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => finish(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
    setTimeout(() => finish(null), timeoutMs + 1500);
  });
}

/** A friendly note after a clock in that wasn't at the clinic (allowed; the manager sees it). */
export function awayNote(r: { check?: string; clinicName?: string | null }): string | null {
  if (r.check === "away") return `You don't seem to be at ${r.clinicName ?? "your clinic"}, so your manager will see this clock-in.`;
  if (r.check === "other_clinic") return `You're at a different clinic than you're scheduled for${r.clinicName ? ` (${r.clinicName})` : ""}, so your manager will see this clock-in.`;
  return null;
}
