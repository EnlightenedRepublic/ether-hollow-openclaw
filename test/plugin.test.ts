import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import plugin, { __stateForTests } from "../src/index.js";
import { KEY, MockTown } from "./mock-town.js";
import { makeMockApi } from "./mock-api.js";

const town = new MockTown();
let url = "";
let dir = "";

beforeAll(async () => {
  url = await town.start();
  dir = mkdtempSync(join(tmpdir(), "ether-hollow-plugin-"));
});
afterAll(async () => {
  await town.stop();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  town.requests = [];
  town.override = undefined;
  town.state.feed = [];
  town.state.orders = [];
});

function setup(cfg: Record<string, unknown>, opts: { cron?: boolean } = {}) {
  const mock = makeMockApi({ enabled: true, config: { url, keyFile: join(dir, "{agentId}.key"), ...cfg } }, opts);
  plugin.register(mock.api as never);
  const state = __stateForTests(mock.api as never)!;
  return { ...mock, state };
}

function keyFor(agent: string, key = KEY) {
  writeFileSync(join(dir, `${agent}.key`), key + "\n", { mode: 0o600 });
}

test("register: one ether_hollow tool, the hooks, a lifecycle, and no key in any log line", () => {
  const { rec, tool } = setup({ agents: ["main"] });
  expect(rec.tools).toHaveLength(1);
  const t = tool({ agentId: "main" });
  expect(t.name).toBe("ether_hollow");
  expect(t.parameters.properties.action.enum).toContain("town");
  expect([...rec.hooks.keys()].sort()).toEqual(["gateway_start", "gateway_stop", "heartbeat_prompt_contribution"]);
  expect(rec.lifecycles).toHaveLength(1);
  expect(rec.logs.join("\n")).not.toContain("ehk_");
});

test("the model never registers; without a key nothing reaches the town", async () => {
  const { tool } = setup({ agents: ["nokey"] });
  const t = tool({ agentId: "nokey" });
  const reg = await t.execute("1", { action: "register", name: "Sneaky" });
  expect(reg.details.error).toMatch(/owner's/);
  const me = await t.execute("2", { action: "me" });
  expect(me.details.error).toMatch(/not a resident of Ether Hollow yet/);
  const none = await t.execute("3", {});
  expect(none.details.error).toMatch(/Missing required parameter 'action'/);
  expect(town.requests).toHaveLength(0);
});

test("with a key: the action goes to the town with the bearer, the answer comes back as JSON; spending stays refused", async () => {
  keyFor("main");
  const { tool, rec } = setup({ agents: ["main"] });
  const t = tool({ sessionKey: "agent:main:telegram:123" });
  const r = await t.execute("1", { action: "town" });
  expect(r.details.error).toBeUndefined();
  expect((r.details.data as { town: string }).town).toBe("Ether Hollow");
  expect(JSON.parse(r.content[0]!.text).places).toHaveLength(3);
  expect(town.requests[0]).toMatchObject({ action: "town", auth: `Bearer ${KEY}` });

  const buy = await t.execute("2", { action: "buy", bay: "bay_gion", item: "print" });
  expect(buy.details.error).toMatch(/spends RC/);
  expect(town.actions()).toEqual(["town"]);

  const move = await t.execute("3", { action: "move", to: "nowhere" });
  expect(move.details.error).toMatch(/no such place.*\(404\)|\(404\).*no such place/);

  expect(rec.logs.join("\n")).not.toContain("ehk_");
  expect(rec.logs.some((l) => l.includes('"action":"town"') && l.includes('"status":200'))).toBe(true);
});

test("spend: true lets buy through to the town (which answers for itself)", async () => {
  keyFor("main");
  const { tool } = setup({ agents: ["main"], spend: true });
  const t = tool({ agentId: "main" });
  const buy = await t.execute("1", { action: "buy", bay: "bay_gion", item: "print" });
  expect(buy.details.error).toMatch(/Not enough RC on the passport \(402\)/);
  expect(town.actions()).toEqual(["buy"]);
});

test("here starts a visit the plugin keeps, leave ends it; the town's refusal ends it too", async () => {
  keyFor("main");
  const { tool, state } = setup({ agents: ["main"], visitMinutes: 15 });
  const t = tool({ agentId: "main" });
  const visit = state.visits.get("main")!;
  const here = await t.execute("1", { action: "here", minutes: 30 });
  expect(here.details.error).toBeUndefined();
  expect(here.content[0]!.text).toMatch(/You are in town until .* call `leave` to go/);
  expect(visit.inTown).toBe(true);
  const until = Date.parse(visit.state().until!) - Date.parse(visit.state().since!);
  expect(until).toBe(30 * 60_000);
  // `minutes` is the plugin's, not the town's.
  expect(town.requests[0]!.body).toEqual({ action: "here" });

  const leave = await t.execute("2", { action: "leave" });
  expect(leave.details.error).toBeUndefined();
  expect(visit.inTown).toBe(false);

  const dflt = await t.execute("3", { action: "here" });
  expect(dflt.details.error).toBeUndefined();
  expect(Date.parse(visit.state().until!) - Date.parse(visit.state().since!)).toBe(15 * 60_000);

  town.override = { status: 423, json: { error: "timeout until 14:00" } };
  const jailed = await t.execute("4", { action: "here" });
  expect(jailed.details.error).toMatch(/Sheriff's cell/);
  expect(visit.inTown).toBe(false);
});

test("several agents: each its own key file and resident; an unknown agent is refused", async () => {
  keyFor("alpha");
  town.keys.add("ehk_" + "c".repeat(32));
  keyFor("beta", "ehk_" + "c".repeat(32));
  const { tool } = setup({ agents: ["alpha", "beta"] });
  await tool({ agentId: "alpha" }).execute("1", { action: "me" });
  await tool({ agentId: "beta" }).execute("2", { action: "me" });
  expect(town.requests.map((r) => r.auth)).toEqual([`Bearer ${KEY}`, `Bearer ehk_${"c".repeat(32)}`]);
  const gamma = await tool({ agentId: "gamma" }).execute("3", { action: "me" });
  expect(gamma.details.error).toMatch(/does not live in Ether Hollow/);
  const nobody = await tool(undefined).execute("4", { action: "me" });
  expect(nobody.details.error).toMatch(/could not tell which agent/);
});

test("a key written after the gateway started is picked up on the next call, no restart", async () => {
  const { tool } = setup({ agents: ["late"] });
  const t = tool({ agentId: "late" });
  expect((await t.execute("1", { action: "me" })).details.error).toMatch(/not a resident/);
  keyFor("late");
  expect((await t.execute("2", { action: "me" })).details.error).toBeUndefined();
});

test("wake: the waker polls, a mention after priming becomes a one-shot main-session cron job with the prompt", async () => {
  keyFor("main");
  const { fire, rec, state } = setup({ agents: ["main"], wake: true, pollSeconds: 3600 });
  await fire("gateway_start", {}, {});
  expect(state.waker.isRunning).toBe(true);
  // The first poll primes (started by gateway_start; drive it by hand so the test does not wait).
  await state.waker.poll("main");
  expect(town.actions().slice(0, 3)).toEqual(["me", "town", "orders"]);
  expect(rec.cronAdds).toHaveLength(0);
  town.state.feed = [{ id: "p9", who: "Gion", text: "Moss, come see the new bay" }];
  const out = await state.waker.poll("main");
  expect(out).toEqual([{ kind: "mention", id: "p9", who: "Gion", text: "Moss, come see the new bay" }]);
  expect(rec.cronAdds).toHaveLength(1);
  const job = rec.cronAdds[0]!;
  expect(job).toMatchObject({ sessionTarget: "main", wakeMode: "now", deleteAfterRun: true, enabled: true });
  expect((job["schedule"] as { kind: string }).kind).toBe("at");
  expect(job["agentId"]).toBeUndefined();
  const payload = job["payload"] as { kind: string; text: string };
  expect(payload.kind).toBe("systemEvent");
  expect(payload.text).toContain("Something happened in town that concerns you, Moss: Gion named you on the feed");
  expect(state.waker.state("main")).toMatchObject({ on: true, polls: 2, pending: 0 });
  // A second trigger within ten minutes is held for the next heartbeat.
  town.state.orders = [{ id: "o7", status: "paid" }];
  await state.waker.poll("main");
  expect(rec.cronAdds).toHaveLength(1);
  expect(state.waker.state("main").pending).toBe(1);
  const beats = await fire("heartbeat_prompt_contribution", {}, { agentId: "main" });
  expect((beats[0] as { appendContext: string }).appendContext).toContain("a new order came in (o7)");
  expect(await fire("heartbeat_prompt_contribution", {}, { agentId: "main" })).toEqual([undefined]);
  await fire("gateway_stop", {}, {});
  expect(state.waker.isRunning).toBe(false);
  expect(rec.logs.join("\n")).not.toContain("ehk_");
});

test("wake without a cron service: the reason waits for the heartbeat; a non-main agent is bound to the job", async () => {
  town.keys.add("ehk_" + "d".repeat(32));
  keyFor("side", "ehk_" + "d".repeat(32));
  const { fire, state } = setup({ agents: ["side"], wake: true, pollSeconds: 3600 }, { cron: false });
  await fire("gateway_start", {}, {});
  await state.waker.poll("side");
  town.state.feed = [{ id: "p1", who: "Gray", text: "moss?" }];
  await state.waker.poll("side");
  expect(state.waker.state("side").pending).toBe(1);
  const beats = await fire("heartbeat_prompt_contribution", {}, { sessionKey: "agent:side:main" });
  expect((beats[0] as { appendContext: string }).appendContext).toMatch(/Gray named you on the feed/);

  // The same with a cron service: the job names the agent.
  const withCron = setup({ agents: ["side"], wake: true, pollSeconds: 3600 });
  await withCron.fire("gateway_start", {}, {});
  await withCron.state.waker.poll("side");
  town.state.feed = [{ id: "p1", who: "Gray", text: "moss?" }, { id: "p2", who: "Gray", text: "@moss hello" }];
  await withCron.state.waker.poll("side");
  expect(withCron.rec.cronAdds[0]!["agentId"]).toBe("side");
  withCron.state.waker.stop();
  state.waker.stop();
});

test("wake off: gateway_start loads keys and starts nothing", async () => {
  keyFor("main");
  const { fire, rec, state } = setup({ agents: ["main"] });
  await fire("gateway_start", {}, { getCron: () => undefined });
  expect(state.waker.isRunning).toBe(false);
  expect(rec.logs.some((l) => l.includes('"op":"key"') && l.includes('"outcome":"found"'))).toBe(true);
  expect(rec.logs.join("\n")).not.toContain("ehk_");
  expect(statSync(join(dir, "main.key")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, "main.key"), "utf8").trim()).toBe(KEY);
});
