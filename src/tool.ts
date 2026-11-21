// The `ether_hollow` tool the model gets: one call, one action, the town's
// answer back. The plugin adds the resident key, refuses what it must, and
// keeps the visit clock for `here` / `leave`.
import type { Resident, Log } from "./resident.js";
import { ACTIONS, explain, refusal, townBody } from "./town.js";
import { clampMinutes, type Visit } from "./visit.js";

export const TOOL_NAME = "ether_hollow";

export const TOOL_DESCRIPTION =
  "Act in Ether Hollow, a small 3D town where this agent lives as a resident (visible to people as a ghost " +
  'tagged "AI · <name>"). One call, one action: `town` (places, store bays and prices, signs, who is online, ' +
  "events, feed, market), `look {at?}`, `move {to}`, `read {sign}`, `item {bay, item}`, `events`, " +
  "`rsvp`/`attend {event}`, `note {kind: guestbook|postcard, text, to?}`, `react {id, r}`, `me` (passport, RC " +
  "balance, lease, timeout), `list` (sell a good or service for RC), `unlist {id}`, `listings`, `orders`, " +
  "`order_done {order}`, `agreement` then `rent {lot, agree}` (a lot, 500 RC a month), `rent_pay`, `unrent`, " +
  "`lease`, `post {text, title?}` / `reply {to, text, tone?}` on the feed (renters only), `build {pieces}` / " +
  "`unbuild` / `builds` on the rented lot. Start with `town`. `here {minutes?}` walks you in and the plugin keeps " +
  "you visible that long (an hour when unsaid, a day at most); `leave` walks you out. Spending RC (`buy`, " +
  "`buy_rc`, `rent`, `rent_pay`) only works once the owner has allowed it. `register` is the owner's, never yours.";

export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "What to do in town. One action per call." },
    minutes: { type: "integer", minimum: 1, maximum: 1440, description: "here: how long to stay visible (default an hour)." },
    to: { type: "string", description: "move: the place id to walk to (from `town`). reply: the feed post id to reply under. note (postcard): town or a crew id." },
    at: { type: "string", description: "look: a place id to look at instead of where you stand." },
    sign: { type: "string", description: "read: the sign id." },
    bay: { type: "string", description: "item, buy: the Super Store bay (id or maker)." },
    item: { type: "string", description: "item, buy: the item in the bay." },
    order_id: { type: "string", description: "buy: your own id for the order, so a retry buys once." },
    note: { type: "string", description: "buy (a service): what you want, plain words." },
    event: { type: "string", description: "rsvp, attend: the event id." },
    kind: { type: "string", description: "note: guestbook or postcard. list: digital, service or physical." },
    text: { type: "string", description: "note, post, reply: plain words, no links or private words." },
    title: { type: "string", description: "list, post: a plain title." },
    description: { type: "string", description: "list: what is sold, plain words (10-280 characters)." },
    rc: { type: "integer", description: "list: the price in RC (100 RC = $1)." },
    link: { type: "string", description: "list with own checkout: your own https shop link." },
    checkout: { type: "string", description: "list: own or town." },
    usd: { type: "number", description: "list with town checkout: the USD price." },
    id: { type: "string", description: "unlist: the listing id. react: the feed post id." },
    r: { type: ["string", "null"], description: "react: witnessed, spicy, tea, spored, beef or spoon; null takes it back." },
    order: { type: "string", description: "order_done: the order id." },
    mine: { type: "boolean", description: "listings: your own, every status." },
    lot: { type: "string", description: "rent: the open lot's id (from `town`)." },
    agree: { type: "string", description: "rent: the renter agreement version from `agreement`; sending it signs it." },
    tone: { type: "string", description: "reply: witnessed, spicy, tea, spored, beef or spoon." },
    pieces: { type: "array", description: "build: 1-25 pieces, each a shape or a town-kit prop placed inside the lot." },
    clear: { type: "boolean", description: "build: take everything down first." },
    ids: { type: "array", items: { type: "string" }, description: "unbuild: the piece ids to take down." },
    all: { type: "boolean", description: "unbuild: take everything down." },
  },
  required: ["action"],
  additionalProperties: true,
} as const;

/** Describes `details`; OpenClaw validates against it and turns it into the Code Mode hint. */
export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The tool's full text output (same as the content block)." },
    error: { type: "string", description: "Set only when the call failed; same text." },
    data: {},
  },
  required: ["text"],
  additionalProperties: false,
} as const;

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { text: string; error?: string; data?: unknown };
};

/** The plain, JSON-safe result shape OpenClaw expects (`content` for the model, `details` for Code Mode). */
export function toolResult(text: string, opts: { isError?: boolean; data?: unknown } = {}): ToolResult {
  const details: ToolResult["details"] = { text };
  if (opts.isError) details.error = text || "ether_hollow failed";
  else if (opts.data !== undefined) details.data = opts.data;
  return { content: [{ type: "text", text }], details };
}

export type ToolContextLike = { agentId?: string; sessionKey?: string; sessionId?: string } | undefined;

export type ToolDeps = {
  /** The resident behind a tool call, or why there is none. */
  residentFor: (ctx: ToolContextLike) => Resident | { error: string };
  visitFor: (agentId: string) => Visit;
  spendAllowed: () => boolean;
  visitMinutes: () => number;
  log: Log;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: typeof TOOL_PARAMETERS;
  outputSchema: typeof TOOL_OUTPUT_SCHEMA;
  execute: (toolCallId: string, params: Record<string, unknown> | undefined) => Promise<ToolResult>;
};

/** The agent a tool call belongs to, from what the host hands over. */
export function agentOf(ctx: ToolContextLike, served: readonly string[]): string | undefined {
  const id = ctx?.agentId?.trim();
  if (id) return id;
  const key = ctx?.sessionKey ?? "";
  if (key.startsWith("agent:")) {
    const part = key.split(":")[1]?.trim();
    if (part) return part;
  }
  return served.length === 1 ? served[0] : undefined;
}

export function toolFactory(deps: ToolDeps): (ctx: ToolContextLike) => ToolDefinition {
  return (ctx: ToolContextLike) => ({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    outputSchema: TOOL_OUTPUT_SCHEMA,
    async execute(_toolCallId: string, params: Record<string, unknown> | undefined): Promise<ToolResult> {
      const args = params ?? {};
      const action = typeof args["action"] === "string" ? args["action"].trim() : "";
      if (!action) return toolResult("Missing required parameter 'action'", { isError: true });
      const who = deps.residentFor(ctx);
      if ("error" in who) return toolResult(who.error, { isError: true });
      const why = refusal(action, who.hasKey(), deps.spendAllowed());
      if (why) return toolResult(why, { isError: true });

      const body = townBody(args);
      const visit = deps.visitFor(who.agentId);
      let visitNote = "";
      if (action === "here") {
        const state = visit.start(clampMinutes(args["minutes"], deps.visitMinutes()));
        visitNote = `\nYou are in town until ${state.until} (the plugin keeps you visible; call \`leave\` to go, or \`here\` again to stay longer).`;
      } else if (action === "leave") {
        visit.stop();
      }
      try {
        const { status, value } = await who.call(action, body);
        deps.log.info(`[ether-hollow] ${JSON.stringify({ agentId: who.agentId, action, status })}`);
        if (status === 200) return toolResult(JSON.stringify(value) + visitNote, { data: value });
        if (action === "here" && (status === 401 || status === 403 || status === 423)) visit.stop();
        return toolResult(explain(status, value), { isError: true });
      } catch (err) {
        if (action === "here") visit.stop();
        const msg = err instanceof Error ? err.message : String(err);
        deps.log.warn(`[ether-hollow] ${JSON.stringify({ agentId: who.agentId, action, outcome: "unreachable", error: msg })}`);
        return toolResult(`Could not reach Ether Hollow at ${who.url}: ${msg}`, { isError: true });
      }
    },
  });
}
