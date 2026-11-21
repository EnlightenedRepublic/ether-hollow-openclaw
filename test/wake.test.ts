import { expect, test } from "vitest";

import { dueSecs, mentions, newSeen, pollMs, reasonText, triggers, wakePrompt } from "../src/wake.js";

const NOW = Math.floor(Date.parse("2026-11-20T12:00:00Z") / 1000);

test("mentions: whole words only, any case, with @ and punctuation", () => {
  expect(mentions("Moss", "hey @moss, you around?")).toBe(true);
  expect(mentions("Moss", "MOSS!")).toBe(true);
  expect(mentions("Moss", "the mossy bank")).toBe(false);
  expect(mentions("Moss", "")).toBe(false);
  expect(mentions("", "moss")).toBe(false);
  expect(mentions("Moss Robot", "moss robot was here")).toBe(true);
});

test("dueSecs: a month, a day, a timestamp, junk", () => {
  expect(dueSecs("2026-12")).toBe(Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000));
  expect(dueSecs("2026-12-01")).toBe(Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000));
  expect(dueSecs("2026-12-01T09:00:00Z")).toBe(Math.floor(Date.parse("2026-12-01T09:00:00Z") / 1000));
  expect(dueSecs("soon")).toBeUndefined();
  expect(dueSecs("")).toBeUndefined();
});

test("the first read primes and wakes for nothing; the second wakes for what is new", () => {
  const seen = newSeen();
  const town = { feed: [{ id: "p1", who: "Gion", text: "Moss, your print is ready" }] };
  expect(triggers(seen, "Moss", { agent: { name: "Moss" } }, town, { orders: [{ id: "o1", status: "open" }] }, NOW)).toEqual([]);
  expect(seen.primed).toBe(true);
  // Nothing new: nothing.
  expect(triggers(seen, "Moss", { agent: { name: "Moss" } }, town, { orders: [{ id: "o1", status: "open" }] }, NOW)).toEqual([]);
  // A new mention and a new order.
  const town2 = { feed: [...town.feed, { id: "p2", who: "Gray", text: "has anyone seen @moss today?" }, { id: "p3", who: "Moss", text: "Moss here, hello" }, { id: "p4", who: "Wren", text: "mossy rocks" }] };
  const out = triggers(seen, "Moss", { agent: { name: "Moss" } }, town2, { orders: [{ id: "o1", status: "open" }, { id: "o2", status: "paid" }, { id: "o3", status: "done" }] }, NOW);
  expect(out).toEqual([
    { kind: "mention", id: "p2", who: "Gray", text: "has anyone seen @moss today?" },
    { kind: "order", id: "o2" },
  ]);
  expect(reasonText(out)).toBe('Gray named you on the feed: "has anyone seen @moss today?"; a new order came in (o2)');
});

test("rent: due soon once per due date, owing, then the missed counter takes over", () => {
  const seen = newSeen();
  const me = (lease: Record<string, unknown> | null) => ({ agent: { name: "Moss" }, lease });
  triggers(seen, "Moss", me(null), {}, {}, NOW);
  // A due date three days out: not yet.
  expect(triggers(seen, "Moss", me({ next_due: "2026-11-24", owing: false }), {}, {}, NOW)).toEqual([]);
  // Within two days: once.
  expect(triggers(seen, "Moss", me({ next_due: "2026-11-21", owing: false }), {}, {}, NOW)).toEqual([{ kind: "rent_due", due: "2026-11-21", owing: false }]);
  expect(triggers(seen, "Moss", me({ next_due: "2026-11-21", owing: false }), {}, {}, NOW)).toEqual([]);
  // Owing, same date: already said.
  expect(triggers(seen, "Moss", me({ next_due: "2026-11-21", owing: true }), {}, {}, NOW)).toEqual([]);
  // The town counts a missed payment: that wins, with the repossession date.
  expect(triggers(seen, "Moss", me({ next_due: "2026-12-01", owing: true, missed: 1, repossess_on: "2027-03-01" }), {}, {}, NOW)).toEqual([
    { kind: "missed", missed: 1, repossessOn: "2027-03-01" },
  ]);
  expect(triggers(seen, "Moss", me({ next_due: "2026-12-01", owing: true, missed: 1, repossess_on: "2027-03-01" }), {}, {}, NOW)).toEqual([]);
  expect(triggers(seen, "Moss", me({ next_due: "2027-01-01", owing: true, missed: 2, repossess_on: "2027-03-01" }), {}, {}, NOW)).toEqual([
    { kind: "missed", missed: 2, repossessOn: "2027-03-01" },
  ]);
  // Paid: the counter drops quietly.
  expect(triggers(seen, "Moss", me({ next_due: "2027-02-01", owing: false, missed: 0 }), {}, {}, NOW)).toEqual([]);
  expect(seen.missed).toBe(0);
});

test("reset and timeout: once each, cleared when the town clears them", () => {
  const seen = newSeen();
  triggers(seen, "Moss", { agent: { name: "Moss" } }, {}, {}, NOW);
  expect(triggers(seen, "Moss", { agent: { name: "Moss", reset_on: "2027-02-18" }, timeout: { until: "2026-11-20T13:00:00Z" } }, {}, {}, NOW)).toEqual([
    { kind: "reset", on: "2027-02-18" },
    { kind: "timeout", until: "2026-11-20T13:00:00Z" },
  ]);
  expect(triggers(seen, "Moss", { agent: { name: "Moss", reset_on: "2027-02-18" }, timeout: { until: "2026-11-20T13:00:00Z" } }, {}, {}, NOW)).toEqual([]);
  expect(triggers(seen, "Moss", { agent: { name: "Moss" }, timeout: null }, {}, {}, NOW)).toEqual([]);
  expect(seen.resetOn).toBeUndefined();
  expect(seen.inTimeout).toBe(false);
  expect(triggers(seen, "Moss", { agent: { name: "Moss" }, timeout: { minutes_left: 30 } }, {}, {}, NOW)).toEqual([{ kind: "timeout", until: "30" }]);
});

test("the words: the reasons and the prompt", () => {
  const reason = reasonText([
    { kind: "mention", id: "x", who: "", text: "moss?" },
    { kind: "rent_due", due: "2026-12-01", owing: true },
    { kind: "missed", missed: 3, repossessOn: "" },
    { kind: "reset", on: "2027-02-18" },
    { kind: "timeout", until: "14:00" },
  ]);
  expect(reason).toBe(
    'a feed post names you: "moss?"; your rent is owing (due 2026-12-01); the town could not take your rent (3 missed); the town counts you inactive and will reset you on 2027-02-18 unless you do something there; the town put you in a timeout (until 14:00)',
  );
  const prompt = wakePrompt("Moss", reason);
  expect(prompt.startsWith("[Ether Hollow] Something happened in town that concerns you, Moss: ")).toBe(true);
  expect(prompt).toContain("ether_hollow tool");
  expect(prompt.endsWith("answer HEARTBEAT_OK.")).toBe(true);
});

test("pollMs: a minute in town, two away, the knob shortens both", () => {
  expect(pollMs(true)).toBe(60_000);
  expect(pollMs(false)).toBe(120_000);
  expect(pollMs(true, 2)).toBe(2000);
  expect(pollMs(false, 2)).toBe(2000);
});
