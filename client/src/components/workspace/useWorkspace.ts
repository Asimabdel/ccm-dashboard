import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

const CLINIC_KEY = "ws.clinicId";
const CLINIC_EVENT = "ws-clinic-change";
const NO_CLINICS: { id: number; name: string; location: string }[] = [];

function readClinic(): number | null {
  try {
    const v = localStorage.getItem(CLINIC_KEY);
    return v ? Number(v) || null : null;
  } catch {
    return null;
  }
}

/** The clinic chosen in the header selector (null = all clinics), shared across pages. */
export function useClinic(): [number | null, (id: number | null) => void] {
  const [clinicId, setState] = useState<number | null>(readClinic);
  useEffect(() => {
    const on = () => setState(readClinic());
    window.addEventListener(CLINIC_EVENT, on);
    return () => window.removeEventListener(CLINIC_EVENT, on);
  }, []);
  const set = useCallback((id: number | null) => {
    try {
      if (id) localStorage.setItem(CLINIC_KEY, String(id));
      else localStorage.removeItem(CLINIC_KEY);
    } catch {
      /* storage unavailable: keep in memory only */
    }
    setState(id);
    window.dispatchEvent(new Event(CLINIC_EVENT));
  }, []);
  return [clinicId, set];
}

/** Capabilities + selectable clinics for the signed-in user. */
export function useWorkspace() {
  const { user } = useAuth();
  const q = trpc.workspace.context.useQuery(undefined, { enabled: !!user, staleTime: 60_000 });
  const [clinicId, setClinicId] = useClinic();
  const clinics = q.data?.clinics ?? NO_CLINICS;
  // Drop a stored clinic the user can no longer see.
  const effectiveClinic = clinicId && (q.isLoading || clinics.some((c) => c.id === clinicId)) ? clinicId : null;
  return {
    user,
    loading: q.isLoading,
    caps: q.data?.caps,
    clinics,
    limitedToClinics: q.data?.limitedToClinics ?? false,
    noClinicAccess: q.data?.noClinicAccess ?? false,
    clinicId: effectiveClinic,
    setClinicId,
  };
}

/** Read/write URL query params (filters live in the URL so views can be linked and reloaded). */
export function useUrlParams(): [URLSearchParams, (patch: Record<string, string | number | null | undefined>) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback(
    (patch: Record<string, string | number | null | undefined>) => {
      const next = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      const qs = next.toString();
      navigate(qs ? `${location}?${qs}` : location, { replace: true });
    },
    [search, location, navigate],
  );
  return [params, set];
}
