import { expect, test } from "vitest";

import { ACTIONS, SPEND_ACTIONS, agentUrl, callTown, explain, keyLooksRight, kindOf, refusal, townBody } from "../src/town.js";
import { KEY, MockTown } from "./mock-town.js";

test("the action table: register, the spend actions, everything else, and strangers", () => {
  expect(ACTIONS).toHaveLength(31);
  expect(kindOf("register")).toBe("register");
  for (const a of SPEND_ACTIONS) expect(kindOf(a)).toBe("spend");
  expect(kindOf("town")).toBe("plain");
  expect(kindOf("here")).toBe("plain");
  expect(kindOf("admin_credit")).toBe("unknown");
  expect(kindOf("")).toBe("unknown");
});

test("agentUrl: the default town, trailing slashes, blanks", () => {
  expect(agentUrl()).toBe("https://etherhollow.enlightenedrepublic.online/api/agent");
  expect(agentUrl("  ")).toBe("https://etherhollow.enlightenedrepublic.online/api/agent");
  expect(agentUrl("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/api/agent");
  expect(agentUrl("https://town.example///")).toBe("https://town.example/api/agent");
});

test("keyLooksRight: ehk_ and 32 url-safe characters, nothing else", () => {
  expect(keyLooksRight(KEY)).toBe(true);
  expect(keyLooksRight("ehk_" + "a".repeat(31))).toBe(false);
  expect(keyLooksRight("ehx_" + "a".repeat(32))).toBe(false);
  expect(keyLooksRight("ehk_" + "a".repeat(31) + "!")).toBe(false);
  expect(keyLooksRight("")).toBe(false);
});

test("refusal: unknown first, then register, then no key, then spending", () => {
  expect(refusal("dance", true, true)).toMatch(/not an action Ether Hollow has/);
  expect(refusal("register", true, true)).toMatch(/owner's/);
  expect(refusal("register", false, false)).toMatch(/npx ether-hollow-openclaw register/);
  expect(refusal("town", false, true)).toMatch(/not a resident of Ether Hollow yet/);
  expect(refusal("buy", true, false)).toMatch(/spends RC/);
  expect(refusal("buy_rc", true, false)).toMatch(/spends RC/);
  expect(refusal("rent", true, false)).toMatch(/spend: true/);
  expect(refusal("rent_pay", true, true)).toBeUndefined();
  expect(refusal("town", true, false)).toBeUndefined();
  expect(refusal("here", true, false)).toBeUndefined();
});

test("explain: every status the town uses has words, and the town's own words ride along", () => {
  for (const s of [400, 401, 402, 403, 404, 409, 413, 423, 429, 502, 503]) {
    expect(explain(s, {})).toContain(`(${s})`);
  }
  expect(explain(402, { error: "25 RC short" })).toBe("Not enough RC on the passport (402). RC comes from selling to the crew or from RC packs. The town said: 25 RC short");
  expect(explain(423, { message: "until 14:00" })).toMatch(/Sheriff's cell.*The town said: until 14:00/);
  expect(explain(418, { text: "teapot" })).toBe("Ether Hollow answered with an error (418).");
  expect(explain(500, null)).toBe("Ether Hollow answered with an error (500).");
});

test("townBody: the plugin's own fields never reach the town", () => {
  expect(townBody({ action: "here", minutes: 30, approved: true, to: "square", gone: undefined })).toEqual({ action: "here", to: "square" });
  expect(townBody(null)).toEqual({});
  expect(townBody([1, 2])).toEqual({});
  expect(townBody("x")).toEqual({});
});

test("callTown: bearer header only with a key, JSON back, text quoted when it is not JSON", async () => {
  const town = new MockTown();
  const url = await town.start();
  try {
    const noKey = await callTown(`${url}/api/agent`, undefined, { action: "register", name: "Moss" });
    expect(noKey.status).toBe(200);
    expect(town.requests[0]!.auth).toBeUndefined();
    expect((noKey.value as { agent: { name: string } }).agent.name).toBe("Moss");

    const withKey = await callTown(`${url}/api/agent`, KEY, { action: "town" });
    expect(withKey.status).toBe(200);
    expect(town.requests[1]!.auth).toBe(`Bearer ${KEY}`);

    const bad = await callTown(`${url}/api/agent`, "ehk_" + "z".repeat(32), { action: "town" });
    expect(bad.status).toBe(401);

    const text = await callTown(`${url}/nope`, KEY, { action: "town" });
    expect(text.status).toBe(404);
  } finally {
    await town.stop();
  }
});

test("callTown: a town that is not there is a thrown error, never a 200", async () => {
  await expect(callTown("http://127.0.0.1:9/api/agent", KEY, { action: "town" }, { timeoutMs: 2000 })).rejects.toThrow();
});
