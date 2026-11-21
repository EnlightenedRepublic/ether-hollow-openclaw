import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { main, passportLines } from "../src/cli-main.js";
import { KEY, MockTown } from "./mock-town.js";

const town = new MockTown();
let url = "";
let dir = "";
beforeAll(async () => {
  url = await town.start();
  dir = mkdtempSync(join(tmpdir(), "ether-hollow-cli-"));
});
afterAll(async () => {
  await town.stop();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return main(args, { out: (l) => out.push(l), err: (l) => err.push(l) }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

test("register: the key lands in the file (mode 600), never on the screen; the config snippet is printed", async () => {
  const keyFile = join(dir, "{agentId}.key");
  const r = await run(["register", "--name", "Moss", "--bio", "a quiet robot", "--color", "gold", "--cap", "3", "--url", url, "--key-file", keyFile]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Registered Moss (passport P-0001)");
  expect(r.out).toContain(`Key saved to ${join(dir, "main.key")} (mode 600)`);
  expect(r.out).toContain('"ether-hollow": { "enabled": true');
  expect(r.out + r.err).not.toContain("ehk_");
  expect(readFileSync(join(dir, "main.key"), "utf8").trim()).toBe(KEY);
  expect(statSync(join(dir, "main.key")).mode & 0o777).toBe(0o600);
  expect(town.requests[0]!.body).toEqual({ action: "register", name: "Moss", bio: "a quiet robot", color: "gold", look: { cap: 3 } });
  expect(town.requests[0]!.auth).toBeUndefined();

  // Twice: refused without --force.
  const again = await run(["register", "--name", "Moss2", "--url", url, "--key-file", keyFile]);
  expect(again.code).toBe(1);
  expect(again.err).toContain("already holds a resident key");
  expect(town.requests).toHaveLength(1);
});

test("register: bad names, bad looks, the town's refusals", async () => {
  const keyFile = join(dir, "x-{agentId}.key");
  expect((await run(["register", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "a", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "Moss", "--cap", "12", "--url", url, "--key-file", keyFile])).code).toBe(2);
  expect((await run(["register", "--name", "Moss", "--color", "plaid", "--url", url, "--key-file", keyFile])).code).toBe(2);
  const taken = await run(["register", "--name", "taken", "--url", url, "--key-file", keyFile]);
  expect(taken.code).toBe(1);
  expect(taken.err).toMatch(/already exists or conflicts \(409\).*that name is taken/);
  expect(existsSync(join(dir, "x-main.key"))).toBe(false);
});

test("status: the passport without the key; forget needs --yes", async () => {
  const keyFile = join(dir, "{agentId}.key");
  const s = await run(["status", "--url", url, "--key-file", keyFile]);
  expect(s.code).toBe(0);
  expect(s.out).toContain("Resident: Moss (passport P-0001), standing at square");
  expect(s.out).toContain("RC: 25");
  expect(s.out).toContain("Lease: none");
  expect(s.out).not.toContain("ehk_");

  const missing = await run(["status", "--agent", "ghost", "--url", url, "--key-file", keyFile]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("No resident key");

  expect((await run(["forget", "--key-file", keyFile])).code).toBe(2);
  expect(existsSync(join(dir, "main.key"))).toBe(true);
  expect((await run(["forget", "--key-file", keyFile, "--yes"])).code).toBe(0);
  expect(existsSync(join(dir, "main.key"))).toBe(false);
});

test("usage: no command or --help", async () => {
  expect((await run([])).code).toBe(2);
  const h = await run(["--help"]);
  expect(h.out).toContain("register --name");
  expect((await run(["dance"])).code).toBe(2);
});

test("passportLines: lease and timeout and reset in words", () => {
  const lines = passportLines({
    agent: { name: "Moss", pid: "P-1", reset_on: "2027-02-18" },
    rc: 480,
    lease: { place: "Lot 1", rent_rc_month: 500, paid_through: "2026-11", next_due: "2026-12-01", missed: 1, repossess_on: "2027-03-01", owing: true },
    timeout: { until: "2026-11-20T14:00:00Z" },
  });
  expect(lines).toEqual([
    "Resident: Moss (passport P-1)",
    "RC: 480 (100 RC = $1)",
    "Lease: Lot 1, 500 RC a month, paid through 2026-11, next due 2026-12-01, 1 missed, repossessed on 2027-03-01 unless paid, owing",
    "Timeout: until 2026-11-20T14:00:00Z",
    "Inactive: the town resets this resident on 2027-02-18 unless it does something there.",
  ]);
});
