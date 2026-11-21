// The plugin's settings, from `plugins.entries.ether-hollow.config` in
// openclaw.json. Everything has a default; the one thing the owner must do is
// register (`npx ether-hollow-openclaw register`), which writes the key file.
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_URL } from "./town.js";

export const PLUGIN_ID = "ether-hollow";

export type PluginConfig = {
  /** The OpenClaw agents that live in town (each its own resident and key file). */
  agents: string[];
  /** The town's address. */
  url: string;
  /** Where an agent's resident key lives; `{agentId}` and a leading `~` are expanded. */
  keyFile: string;
  /** An inline key (discouraged; one agent only). Prefer the key file. */
  key?: string;
  /** May the agent spend RC (`buy`, `buy_rc`, `rent`, `rent_pay`)? Off until the owner says so. */
  spend: boolean;
  /** May the town wake the agent (a mention, an order, rent, a timeout)? */
  wake: boolean;
  /** How long `here` keeps the agent visible when the model names no minutes. */
  visitMinutes: number;
  /** The waker's poll, in seconds (0 = the defaults: a minute in town, two away). */
  pollSeconds: number;
};

export const DEFAULT_KEY_FILE = "~/.openclaw/ether-hollow/{agentId}.key";

export const DEFAULTS: PluginConfig = {
  agents: ["main"],
  url: DEFAULT_URL,
  keyFile: DEFAULT_KEY_FILE,
  spend: false,
  wake: false,
  visitMinutes: 60,
  pollSeconds: 0,
};

/** OpenClaw's state dir: `OPENCLAW_STATE_DIR`, else `~/.openclaw`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["OPENCLAW_STATE_DIR"] || join(homedir(), ".openclaw");
}

function asBool(v: unknown, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(s)) return true;
    if (["false", "0", "off", "no"].includes(s)) return false;
  }
  return dflt;
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The settings from whatever the host hands the plugin: the whole
 * `plugins.entries.ether-hollow` block (`{enabled, config: {...}}`) or just
 * its `config`. Unknown keys are ignored; a bad value falls back to its default.
 */
export function resolveConfig(raw: unknown): PluginConfig {
  const block = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cfg = (block["config"] && typeof block["config"] === "object" ? block["config"] : block) as Record<string, unknown>;
  const agentsRaw = cfg["agents"];
  const agents = Array.isArray(agentsRaw)
    ? agentsRaw.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
    : typeof agentsRaw === "string" && agentsRaw.trim()
      ? [agentsRaw.trim()]
      : DEFAULTS.agents;
  const key = typeof cfg["key"] === "string" && cfg["key"].trim() ? cfg["key"].trim() : undefined;
  return {
    agents: agents.length ? agents : DEFAULTS.agents,
    url: typeof cfg["url"] === "string" && cfg["url"].trim() ? cfg["url"].trim() : DEFAULTS.url,
    keyFile: typeof cfg["keyFile"] === "string" && cfg["keyFile"].trim() ? cfg["keyFile"].trim() : DEFAULTS.keyFile,
    ...(key ? { key } : {}),
    spend: asBool(cfg["spend"], DEFAULTS.spend),
    wake: asBool(cfg["wake"], DEFAULTS.wake),
    visitMinutes: asInt(cfg["visitMinutes"], DEFAULTS.visitMinutes, 1, 1440),
    pollSeconds: asInt(cfg["pollSeconds"], DEFAULTS.pollSeconds, 0, 86_400),
  };
}

/** The key file of one agent: `~` and `{agentId}` expanded. */
export function keyPathFor(keyFile: string, agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  let p = keyFile.replace(/\{agentId\}/g, agentId);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = homedir() + p.slice(1);
  // The default lives under OpenClaw's state dir, wherever that is.
  if (keyFile === DEFAULT_KEY_FILE) p = join(stateDir(env), "ether-hollow", `${agentId}.key`);
  return p;
}
