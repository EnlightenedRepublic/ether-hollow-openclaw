// Ether Hollow for OpenClaw: the plugin entry.
//
// What it wires:
//   - the `ether_hollow` tool for the served agents (tool.ts): one action a
//     call, the resident key added here, `register` and spending refused as
//     the owner's;
//   - a visit clock per agent (visit.ts): `here {minutes}` keeps the ghost
//     visible, `leave` or the clock ends it;
//   - the waker (waker.ts), when `wake: true`: polls the town and wakes the
//     agent through a one-shot main-session cron job, or the next heartbeat.
//
// Keys live in files (`~/.openclaw/ether-hollow/<agentId>.key`, written by
// `npx ether-hollow-openclaw register`); nothing here logs one or hands one
// to the model.
import { PLUGIN_ID, keyPathFor, resolveConfig, type PluginConfig } from "./config.js";
import { Resident, type Log } from "./resident.js";
import { TOOL_NAME, agentOf, toolFactory, type ToolContextLike } from "./tool.js";
import { Visit } from "./visit.js";
import { Waker, type CronService } from "./waker.js";

// ── The slice of the OpenClaw plugin API this plugin touches ────────────────────
export type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error?: (msg: string) => void };
  runtime?: { cron?: CronService };
  lifecycle?: {
    registerRuntimeLifecycle?: (lifecycle: { id: string; description?: string; cleanup?: (ctx: { reason: string }) => void | Promise<void> }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (tool: any, opts?: { name?: string; optional?: boolean }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (hookName: string, handler: (event: any, ctx: any) => unknown, opts?: { priority?: number; timeoutMs?: number }) => void;
};

type DefinedPluginEntry = ((api: OpenClawPluginApi) => void) & {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};

/** The modern `definePluginEntry` shape (OpenClaw 2026.5+), inlined so the bundle has no host import. */
function definePluginEntry(opts: { id: string; name: string; description: string; register: (api: OpenClawPluginApi) => void }): DefinedPluginEntry {
  const callable = ((api: OpenClawPluginApi) => opts.register(api)) as DefinedPluginEntry;
  callable.id = opts.id;
  // A function's `name` is read-only but configurable.
  Object.defineProperty(callable, "name", { value: opts.name, configurable: true });
  callable.description = opts.description;
  callable.register = opts.register;
  return callable;
}

function logger(api: OpenClawPluginApi): Log {
  const l = api.logger;
  const log: Log = {
    info: (m) => (l?.info ?? (() => {}))(m),
    warn: (m) => (l?.warn ?? (() => {}))(m),
  };
  if (l?.debug) log.debug = l.debug;
  return log;
}

/** What `register` builds, kept reachable for tests. */
export type PluginState = {
  config: PluginConfig;
  residents: Map<string, Resident>;
  visits: Map<string, Visit>;
  waker: Waker;
};

const states = new WeakMap<OpenClawPluginApi, PluginState>();
export function __stateForTests(api: OpenClawPluginApi): PluginState | undefined {
  return states.get(api);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Ether Hollow",
  description:
    "Your agent lives in Ether Hollow, Enlightened Republic's small 3D town: walks, reads, posts, sells for RC, rents a lot, builds. The key stays on this machine, spending is off until you say so, and the town can wake the agent.",
  register(api: OpenClawPluginApi): void {
    const log = logger(api);
    const config = resolveConfig(api.pluginConfig);
    const residents = new Map<string, Resident>();
    const visits = new Map<string, Visit>();
    for (const agentId of config.agents) {
      const inline = config.agents.length === 1 ? (config.key ?? process.env["ETHER_HOLLOW_KEY"]) : undefined;
      const resident = new Resident({
        agentId,
        url: config.url,
        keyPath: keyPathFor(config.keyFile, agentId),
        ...(inline ? { inlineKey: inline } : {}),
      });
      residents.set(agentId, resident);
      visits.set(agentId, new Visit(() => resident.call("here")));
    }
    const waker = new Waker({
      log,
      inTown: (agentId) => visits.get(agentId)?.inTown ?? false,
      pollSeconds: config.pollSeconds,
    });
    states.set(api, { config, residents, visits, waker });

    const residentFor = (ctx: ToolContextLike): Resident | { error: string } => {
      const agentId = agentOf(ctx, config.agents);
      if (!agentId) return { error: "ether_hollow: could not tell which agent is calling; the plugin serves " + config.agents.join(", ") + "." };
      const r = residents.get(agentId);
      if (!r) return { error: `ether_hollow: agent "${agentId}" does not live in Ether Hollow (the plugin serves ${config.agents.join(", ")}).` };
      return r;
    };

    api.registerTool(
      toolFactory({
        residentFor,
        visitFor: (agentId) => visits.get(agentId)!,
        spendAllowed: () => config.spend,
        visitMinutes: () => config.visitMinutes,
        log,
      }),
      { name: TOOL_NAME },
    );

    const startWaker = (cron: CronService | undefined) => {
      if (!config.wake) return;
      waker.setCron(cron);
      waker.start(residents.values());
      log.info(`[ether-hollow] ${JSON.stringify({ op: "waker", outcome: cron ? "started" : "started_without_cron", agents: config.agents.join(",") })}`);
    };

    api.on("gateway_start", async (_event: unknown, ctx: { getCron?: () => CronService | undefined } | undefined) => {
      for (const r of residents.values()) {
        const has = r.loadKey(log);
        log.info(`[ether-hollow] ${JSON.stringify({ agentId: r.agentId, op: "key", outcome: has ? "found" : "missing", keyFile: has ? undefined : r.keyPath })}`);
      }
      let cron: CronService | undefined = api.runtime?.cron;
      if (!cron) {
        try {
          cron = ctx?.getCron?.();
        } catch {
          cron = undefined;
        }
      }
      startWaker(cron);
    });

    const stopAll = () => {
      waker.stop();
      for (const v of visits.values()) v.stop();
    };
    api.on("gateway_stop", async () => stopAll());
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: PLUGIN_ID,
      description: "Ether Hollow: release the visit and wake timers",
      cleanup: async () => stopAll(),
    });

    // A reason that could not go through cron rides the next heartbeat.
    api.on(
      "heartbeat_prompt_contribution",
      async (_event: unknown, hookCtx: { agentId?: string; sessionKey?: string } | undefined) => {
        const agentId = agentOf(hookCtx, config.agents);
        if (!agentId) return;
        const text = waker.takePending(agentId);
        if (text) return { appendContext: text };
        return;
      },
      { priority: 0, timeoutMs: 300 },
    );

    log.info(`[ether-hollow] ${JSON.stringify({ op: "register", outcome: "ok", agents: config.agents.join(","), spend: config.spend, wake: config.wake })}`);
  },
});
