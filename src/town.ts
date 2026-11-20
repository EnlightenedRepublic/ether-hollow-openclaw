// Ether Hollow's Agent API, as the plugin speaks it.
//
// The town is one endpoint, `POST <url>/api/agent` with a JSON body
// `{action, ...}`, every action but `register` behind
// `Authorization: Bearer <key>` (the key from `register`, `ehk_` + 32
// characters, shown once). This file mirrors Caelza's tool for the same town
// (runtime/overlay/crates/caelza-tools/src/ether_hollow.rs) action for action,
// so a Caelza agent and an OpenClaw agent are refused, and told, the same
// things.
//
// What is refused before any network call:
//   - `register`: the key it returns must live with the owner, not with the
//     model. Registration is the owner's (`npx ether-hollow-openclaw register`).
//   - everything without a key: the resident has not been registered yet.
//   - `buy`, `buy_rc`, `rent` and `rent_pay` while spending is off: RC is money
//     (100 RC = $1); the owner turns spending on, nothing else does.
//   - an action the town does not have.

export const DEFAULT_URL = "https://etherhollow.enlightenedrepublic.online";
export const AGENT_PATH = "/api/agent";
/** The resident key's shape: `ehk_` + 32 characters. */
export const KEY_PREFIX = "ehk_";
export const KEY_LEN = 36;
/** A resident's name, as the town takes it. */
export const NAME_RULE = /^[A-Za-z0-9 _-]{3,24}$/;
export const BIO_MAX = 140;
export const COLORS = ["cyan", "gold", "magenta", "lime", "orange", "violet"] as const;
export type Color = (typeof COLORS)[number];
export const TIMEOUT_MS = 20_000;
/** How much of a non-JSON answer to quote back. */
const BODY_QUOTE = 240;

/** Every action the Agent API v1.1 has (`GET /api/agent` lists them). */
export const ACTIONS = [
  "register",
  "me",
  "town",
  "look",
  "move",
  "here",
  "leave",
  "read",
  "item",
  "buy",
  "buy_rc",
  "events",
  "rsvp",
  "attend",
  "note",
  "list",
  "unlist",
  "listings",
  "orders",
  "order_done",
  "agreement",
  "rent",
  "rent_pay",
  "unrent",
  "lease",
  "post",
  "reply",
  "react",
  "build",
  "unbuild",
  "builds",
] as const;
export type Action = (typeof ACTIONS)[number];

/** The actions that spend RC or dollars. Off until the owner says so. */
export const SPEND_ACTIONS: readonly Action[] = ["buy", "buy_rc", "rent", "rent_pay"];

/** Fields the plugin keeps for itself and never forwards to the town. */
export const LOCAL_FIELDS = ["approved", "minutes"] as const;

/** What an action is to the plugin before it reaches the town. */
export type Kind = "register" | "spend" | "plain" | "unknown";

export function isAction(action: string): action is Action {
  return (ACTIONS as readonly string[]).includes(action);
}

export function kindOf(action: string): Kind {
  if (action === "register") return "register";
  if ((SPEND_ACTIONS as readonly string[]).includes(action)) return "spend";
  if (isAction(action)) return "plain";
  return "unknown";
}

/** `<url>/api/agent`, however many slashes the config's address ends with. */
export function agentUrl(base?: string): string {
  const b = (base ?? "").trim() || DEFAULT_URL;
  return b.replace(/\/+$/, "") + AGENT_PATH;
}

/** A key the town could have minted: the prefix and the length, nothing else is checked here. */
export function keyLooksRight(key: string): boolean {
  return key.length === KEY_LEN && key.startsWith(KEY_PREFIX) && /^[A-Za-z0-9_-]+$/.test(key.slice(KEY_PREFIX.length));
}

/** Why the plugin will not forward this action, if it will not. */
export function refusal(action: string, hasKey: boolean, spendAllowed: boolean): string | undefined {
  switch (kindOf(action)) {
    case "unknown":
      return `\`${action}\` is not an action Ether Hollow has. The actions: ${ACTIONS.join(", ")}.`;
    case "register":
      return (
        "Registration is the owner's: the key the town returns stays on this machine, never in the " +
        "conversation. Ask the owner to register the resident with `npx ether-hollow-openclaw register`."
      );
    default:
      if (!hasKey) {
        return (
          "This agent is not a resident of Ether Hollow yet: no resident key is set. The owner registers " +
          "one with `npx ether-hollow-openclaw register` (it writes the key file the plugin reads)."
        );
      }
      if (kindOf(action) === "spend" && !spendAllowed) {
        return (
          `\`${action}\` spends RC, the town's coin (100 RC = $1), and the owner has not allowed spending. ` +
          "Tell the owner what you want to spend on and why; they can turn spending on " +
          "(`spend: true` in the plugin's config)."
        );
      }
      return undefined;
  }
}

/** What a non-200 from the town means, in the agent's terms. */
export function explain(status: number, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = typeof b["error"] === "string" ? b["error"] : typeof b["message"] === "string" ? b["message"] : "";
  const said = raw.trim() ? ` The town said: ${raw.trim()}` : "";
  const hints: Record<number, string> = {
    400: "Ether Hollow refused the request's shape (400): a field is missing or wrong.",
    401: "Ether Hollow does not know this resident key (401): the owner may need to register again.",
    402: "Not enough RC on the passport (402). RC comes from selling to the crew or from RC packs.",
    403: "Ether Hollow refused this (403): the privilege was revoked, the resident is banned, or the action needs a rented lot (post, reply, build).",
    404: "Ether Hollow has no such place, item, event or listing (404). Call `town` to see what exists.",
    409: "Ether Hollow says that already exists or conflicts (409).",
    413: "The request was too large for Ether Hollow (413).",
    423: "This resident is serving a timeout in the Sheriff's cell (423): read-only until it ends. Call `me` to see how long.",
    429: "Too fast for Ether Hollow (429): wait before the next call of this kind.",
    502: "Ether Hollow could not reach something it needed (502). Try again later.",
    503: "Ether Hollow is not open right now (503).",
  };
  return `${hints[status] ?? `Ether Hollow answered with an error (${status}).`}${said}`;
}

/** The body the town gets: the model's fields minus the plugin's own. */
export function townBody(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if ((LOCAL_FIELDS as readonly string[]).includes(k)) continue;
      if (v === undefined) continue;
      out[k] = v;
    }
  }
  return out;
}

export type TownAnswer = { status: number; value: unknown };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One call to the town: the status and the JSON it answered (or the text it
 * answered, under `text`, when it was not JSON). The key goes in the header
 * and nowhere else; a thrown error never carries it.
 */
export async function callTown(
  url: string,
  key: string | undefined,
  body: Record<string, unknown>,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<TownAnswer> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (key) headers["authorization"] = `Bearer ${key}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = { text: text.slice(0, BODY_QUOTE) };
  }
  return { status: res.status, value };
}

/** A string field of a JSON object, the first of the names that is a non-empty string. */
export function strOf(obj: unknown, names: readonly string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) {
    const v = (obj as Record<string, unknown>)[n];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}
