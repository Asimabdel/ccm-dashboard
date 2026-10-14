import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, MapPin, Wifi, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { getClockPosition } from "@/lib/clockPosition";
import { DEFAULT_CLOCK_RADIUS_M, isSetUp } from "@shared/clockLocation";
import { btnGhost, inputCls } from "./ui";

/**
 * Workforce → People → Clock-in locations (admins: every clinic; office managers: theirs). Each clinic's place
 * (set while standing there, or typed in) and its internet connections (added while on the clinic's Wi-Fi).
 * Clock-ins there count as at the clinic; elsewhere they're flagged; clinics not set up aren't checked.
 */
export function ClinicPlaces() {
  const q = trpc.workforce.clinicPlaces.list.useQuery();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const done = (msg: string) => { void utils.workforce.clinicPlaces.invalidate(); toast.success(msg); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const setLocation = trpc.workforce.clinicPlaces.setLocation.useMutation({ onSuccess: () => done("Clinic location saved"), onError });
  const addNetwork = trpc.workforce.clinicPlaces.addThisNetwork.useMutation({ onSuccess: () => done("This internet connection now counts as the clinic"), onError });
  const removeNetwork = trpc.workforce.clinicPlaces.removeNetwork.useMutation({ onSuccess: () => done("Removed"), onError });
  const [locating, setLocating] = useState<number | null>(null);
  const [typed, setTyped] = useState<Record<number, string>>({});
  if (q.isLoading || !q.data) return null;
  const clinics = q.data.clinics;
  const ready = clinics.filter(isSetUp).length;

  const setFromHere = async (clinicId: number, radiusM: number | null) => {
    setLocating(clinicId);
    const pos = await getClockPosition(15_000);
    setLocating(null);
    if (!pos) return toast.error("Couldn't get your location. Allow location for mypcpcare.com and try again (or type the coordinates).");
    if (pos.accuracy > 150) toast.warning(`Your device's location is only accurate to about ${pos.accuracy} m. A phone outside the front door gives a better reading.`);
    setLocation.mutate({ clinicId, lat: Number(pos.lat.toFixed(6)), lng: Number(pos.lng.toFixed(6)), radiusM });
  };
  const saveTyped = (clinicId: number, radiusM: number | null) => {
    const m = (typed[clinicId] ?? "").match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return toast.error("Paste the coordinates like 29.7858, -95.8245 (Google Maps: right-click the clinic → the numbers at the top).");
    setLocation.mutate({ clinicId, lat: Number(m[1]), lng: Number(m[2]), radiusM });
  };

  return (
    <div className="mb-5 rounded-3xl border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-5 py-3.5 text-left">
        {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
        <MapPin size={16} className="text-slate-500" />
        <span className="font-semibold text-slate-800">Clock-in locations</span>
        <span className="ml-auto text-xs text-slate-500">{ready === clinics.length ? "All clinics set up" : `${ready} of ${clinics.length} clinics set up`}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-5 py-4">
          <p className="text-xs text-slate-500">
            When someone clocks in or out, MyPCP checks they're at the clinic they're scheduled at: within its radius by their device's location, or on its internet.
            Away is allowed but flagged in <b>Timesheets → Needs fixing</b> and sent to their manager; clocking in needs location turned on unless they're on the clinic's internet.
            Remote shifts, and clinics not set up here, aren't checked. MyPCP keeps only "at the clinic / away" and the distance, not anyone's location.
          </p>
          {clinics.map((c) => (
            <div key={c.id} className="rounded-2xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-slate-800">{c.name}</p>
                {isSetUp(c) ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Checked</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Not set up: not checked</span>}
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Location</p>
                  <p className="text-sm text-slate-700">{c.lat != null && c.lng != null ? <>{c.lat.toFixed(5)}, {c.lng.toFixed(5)} · within {c.radiusM ?? DEFAULT_CLOCK_RADIUS_M} m <a className="ml-1 text-xs text-brand hover:underline" href={`https://www.google.com/maps?q=${c.lat},${c.lng}`} target="_blank" rel="noreferrer">map</a></> : <span className="text-slate-400">Not set</span>}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button type="button" className={`${btnGhost} !px-2.5 !py-1.5 text-xs`} disabled={locating === c.id || setLocation.isPending} onClick={() => void setFromHere(c.id, c.radiusM)}>
                      {locating === c.id ? <Loader2 size={12} className="animate-spin" /> : <MapPin size={12} />} I'm at this clinic: use my location
                    </button>
                    <select className={`${inputCls} !w-auto !py-1.5 text-xs`} value={c.radiusM ?? DEFAULT_CLOCK_RADIUS_M} aria-label="Radius" disabled={c.lat == null}
                      onChange={(e) => setLocation.mutate({ clinicId: c.id, lat: c.lat, lng: c.lng, radiusM: Number(e.target.value) })}>
                      {[150, 300, 500, 800].map((r) => <option key={r} value={r}>within {r} m</option>)}
                    </select>
                  </div>
                  <div className="mt-1.5 flex gap-1.5">
                    <input className={`${inputCls} !py-1.5 text-xs`} placeholder="or paste coordinates, e.g. 29.7858, -95.8245" value={typed[c.id] ?? ""} onChange={(e) => setTyped({ ...typed, [c.id]: e.target.value })} />
                    <button type="button" className={`${btnGhost} !px-2.5 !py-1.5 text-xs`} onClick={() => saveTyped(c.id, c.radiusM)}>Save</button>
                  </div>
                  {c.lat != null && <button type="button" className="mt-1 text-[11px] text-slate-400 hover:text-rose-600" onClick={() => setLocation.mutate({ clinicId: c.id, lat: null, lng: null, radiusM: null })}>Clear location</button>}
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Clinic internet</p>
                  {c.networks.length === 0 && <p className="text-sm text-slate-400">None yet</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {c.networks.map((n) => (
                      <span key={n} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        <Wifi size={11} /> {n}{n === q.data!.yourNetwork && <span className="text-emerald-700"> (you)</span>}
                        <button type="button" aria-label={`Remove ${n}`} className="text-slate-400 hover:text-rose-600" onClick={() => removeNetwork.mutate({ clinicId: c.id, network: n })}><X size={11} /></button>
                      </span>
                    ))}
                  </div>
                  {!c.onThisNetwork && (
                    <button type="button" className={`${btnGhost} mt-1.5 !px-2.5 !py-1.5 text-xs`} disabled={addNetwork.isPending} onClick={() => { if (window.confirm(`Only do this while connected to ${c.name}'s Wi-Fi or network (not your phone's mobile data or home internet). Add this connection${q.data!.yourNetwork ? ` (${q.data!.yourNetwork})` : ""}?`)) addNetwork.mutate({ clinicId: c.id }); }}>
                      <Wifi size={12} /> I'm on this clinic's internet: add it
                    </button>
                  )}
                  {c.onThisNetwork && <p className="mt-1 text-xs text-emerald-700">You're on this clinic's internet now.</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
