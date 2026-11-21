import { build } from "esbuild";

// One file for the gateway to load, one for the owner's `register` command.
// No dependencies: the town is plain HTTPS through Node's own fetch.
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["node:*"],
};

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  banner: { js: "// ether-hollow-openclaw: the plugin\n" },
});
console.log("ether-hollow-openclaw built to dist/index.js");

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
console.log("ether-hollow-openclaw register CLI built to dist/cli.js");
