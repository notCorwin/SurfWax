import { useEffect, useRef, useState } from "react";

const listeners = new Set<(now: number) => void>();
let frame: number | undefined;
function tick() {
  frame = undefined;
  const now = Date.now();
  for (const listener of listeners) listener(now);
  if (listeners.size) frame = requestAnimationFrame(tick);
}
function subscribe(listener: (now: number) => void) {
  listeners.add(listener);
  listener(Date.now());
  if (frame === undefined) frame = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
}

/** Share one paint clock, subscribing only while a running row is visible. */
export function useActivityClock<T extends HTMLElement>(running: boolean, startedAt?: number) {
  const ref = useRef<T>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt === undefined || !ref.current) return;
    let unsubscribe: (() => void) | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) unsubscribe ??= subscribe(setNow);
      else { unsubscribe?.(); unsubscribe = undefined; }
    });
    observer.observe(ref.current);
    return () => { observer.disconnect(); unsubscribe?.(); };
  }, [running, startedAt]);
  return { now, ref };
}

const countdownListeners = new Set<(now: number) => void>();
let countdownTimer: ReturnType<typeof setInterval> | undefined;
function subscribeCountdown(listener: (now: number) => void) {
  countdownListeners.add(listener);
  countdownTimer ??= setInterval(() => {
    const now = Date.now();
    for (const update of countdownListeners) update(now);
  }, 1000);
  return () => {
    countdownListeners.delete(listener);
    if (!countdownListeners.size) { clearInterval(countdownTimer); countdownTimer = undefined; }
  };
}

/** One low-frequency clock for active backoff rows; stop at expiry or unmount. */
export function useRetryCountdown(until?: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === undefined || until <= Date.now()) return;
    setNow(Date.now());
    const unsubscribe = subscribeCountdown(time => {
      setNow(time);
      if (time >= until) unsubscribe();
    });
    return unsubscribe;
  }, [until]);
  return until === undefined ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}
