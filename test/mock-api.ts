// A stand-in for the OpenClaw plugin API: records what the plugin wires so a
// test can call the tool and fire the hooks by name.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type CronAdd = Record<string, unknown>;

export function makeMockApi(pluginConfig: Record<string, unknown>, opts: { cron?: boolean } = {}) {
  const rec = {
    tools: [] as any[],
    hooks: new Map<string, Array<(e: any, c: any) => any>>(),
    lifecycles: [] as any[],
    cronAdds: [] as CronAdd[],
    logs: [] as string[],
  };
  const cron = {
    async add(input: CronAdd) {
      rec.cronAdds.push(input);
      return { id: `job${rec.cronAdds.length}` };
    },
  };
  const api = {
    pluginConfig,
    logger: {
      info(m: string) {
        rec.logs.push(m);
      },
      warn(m: string) {
        rec.logs.push(m);
      },
      error(m: string) {
        rec.logs.push(m);
      },
      debug(m: string) {
        rec.logs.push(m);
      },
    },
    runtime: opts.cron === false ? {} : { cron },
    lifecycle: {
      registerRuntimeLifecycle(l: any) {
        rec.lifecycles.push(l);
      },
    },
    registerTool(t: any) {
      rec.tools.push(t);
    },
    on(name: string, handler: (e: any, c: any) => any) {
      if (!rec.hooks.has(name)) rec.hooks.set(name, []);
      rec.hooks.get(name)!.push(handler);
    },
  };
  const fire = (name: string, event: any, ctx: any) => Promise.all((rec.hooks.get(name) ?? []).map((h) => h(event, ctx)));
  const tool = (ctx: any) => rec.tools[0]!(ctx);
  return { api, rec, fire, tool, cron };
}
