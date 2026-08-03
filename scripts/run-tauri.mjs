import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

const projectRoot = process.cwd();
const tauriExecutable = resolve(projectRoot, "node_modules/.bin/tauri");
const tauriTargetDirectory = resolve(projectRoot, "src-tauri/target.noindex");
const rustBin = "/opt/homebrew/opt/rustup/bin";
const path = [rustBin, process.env.PATH].filter(Boolean).join(delimiter);

const result = spawnSync(tauriExecutable, process.argv.slice(2), {
  cwd: projectRoot,
  // The .noindex suffix keeps generated app bundles out of Spotlight and Launchpad.
  env: { ...process.env, CARGO_TARGET_DIR: tauriTargetDirectory, PATH: path },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
