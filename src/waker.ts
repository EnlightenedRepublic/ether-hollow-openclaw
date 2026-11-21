// The waker: polls the town for each resident, turns what is new into a
// reason, and hands the reason to the agent through OpenClaw's own door for
// "something happened": a one-shot main-session cron job with a systemEvent
// payload and wakeMode "now" (the event lands in the main session and a
// heartbeat runs at once). Without a cron service the reason waits for the
// next heartbeat, where `heartbeat_prompt_contribution` delivers it.
import type { Log, Resident } from "./resident.js";
import { MIN_GAP_MS, newSeen, pollMs, reasonText, triggers, wakePrompt, type Seen, type Trigger } from "./wake.js";

/** The slice of OpenClaw's cron service the waker uses (PluginHookGatewayCronService). */
export type CronService = {
  add: (input: {
    name: string;
    description?: string;
    enabled: boolean;
    agentId?: string;
    schedule: { kind: "at"; at: string } | { kind: "cron"; expr: string; tz?: string } | { kind: "every"; everyMs: number };
    sessionTarget: "main" | "isolated";
    wakeMode: "now" | "next-heartbeat";
    payload: { kind: "systemEvent"; text: string } | { kind: "agentTurn"; message: string; model?: string };
    deleteAfterRun?: boolean;
  }) => Promise<unknown>;
};

export const JOB_NAME = "ether-hollow";

export type WakeState = {
  on: boolean;
  polls: number;
  lastPoll?: string;
  lastWake?: string;
  lastReason?: string;
  lastError?: string;
  pending: number;
};

type Per = {
  resident: Resident;
  seen: Seen;
  polls: number;
  lastPoll?: number;
  lastWake?: number;
  lastReason?: string;
  lastError?: string;
  /** Reasons that could not go through cron: the next heartbeat carries them. */
  pending: string[];
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
};

export class Waker {
  private readonly per = new Map<string, Per>();
  private cron?: CronService;
  private running = false;
  private readonly log: Log;
  private readonly inTown: (agentId: string) => boolean;
  private readonly pollSeconds: number;
  private readonly now: () => number;

  constructor(opts: { log: Log; inTown: (agentId: string) => boolean; pollSeconds?: number; now?: () => number }) {
    this.log = opts.log;
    this.inTown = opts.inTown;
    this.pollSeconds = opts.pollSeconds ?? 0;
    this.now = opts.now ?? Date.now;
  }

  /** Hand over the host's cron service (gateway_start); undefined means "wait for a heartbeat". */
  setCron(cron: CronService | undefined): void {
    this.cron = cron;
  }

  start(residents: Iterable<Resident>): void {
    this.running = true;
    for (const resident of residents) {
      if (this.per.has(resident.agentId)) continue;
      const p: Per = { resident, seen: newSeen(), polls: 0, pending: [], busy: false };
      this.per.set(resident.agentId, p);
      this.schedule(p, 0);
    }
  }

  stop(): void {
    this.running = false;
    for (const p of this.per.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = undefined;
    }
    this.per.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  state(agentId: string): WakeState {
    const p = this.per.get(agentId);
    const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
    const s: WakeState = { on: this.running && !!p, polls: p?.polls ?? 0, pending: p?.pending.length ?? 0 };
    if (p?.lastPoll !== undefined) s.lastPoll = iso(p.lastPoll)!;
    if (p?.lastWake !== undefined) s.lastWake = iso(p.lastWake)!;
    if (p?.lastReason !== undefined) s.lastReason = p.lastReason;
    if (p?.lastError !== undefined) s.lastError = p.lastError;
    return s;
  }

  /** The words a heartbeat should carry for this agent, if any; taking them clears them. */
  takePending(agentId: string): string | undefined {
    const p = this.per.get(agentId);
    if (!p || p.pending.length === 0) return undefined;
    const reason = p.pending.join("; ");
    p.pending = [];
    return wakePrompt(p.resident.name ?? agentId, reason);
  }

  private schedule(p: Per, delayMs: number): void {
    if (!this.running) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.poll(p), delayMs);
    (p.timer as { unref?: () => void }).unref?.();
  }

  /** One poll for one resident; public so a test can drive it. */
  async poll(p: Per | string): Promise<Trigger[]> {
    const per = typeof p === "string" ? this.per.get(p) : p;
    if (!per || per.busy) return [];
    per.busy = true;
    let out: Trigger[] = [];
    try {
      if (!per.resident.hasKey()) {
        per.lastError = "no resident key yet";
        return [];
      }
      const me = await per.resident.call("me");
      if (me.status === 401) {
        per.lastError = "the town does not know this key (401)";
        per.resident.dropKey();
        return [];
      }
      const town = await per.resident.call("town");
      const orders = await per.resident.call("orders");
      per.polls += 1;
      per.lastPoll = this.now();
      per.lastError = undefined;
      const name = per.resident.name ?? per.resident.agentId;
      out = triggers(
        per.seen,
        name,
        me.status === 200 ? me.value : undefined,
        town.status === 200 ? town.value : undefined,
        orders.status === 200 ? orders.value : undefined,
        Math.floor(this.now() / 1000),
      );
      if (out.length) await this.wake(per, reasonText(out));
      return out;
    } catch (err) {
      per.lastError = `could not reach the town: ${err instanceof Error ? err.message : String(err)}`;
      return [];
    } finally {
      per.busy = false;
      this.schedule(per, pollMs(this.inTown(per.resident.agentId), this.pollSeconds));
    }
  }

  private async wake(per: Per, reason: string): Promise<void> {
    const now = this.now();
    if (per.lastWake !== undefined && now - per.lastWake < MIN_GAP_MS) {
      // Too soon after the last wake: the reason waits for the next heartbeat.
      per.pending.push(reason);
      this.log.info(`[ether-hollow] ${JSON.stringify({ agentId: per.resident.agentId, op: "wake", outcome: "held", reason })}`);
      return;
    }
    per.lastReason = reason;
    const name = per.resident.name ?? per.resident.agentId;
    const text = wakePrompt(name, reason);
    if (!this.cron) {
      per.pending.push(reason);
      this.log.info(`[ether-hollow] ${JSON.stringify({ agentId: per.resident.agentId, op: "wake", outcome: "next_heartbeat", reason })}`);
      return;
    }
    try {
      await this.cron.add({
        name: `${JOB_NAME}: ${reason.slice(0, 60)}`,
        description: "Ether Hollow woke the resident (one-shot, from the ether-hollow plugin)",
        enabled: true,
        ...(per.resident.agentId !== "main" ? { agentId: per.resident.agentId } : {}),
        schedule: { kind: "at", at: new Date(now + 1000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text },
        deleteAfterRun: true,
      });
      per.lastWake = now;
      this.log.info(`[ether-hollow] ${JSON.stringify({ agentId: per.resident.agentId, op: "wake", outcome: "cron", reason })}`);
    } catch (err) {
      per.pending.push(reason);
      per.lastError = `could not add the wake job: ${err instanceof Error ? err.message : String(err)}`;
      this.log.warn(`[ether-hollow] ${JSON.stringify({ agentId: per.resident.agentId, op: "wake", outcome: "cron_failed", error: per.lastError })}`);
    }
  }
}
