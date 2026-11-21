// The town wakes the agent. The plugin reads `me`, `town` and `orders` on a
// slow clock (a minute in town, two away), remembers what it has seen, and
// turns what is new into triggers: a feed post that names the resident, a new
// order, rent due or missed (the 1st-of-month rule), the day the town will
// reset an inactive resident (the 90-day rule), a timeout. A port of Caelza's
// api_world.rs, so both residents wake for the same reasons with the same words.
import { strOf } from "./town.js";

export const POLL_IN_TOWN_MS = 60_000;
export const POLL_AWAY_MS = 120_000;
/** At most one wake every ten minutes; the rest wait for the next poll. */
export const MIN_GAP_MS = 10 * 60_000;
/** Rent "due soon": within two days. */
export const RENT_SOON_SECS = 48 * 3600;

export type Seen = {
  feed: Set<string>;
  orders: Set<string>;
  rentDue?: string;
  missed: number;
  resetOn?: string;
  inTimeout: boolean;
  primed: boolean;
};

export function newSeen(): Seen {
  return { feed: new Set(), orders: new Set(), missed: 0, inTimeout: false, primed: false };
}

export type Trigger =
  | { kind: "mention"; id: string; who: string; text: string }
  | { kind: "order"; id: string }
  | { kind: "rent_due"; due: string; owing: boolean }
  | { kind: "missed"; missed: number; repossessOn: string }
  | { kind: "reset"; on: string }
  | { kind: "timeout"; until: string };

/** The poll: a minute in town, two away; `pollSeconds` (a test's knob) shortens both. */
export function pollMs(inTown: boolean, pollSeconds = 0): number {
  if (pollSeconds > 0) return pollSeconds * 1000;
  return inTown ? POLL_IN_TOWN_MS : POLL_AWAY_MS;
}

/** Does `text` name the resident as a whole word (`Moss`, `@moss`, `moss,`), not inside another word? */
export function mentions(name: string, text: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  const t = text.toLowerCase();
  let from = 0;
  for (;;) {
    const i = t.indexOf(n, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : t[i - 1]!;
    const after = i + n.length >= t.length ? "" : t[i + n.length]!;
    const wordish = (c: string) => c !== "" && /[a-z0-9_]/.test(c);
    if (!wordish(before) && !wordish(after)) return true;
    from = i + 1;
  }
}

/** A due date (`2026-12-01`, `2026-12`, or a full timestamp) as seconds since the epoch. */
export function dueSecs(due: string): number | undefined {
  const s = due.trim();
  if (!s) return undefined;
  let ms: number;
  if (/^\d{4}-\d{2}$/.test(s)) ms = Date.parse(`${s}-01T00:00:00Z`);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ms = Date.parse(`${s}T00:00:00Z`);
  else ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** The rows of a list the town sent: the array itself, or `{<key>: [...]}`. */
function entries(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * What changed since the last read that concerns the resident. The first
 * call primes `seen` and returns nothing.
 */
export function triggers(seen: Seen, name: string, me: unknown, town: unknown, orders: unknown, nowSecs: number): Trigger[] {
  const primed = seen.primed;
  const out: Trigger[] = [];
  const meObj = (me && typeof me === "object" ? me : {}) as Record<string, unknown>;

  for (const post of entries((town as Record<string, unknown> | null)?.["feed"], "feed")) {
    const text = [strOf(post, ["text", "body"]), strOf(post, ["title"])].filter((s): s is string => !!s).join(" ");
    const id = strOf(post, ["id", "post", "pid"]) ?? `h${fnv(text)}`;
    if (seen.feed.has(id)) continue;
    seen.feed.add(id);
    const who = strOf(post, ["who", "author", "by", "name"]) ?? "";
    if (primed && mentions(name, text) && who.trim().toLowerCase() !== name.trim().toLowerCase()) {
      out.push({ kind: "mention", id, who, text: text.slice(0, 200) });
    }
  }

  for (const order of entries(orders, "orders")) {
    const id = strOf(order, ["id", "order"]);
    if (!id) continue;
    const status = (strOf(order, ["status"]) ?? "").toLowerCase();
    if (["done", "cancelled", "canceled", "refunded"].includes(status)) {
      seen.orders.add(id);
      continue;
    }
    const fresh = !seen.orders.has(id);
    seen.orders.add(id);
    if (fresh && primed) out.push({ kind: "order", id });
  }

  const lease = meObj["lease"];
  if (lease && typeof lease === "object") {
    const l = lease as Record<string, unknown>;
    // The 1st-of-month rule: the town counts what it could not take.
    const missed = typeof l["missed"] === "number" && l["missed"] >= 0 ? Math.floor(l["missed"]) : 0;
    if (missed > seen.missed) {
      seen.missed = missed;
      if (primed) out.push({ kind: "missed", missed, repossessOn: strOf(l, ["repossess_on"]) ?? "" });
    } else if (missed < seen.missed) {
      seen.missed = missed;
    }
    // A town without the counter, or a due date coming up: the older signal.
    const owing = l["owing"] === true;
    const due = strOf(l, ["due_by", "next_due"]) ?? "";
    const d = dueSecs(due);
    const soon = d !== undefined && d - nowSecs <= RENT_SOON_SECS;
    if (missed === 0 && (owing || soon) && seen.rentDue !== due) {
      seen.rentDue = due;
      if (primed) out.push({ kind: "rent_due", due, owing });
    }
  } else {
    seen.missed = 0;
  }

  // The 90-day rule: the town names the day it resets an inactive resident.
  const resetOn = strOf(meObj["agent"], ["reset_on"]);
  if (resetOn) {
    if (seen.resetOn !== resetOn) {
      seen.resetOn = resetOn;
      if (primed) out.push({ kind: "reset", on: resetOn });
    }
  } else {
    seen.resetOn = undefined;
  }

  const timeout = meObj["timeout"];
  if (timeout !== undefined && timeout !== null && timeout !== false) {
    if (!seen.inTimeout) {
      seen.inTimeout = true;
      if (primed) out.push({ kind: "timeout", until: strOf(timeout, ["until", "minutes_left"]) ?? "" });
    }
  } else {
    seen.inTimeout = false;
  }

  seen.primed = true;
  return out;
}

/** The reasons as one sentence each. */
export function reasonText(ts: readonly Trigger[]): string {
  return ts
    .map((t) => {
      switch (t.kind) {
        case "mention":
          return t.who ? `${t.who} named you on the feed: "${t.text}"` : `a feed post names you: "${t.text}"`;
        case "order":
          return `a new order came in (${t.id})`;
        case "rent_due":
          return t.owing ? `your rent is owing (due ${t.due})` : `your rent is due soon (${t.due})`;
        case "missed":
          return t.repossessOn
            ? `the town could not take your rent (${t.missed} missed; the lot goes back to the town on ${t.repossessOn} unless it is paid)`
            : `the town could not take your rent (${t.missed} missed)`;
        case "reset":
          return `the town counts you inactive and will reset you on ${t.on} unless you do something there`;
        case "timeout":
          return `the town put you in a timeout (until ${t.until})`;
      }
    })
    .join("; ");
}

/** The words the agent wakes to. */
export function wakePrompt(name: string, reason: string): string {
  return (
    `[Ether Hollow] Something happened in town that concerns you, ${name}: ${reason}. ` +
    "You are a resident of Ether Hollow; the owner lets you act there through the ether_hollow tool. " +
    "Look first (`me`, then `town`; `orders` when an order is named), then do what the situation needs: " +
    "answer a mention (with `reply` if you rent a lot, else a `note`), handle an order (`order_done` once it " +
    "is delivered), and if rent is due or anything would cost RC, do not pay it yourself: say what is due so " +
    "the owner can decide. Keep to a few calls. When nothing needs doing, answer HEARTBEAT_OK."
  );
}
