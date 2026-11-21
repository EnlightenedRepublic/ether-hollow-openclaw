// A town for the tests: one HTTP endpoint that records every request and
// answers each action from a table the test can change.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const KEY = "ehk_" + "a".repeat(32);
export const OTHER_KEY = "ehk_" + "b".repeat(32);

export type Recorded = { action: string; body: Record<string, unknown>; auth?: string };
export type Answer = { status: number; json: unknown };
export type Answerer = (body: Record<string, unknown>, req: Recorded) => Answer;

export const PLACES = [
  { id: "square", name: "Town Square", kind: "street" },
  { id: "lot1", name: "Lot 1", kind: "lot", owner: null, for_sale: true, price_rc: 0, rent_rc_month: 500 },
  { id: "bay_gion", name: "Gion's bay", kind: "bay", maker: "gion", bay: 1 },
];

export function defaultAnswers(state: { feed: unknown[]; orders: unknown[]; me: Record<string, unknown> }): Record<string, Answerer> {
  return {
    register: (body) => {
      const name = typeof body["name"] === "string" ? body["name"] : "";
      if (!/^[A-Za-z0-9 _-]{3,24}$/.test(name)) return { status: 400, json: { error: "name" } };
      if (name.toLowerCase() === "taken") return { status: 409, json: { error: "that name is taken" } };
      return {
        status: 200,
        json: { key: KEY, agent: { aid: "a1", name, bio: body["bio"] ?? "", pid: "P-0001", place: "square" }, where: "square", note: "Welcome. Call `town` to look around." },
      };
    },
    me: () => ({ status: 200, json: state.me }),
    town: () => ({
      status: 200,
      json: { town: "Ether Hollow", now: new Date().toISOString(), places: PLACES, bays: [], signs: [], online: { crew: [], ai: [], in_town_now: 1 }, events: [], feed: state.feed, market: [] },
    }),
    orders: () => ({ status: 200, json: { orders: state.orders } }),
    here: () => ({ status: 200, json: { ok: true, in_town: true } }),
    leave: () => ({ status: 200, json: { ok: true, in_town: false } }),
    agreement: () => ({ status: 200, json: { version: "v1", text: "Rent is 500 RC a month, taken on the 1st." } }),
    rent: (body) => (body["agree"] === "v1" ? { status: 200, json: { ok: true, lease: { lot: body["lot"], rent_rc_month: 500 } } } : { status: 400, json: { error: "agree the agreement first" } }),
    buy: () => ({ status: 402, json: { error: "not enough RC" } }),
    move: (body) => (PLACES.some((p) => p.id === body["to"]) ? { status: 200, json: { ok: true, place: body["to"] } } : { status: 404, json: { error: "no such place" } }),
  };
}

export class MockTown {
  requests: Recorded[] = [];
  state = { feed: [] as unknown[], orders: [] as unknown[], me: { agent: { name: "Moss", pid: "P-0001", place: "square" }, rc: 25, lease: null, timeout: null } as Record<string, unknown> };
  answers: Record<string, Answerer> = defaultAnswers(this.state);
  /** Keys the town knows. */
  keys = new Set([KEY]);
  /** When set, every authenticated action answers this instead (e.g. 423 for a timeout). */
  override?: Answer;
  private server?: Server;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(data || "{}");
        } catch {
          /* bad json */
        }
        const auth = req.headers["authorization"];
        const rec: Recorded = { action: String(body["action"] ?? ""), body, ...(typeof auth === "string" ? { auth } : {}) };
        this.requests.push(rec);
        const send = (a: Answer) => {
          res.writeHead(a.status, { "content-type": "application/json" });
          res.end(JSON.stringify(a.json));
        };
        if (req.url !== "/api/agent" || req.method !== "POST") return send({ status: 404, json: { error: "not here" } });
        if (rec.action !== "register") {
          const key = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
          if (!this.keys.has(key)) return send({ status: 401, json: { error: "unknown key" } });
          if (this.override) return send(this.override);
        }
        const answerer = this.answers[rec.action];
        send(answerer ? answerer(body, rec) : { status: 200, json: { ok: true, action: rec.action } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  actions(): string[] {
    return this.requests.map((r) => r.action);
  }
}
