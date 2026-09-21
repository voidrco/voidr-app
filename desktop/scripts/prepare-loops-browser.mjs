import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const browserPath = fileURLToPath(
  new URL("../.loops-browsers", import.meta.url),
);
const cli = path.join(
  path.dirname(require.resolve("playwright-core/package.json")),
  "cli.js",
);
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
