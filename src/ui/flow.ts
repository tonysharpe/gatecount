/** Traffic flow: how many vehicles crossed the line, and when.
 *
 * Flow -- vehicles per unit time past a point -- is the figure a traffic
 * counter exists to produce, so the readout shows it as it builds: one bar per
 * five seconds over the last minute, the newest still filling, and beside it
 * the count of the last sixty seconds. The count is a count, never a rate
 * extrapolated from a few seconds: in the first minute it is simply every
 * crossing so far, which is what "the last minute" then contains.
 *
 * Times are the session's own seconds, which keep running when a clip loops
 * back to its start; see `ControlRoom`. */

export const FLOW_BIN_S = 5;
export const FLOW_BINS = 12;
export const FLOW_WINDOW_S = FLOW_BIN_S * FLOW_BINS;

/** Crossings per bin, oldest first; the last bin is the one `now` falls in,
 * still filling. Bins are aligned to whole multiples of the bin width, so a
 * bar does not change once its five seconds are over. */
export function flowBins(
  times: readonly number[],
  now: number,
  binS: number = FLOW_BIN_S,
  bins: number = FLOW_BINS,
): number[] {
  const out = new Array<number>(bins).fill(0);
  if (!Number.isFinite(now)) {
    return out;
  }
  const current = Math.floor(now / binS);
  for (const time of times) {
    if (!Number.isFinite(time) || time > now) {
      continue;
    }
    const index = bins - 1 - (current - Math.floor(time / binS));
    if (index >= 0 && index < bins) {
      out[index] = (out[index] as number) + 1;
    }
  }
  return out;
}

/** Crossings in the `window` seconds up to and including `now`. */
export function inLast(times: readonly number[], now: number, window: number = FLOW_WINDOW_S): number {
  let count = 0;
  for (const time of times) {
    if (time <= now && time > now - window) {
      count += 1;
    }
  }
  return count;
}

/** Drop what no chart will draw again, keeping the list short on a long
 * session. */
export function pruneFlow(times: number[], now: number, keepS: number = FLOW_WINDOW_S + FLOW_BIN_S): number[] {
  const cutoff = now - keepS;
  let first = 0;
  while (first < times.length && (times[first] as number) <= cutoff) {
    first += 1;
  }
  return first === 0 ? times : times.slice(first);
}
