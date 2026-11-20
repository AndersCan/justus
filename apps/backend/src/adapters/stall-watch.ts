const TICK_MS = 1000;
const STALL_MS = 5000;

/** Calls `onStall` when the process was frozen (a paused phone, a sleeping laptop): a timer meant for `TICK_MS` fires far later. */
export function watchStalls(
  now: () => number,
  onStall: () => void,
  opts: { tickMs?: number; stallMs?: number } = {},
): { stop(): void } {
  const tickMs = opts.tickMs ?? TICK_MS;
  const stallMs = opts.stallMs ?? STALL_MS;
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - tickMs;
    last = at;
    if (late > stallMs) onStall();
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
