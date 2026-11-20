// The hashbang comes from esbuild's banner (esbuild.mjs); one here would double it.
import { main } from "./cli-main.js";

main(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
}).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
