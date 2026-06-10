import { useEffect, useRef, useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";

/**
 * HIPAA-oriented idle session timeout.
 * Automatically logs the user out after a period of inactivity, with a
 * warning countdown beforehand. Default: 15 min idle, 60s warning.
 */
export function useIdleLogout(opts?: { idleMs?: number; warnMs?: number; enabled?: boolean }) {
  const idleMs = opts?.idleMs ?? 15 * 60 * 1000;
  const warnMs = opts?.warnMs ?? 60 * 1000;
  const enabled = opts?.enabled ?? true;

  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.floor(warnMs / 1000));
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdown = useRef<ReturnType<typeof setInterval> | null>(null);

  const logout = trpc.auth.logout.useMutation({
    onSettled: () => {
      window.location.href = "/";
    },
  });

  const clearAll = useCallback(() => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    if (logoutTimer.current) clearTimeout(logoutTimer.current);
    if (countdown.current) clearInterval(countdown.current);
  }, []);

  const reset = useCallback(() => {
    clearAll();
    setWarning(false);
    if (!enabled) return;
    warnTimer.current = setTimeout(() => {
      setWarning(true);
      setSecondsLeft(Math.floor(warnMs / 1000));
      countdown.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
    }, idleMs - warnMs);
    logoutTimer.current = setTimeout(() => {
      logout.mutate();
    }, idleMs);
  }, [clearAll, enabled, idleMs, warnMs, logout]);

  useEffect(() => {
    if (!enabled) return;
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    let throttle = false;
    const onActivity = () => {
      if (warning) return; // don't auto-dismiss the warning silently; user must click "stay"
      if (throttle) return;
      throttle = true;
      setTimeout(() => (throttle = false), 1000);
      reset();
    };
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    reset();
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, warning]);

  const stayLoggedIn = useCallback(() => {
    setWarning(false);
    reset();
  }, [reset]);

  const logoutNow = useCallback(() => logout.mutate(), [logout]);

  return { warning, secondsLeft, stayLoggedIn, logoutNow };
}
