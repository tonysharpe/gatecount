/** The flow chart counts; it never estimates. Each bar is the crossings of one
 * fixed five-second slot, the newest slot is the one still filling, and the
 * figure beside the chart is the number of crossings in the last minute -- in
 * the first minute, simply all of them. */

import { describe, expect, test } from "vitest";

import { FLOW_BINS, FLOW_BIN_S, FLOW_WINDOW_S, flowBins, inLast, pruneFlow } from "./flow";

describe("flowBins", () => {
  test("puts each crossing in its own five-second slot, newest slot last", () => {
    const bins = flowBins([0.5, 1, 4.9, 5, 58.2, 59.9], 59.95);
    expect(bins).toHaveLength(FLOW_BINS);
    expect(bins[0]).toBe(3);
    expect(bins[1]).toBe(1);
    expect(bins[FLOW_BINS - 1]).toBe(2);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(6);
  });

  test("keeps a finished bar the same height as time moves on", () => {
    const times = [61, 62, 63];
    // Two moments inside the same next slot: the slot of the crossings has
    // moved one place left and has not changed.
    const a = flowBins(times, 65.2);
    const b = flowBins(times, 69.9);
    expect(a).toEqual(b);
    expect(a[FLOW_BINS - 2]).toBe(3);
    expect(a[FLOW_BINS - 1]).toBe(0);
  });

  test("forgets what is older than the chart and ignores what has not happened", () => {
    const now = 200;
    const bins = flowBins([now - FLOW_WINDOW_S - 1, now - 1, now + 3, Number.NaN], now);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test("is an empty chart, not a guessed one, before anything has crossed", () => {
    expect(flowBins([], 12)).toEqual(new Array(FLOW_BINS).fill(0));
    expect(flowBins([3], Number.NaN)).toEqual(new Array(FLOW_BINS).fill(0));
  });
});

describe("inLast", () => {
  test("counts the crossings of the last sixty seconds, and only those", () => {
    expect(inLast([1, 2, 3], 3)).toBe(3);
    // The window is (now - 60, now]: exactly sixty seconds ago is out, now
    // is in, and a crossing stamped after now is not yet.
    expect(inLast([10, 10.01, 69.9, 70, 70.5], 70)).toBe(3);
    expect(inLast([10, 11], 75)).toBe(0);
  });
});

describe("pruneFlow", () => {
  test("drops only what no chart will draw again", () => {
    const now = 300;
    const keep = FLOW_WINDOW_S + FLOW_BIN_S;
    const times = [now - keep - 2, now - keep, now - keep + 0.5, now - 1];
    expect(pruneFlow(times, now)).toEqual([now - keep + 0.5, now - 1]);
  });

  test("returns the same list when there is nothing to drop", () => {
    const times = [290, 299];
    expect(pruneFlow(times, 300)).toBe(times);
  });
});
