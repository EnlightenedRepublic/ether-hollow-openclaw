import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Visit, beatIsFatal, clampMinutes } from "../src/visit.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("clampMinutes: the default when unsaid, a day at most, never zero", () => {
  expect(clampMinutes(undefined)).toBe(60);
  expect(clampMinutes(undefined, 15)).toBe(15);
  expect(clampMinutes(0)).toBe(60);
  expect(clampMinutes(-5)).toBe(60);
  expect(clampMinutes("30")).toBe(30);
  expect(clampMinutes(99999)).toBe(1440);
  expect(clampMinutes(0.4)).toBe(1);
});

test("beatIsFatal: the town said no for good", () => {
  expect([401, 403, 423].every(beatIsFatal)).toBe(true);
  expect([429, 500, 502, 503].some(beatIsFatal)).toBe(false);
});

test("a visit beats every 10 s, extends, and ends on its clock", async () => {
  const beats: number[] = [];
  const visit = new Visit(async () => {
    beats.push(Date.now());
    return { status: 200, value: { ok: true } };
  });
  expect(visit.inTown).toBe(false);
  const s = visit.start(1);
  expect(s.inTown).toBe(true);
  expect(Date.parse(s.until!) - Date.parse(s.since!)).toBe(60_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(beats).toHaveLength(3);
  expect(visit.state().beats).toBe(3);
  expect(visit.state().lastOk).toBeDefined();
  // `here` again: longer, same visit.
  visit.start(2);
  expect(visit.state().since).toBe(s.since);
  await vi.advanceTimersByTimeAsync(130_000);
  expect(visit.inTown).toBe(false);
  // Beats stop with the visit.
  const n = beats.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(beats).toHaveLength(n);
  expect(visit.state().until).toBeUndefined();
});

test("a 423 from a beat ends the visit; a 503 keeps trying; an unreachable town keeps trying", async () => {
  let status = 503;
  let fail = false;
  const visit = new Visit(async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return { status, value: {} };
  });
  visit.start(60);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(visit.inTown).toBe(true);
  expect(visit.state().lastError).toBe("the town answered 503");
  fail = true;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(visit.inTown).toBe(true);
  expect(visit.state().lastError).toMatch(/could not reach the town: ECONNREFUSED/);
  fail = false;
  status = 423;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(visit.inTown).toBe(false);
  expect(visit.state().lastError).toBe("the town answered 423");
});

test("stop() ends a visit at once", () => {
  const visit = new Visit(async () => ({ status: 200, value: {} }));
  visit.start(5);
  expect(visit.stop().inTown).toBe(false);
  expect(visit.stop().inTown).toBe(false);
});
