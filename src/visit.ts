// A visit: while the agent is "in town", the plugin sends `here` about every
// 10 s so the town shows the ghost; the model walks and talks and need not
// repeat it. `here {minutes}` starts (or extends) a visit, `leave` ends it,
// and the clock ends it on its own. A 401, 403 or 423 from a beat ends it too:
// the town has said no, repeating would not help.
import type { TownAnswer } from "./town.js";

export const BEAT_MS = 10_000;
export const DEFAULT_MINUTES = 60;
export const MAX_MINUTES = 1440;

/** The minutes a visit lasts: the default when none is named, never past a day. */
export function clampMinutes(minutes: unknown, dflt = DEFAULT_MINUTES): number {
  const n = typeof minutes === "number" ? minutes : typeof minutes === "string" ? Number(minutes) : NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.min(MAX_MINUTES, Math.max(1, dflt));
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(n)));
}

/** A beat the town refused for good: no point in the next one. */
export function beatIsFatal(status: number): boolean {
  return status === 401 || status === 403 || status === 423;
}

export type VisitState = {
  inTown: boolean;
  since?: string;
  until?: string;
  beats: number;
  lastOk?: string;
  lastError?: string;
};

export type Beat = () => Promise<TownAnswer>;

export class Visit {
  private timer?: ReturnType<typeof setInterval>;
  private since?: number;
  private until?: number;
  private beats = 0;
  private lastOk?: number;
  private lastError?: string;
  private busy = false;
  private readonly beat: Beat;
  private readonly beatMs: number;
  private readonly now: () => number;

  constructor(beat: Beat, opts: { beatMs?: number; now?: () => number } = {}) {
    this.beat = beat;
    this.beatMs = opts.beatMs ?? BEAT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Start a visit of `minutes`, or extend the one under way to that long from now. */
  start(minutes: number): VisitState {
    const now = this.now();
    if (!this.timer) {
      this.since = now;
      this.beats = 0;
      this.lastError = undefined;
      this.timer = setInterval(() => void this.tick(), this.beatMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    this.until = now + clampMinutes(minutes) * 60_000;
    return this.state();
  }

  /** End the visit; the town hears `leave` from the caller, not from here. */
  stop(): VisitState {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.until = undefined;
    return this.state();
  }

  get inTown(): boolean {
    return this.timer !== undefined;
  }

  state(): VisitState {
    const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
    const s: VisitState = { inTown: this.inTown, beats: this.beats };
    if (this.inTown) {
      if (this.since !== undefined) s.since = iso(this.since)!;
      if (this.until !== undefined) s.until = iso(this.until)!;
    }
    if (this.lastOk !== undefined) s.lastOk = iso(this.lastOk)!;
    if (this.lastError !== undefined) s.lastError = this.lastError;
    return s;
  }

  /** One beat; public so a test, or the tool's own `here`, can count it. */
  async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    if (this.until !== undefined && this.now() >= this.until) {
      this.stop();
      return;
    }
    this.busy = true;
    try {
      const answer = await this.beat();
      this.beats += 1;
      if (answer.status === 200) {
        this.lastOk = this.now();
        this.lastError = undefined;
      } else {
        this.lastError = `the town answered ${answer.status}`;
        if (beatIsFatal(answer.status)) this.stop();
      }
    } catch (err) {
      this.lastError = `could not reach the town: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }
}
