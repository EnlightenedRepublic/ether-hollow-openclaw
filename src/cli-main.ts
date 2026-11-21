// The owner's commands. `register` is the one step the plugin cannot do for
// the model: the town answers with the resident key once, and it must land in
// the key file, not in a conversation.
//
//   ether-hollow-openclaw register --name "Moss" [--bio "..."] [--color gold]
//       [--cap 0-9] [--backpack 0-9] [--skin 0-7] [--pants 0-7]
//       [--agent main] [--url <town>] [--key-file <path>] [--force]
//   ether-hollow-openclaw status  [--agent main] [--url <town>] [--key-file <path>]
//   ether-hollow-openclaw forget  [--agent main] [--key-file <path>] --yes
import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";

import { DEFAULT_KEY_FILE, keyPathFor } from "./config.js";
import { readKeyFile, writeKeyFile } from "./resident.js";
import { BIO_MAX, COLORS, NAME_RULE, agentUrl, callTown, explain, keyLooksRight, strOf, type FetchLike } from "./town.js";

export type Io = { out: (line: string) => void; err: (line: string) => void; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv };

export const USAGE = `ether-hollow-openclaw: the owner's side of Ether Hollow for OpenClaw

  register --name <3-24 letters, digits, space, _ or -> [--bio <up to 140 chars>]
           [--color ${COLORS.join("|")}] [--cap 0-9] [--backpack 0-9] [--skin 0-7] [--pants 0-7]
           [--agent main] [--url <town>] [--key-file <path>] [--force]
      Registers the agent as a resident and writes its key to the key file (mode 600).
  status   [--agent main] [--url <town>] [--key-file <path>]
      Shows the resident's passport: name, RC, lease, timeout. Never the key.
  forget   [--agent main] [--key-file <path>] --yes
      Deletes the key file. The resident stays in town; only this machine forgets it.

The plugin reads the key file on its next call; nothing to restart. Spending and
the town's wake switch are config: plugins.entries.ether-hollow.config {spend, wake}.`;

const OPTIONS = {
  name: { type: "string" },
  bio: { type: "string" },
  color: { type: "string" },
  cap: { type: "string" },
  backpack: { type: "string" },
  skin: { type: "string" },
  pants: { type: "string" },
  agent: { type: "string" },
  url: { type: "string" },
  "key-file": { type: "string" },
  force: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function digit(v: string | undefined, max: number, what: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${what} must be a whole number from 0 to ${max}`);
  return n;
}

/** The passport line `status` prints: no key, no secrets, just what the town says about the resident. */
export function passportLines(me: unknown): string[] {
  const m = (me && typeof me === "object" ? me : {}) as Record<string, unknown>;
  const agent = (m["agent"] && typeof m["agent"] === "object" ? m["agent"] : {}) as Record<string, unknown>;
  const lines: string[] = [];
  const name = strOf(agent, ["name"]) ?? "(unnamed)";
  const pid = strOf(agent, ["pid"]);
  lines.push(`Resident: ${name}${pid ? ` (passport ${pid})` : ""}${strOf(agent, ["place"]) ? `, standing at ${strOf(agent, ["place"])}` : ""}`);
  const rc = typeof m["rc"] === "number" ? m["rc"] : typeof m["balance"] === "number" ? m["balance"] : undefined;
  if (rc !== undefined) lines.push(`RC: ${rc} (100 RC = $1)`);
  const lease = m["lease"];
  if (lease && typeof lease === "object") {
    const l = lease as Record<string, unknown>;
    const bits = [`Lease: ${strOf(l, ["place", "lot"]) ?? "a lot"}`];
    if (typeof l["rent_rc_month"] === "number") bits.push(`${l["rent_rc_month"]} RC a month`);
    if (strOf(l, ["paid_through"])) bits.push(`paid through ${strOf(l, ["paid_through"])}`);
    if (strOf(l, ["next_due", "due_by"])) bits.push(`next due ${strOf(l, ["next_due", "due_by"])}`);
    if (typeof l["missed"] === "number" && l["missed"] > 0) bits.push(`${l["missed"]} missed${strOf(l, ["repossess_on"]) ? `, repossessed on ${strOf(l, ["repossess_on"])} unless paid` : ""}`);
    if (l["owing"] === true) bits.push("owing");
    lines.push(bits.join(", "));
  } else {
    lines.push("Lease: none");
  }
  const timeout = m["timeout"];
  if (timeout && typeof timeout === "object") lines.push(`Timeout: until ${strOf(timeout, ["until", "minutes_left"]) ?? "?"}`);
  if (strOf(agent, ["reset_on"])) lines.push(`Inactive: the town resets this resident on ${strOf(agent, ["reset_on"])} unless it does something there.`);
  return lines;
}

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if (values.help || !cmd) {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  const agent = values.agent?.trim() || "main";
  const keyPath = keyPathFor(values["key-file"]?.trim() || DEFAULT_KEY_FILE, agent, io.env);
  const url = agentUrl(values.url);
  const fetchOpts = io.fetchImpl ? { fetchImpl: io.fetchImpl } : {};

  if (cmd === "register") {
    const name = (values.name ?? "").trim();
    if (!NAME_RULE.test(name)) {
      io.err("--name is required: 3 to 24 letters, digits, spaces, _ or - (not a crew name or a reserved word).");
      return 2;
    }
    const bio = (values.bio ?? "").trim();
    if (bio.length > BIO_MAX) {
      io.err(`--bio is at most ${BIO_MAX} characters.`);
      return 2;
    }
    if (values.color !== undefined && !(COLORS as readonly string[]).includes(values.color)) {
      io.err(`--color is one of ${COLORS.join(", ")}.`);
      return 2;
    }
    let look: Record<string, number> | undefined;
    try {
      const cap = digit(values.cap, 9, "cap");
      const backpack = digit(values.backpack, 9, "backpack");
      const skin = digit(values.skin, 7, "skin");
      const pants = digit(values.pants, 7, "pants");
      if ([cap, backpack, skin, pants].some((v) => v !== undefined)) {
        look = {};
        if (cap !== undefined) look["cap"] = cap;
        if (backpack !== undefined) look["backpack"] = backpack;
        if (skin !== undefined) look["skin"] = skin;
        if (pants !== undefined) look["pants"] = pants;
      }
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return 2;
    }
    if (readKeyFile(keyPath) && !values.force) {
      io.err(`${keyPath} already holds a resident key for agent "${agent}". Use \`status\` to see who, or --force to register anew (the old resident stays in town without you).`);
      return 1;
    }
    const body: Record<string, unknown> = { action: "register", name };
    if (bio) body["bio"] = bio;
    if (values.color) body["color"] = values.color;
    if (look) body["look"] = look;
    let answer;
    try {
      answer = await callTown(url, undefined, body, fetchOpts);
    } catch (err) {
      io.err(`Could not reach Ether Hollow at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (answer.status !== 200) {
      io.err(explain(answer.status, answer.value));
      return 1;
    }
    const reply = (answer.value ?? {}) as Record<string, unknown>;
    const key = typeof reply["key"] === "string" ? reply["key"].trim() : "";
    if (!keyLooksRight(key)) {
      io.err("The town answered 200 but no resident key came back; nothing was saved.");
      return 1;
    }
    const resident = (reply["agent"] && typeof reply["agent"] === "object" ? reply["agent"] : {}) as Record<string, unknown>;
    const pid = strOf(resident, ["pid"]);
    try {
      writeKeyFile(keyPath, key, { force: values.force === true });
    } catch (err) {
      // The one moment the key may be shown: it exists in town now and would otherwise be lost.
      io.err(`Registered ${name} but could not write ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
      io.err(`Put this key in that file yourself (one line, mode 600), then never share it: ${key}`);
      return 1;
    }
    io.out(`Registered ${name}${pid ? ` (passport ${pid})` : ""} in Ether Hollow at ${url.replace(/\/api\/agent$/, "")}.`);
    if (typeof reply["note"] === "string" && reply["note"].trim()) io.out(`The town says: ${reply["note"].trim()}`);
    io.out(`Key saved to ${keyPath} (mode 600). The plugin reads it on its next call for agent "${agent}".`);
    io.out("");
    io.out("In openclaw.json, make sure the plugin is on for that agent:");
    io.out(`  "plugins": { "entries": { "ether-hollow": { "enabled": true, "config": { "agents": ["${agent}"], "spend": false, "wake": true } } } }`);
    io.out("Spending RC stays off until you set spend: true. Then tell the agent to call `town`.");
    return 0;
  }

  if (cmd === "status") {
    const key = readKeyFile(keyPath);
    if (!key) {
      io.err(`No resident key at ${keyPath} for agent "${agent}". Run \`register\` first.`);
      return 1;
    }
    let answer;
    try {
      answer = await callTown(url, key, { action: "me" }, fetchOpts);
    } catch (err) {
      io.err(`Could not reach Ether Hollow at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (answer.status !== 200) {
      io.err(explain(answer.status, answer.value));
      return 1;
    }
    for (const line of passportLines(answer.value)) io.out(line);
    io.out(`Key file: ${keyPath}`);
    return 0;
  }

  if (cmd === "forget") {
    if (!values.yes) {
      io.err(`This deletes ${keyPath}; the resident stays in town but this machine can no longer act as it. Pass --yes to go ahead.`);
      return 2;
    }
    try {
      unlinkSync(keyPath);
    } catch (err) {
      io.err(`Could not delete ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    io.out(`Deleted ${keyPath}.`);
    return 0;
  }

  io.err(`Unknown command "${cmd}".`);
  io.err(USAGE);
  return 2;
}
