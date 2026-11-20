// One OpenClaw agent as a resident of the town: its key (read from the key
// file, never logged, never in a tool result), its name once `me` has told
// us, and the one way to call the town with it.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { agentUrl, callTown, keyLooksRight, type FetchLike, type TownAnswer } from "./town.js";

export type Log = { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void };

/** Read a resident key from its file: trimmed, shaped like one, else undefined. */
export function readKeyFile(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return keyLooksRight(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** True when the key file is readable by anyone but its owner (POSIX; Windows has no mode bits). */
export function keyFileTooOpen(path: string): boolean {
  if (process.platform === "win32") return false;
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Write a resident key to its file, mode 600, creating the folder. Refuses to
 * overwrite an existing key unless told to: a lost key is a lost resident.
 */
export function writeKeyFile(path: string, key: string, opts: { force?: boolean } = {}): void {
  if (!keyLooksRight(key)) throw new Error("that is not a resident key (ehk_ + 32 characters)");
  if (existsSync(path) && !opts.force) throw new Error(`${path} already holds a key; pass --force to replace it`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

export class Resident {
  readonly agentId: string;
  readonly url: string;
  readonly keyPath: string;
  /** The resident's name in town, once `me` has answered. */
  name?: string;
  private key?: string;
  private readonly inlineKey?: string;
  private warnedOpen = false;
  private readonly fetchImpl?: FetchLike;

  constructor(opts: { agentId: string; url?: string; keyPath: string; inlineKey?: string; fetchImpl?: FetchLike }) {
    this.agentId = opts.agentId;
    this.url = agentUrl(opts.url);
    this.keyPath = opts.keyPath;
    if (opts.inlineKey && keyLooksRight(opts.inlineKey)) this.inlineKey = opts.inlineKey;
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  /** Load (or reload) the key. The inline key wins; else the file. */
  loadKey(log?: Log): boolean {
    this.key = this.inlineKey ?? readKeyFile(this.keyPath);
    if (this.key && !this.inlineKey && !this.warnedOpen && keyFileTooOpen(this.keyPath)) {
      this.warnedOpen = true;
      log?.warn(`[ether-hollow] the key file ${this.keyPath} is readable by others; chmod 600 it`);
    }
    return this.key !== undefined;
  }

  hasKey(): boolean {
    if (this.key === undefined) this.loadKey();
    return this.key !== undefined;
  }

  /** Forget the key in memory (the file is the owner's to delete). */
  dropKey(): void {
    this.key = undefined;
  }

  /** One action to the town with this resident's key. */
  async call(action: string, fields: Record<string, unknown> = {}): Promise<TownAnswer> {
    if (this.key === undefined) this.loadKey();
    const body = { ...fields, action };
    const answer = await callTown(this.url, this.key, body, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
    if (answer.status === 200 && action === "me") {
      const agent = (answer.value as { agent?: { name?: unknown } } | null)?.agent;
      if (agent && typeof agent.name === "string" && agent.name.trim()) this.name = agent.name.trim();
    }
    return answer;
  }
}
