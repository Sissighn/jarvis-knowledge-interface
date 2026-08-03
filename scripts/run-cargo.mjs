import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

const rustBin = "/opt/homebrew/opt/rustup/bin";
const cargo = `${rustBin}/cargo`;
const executable = existsSync(cargo) ? cargo : "cargo";
const path = [rustBin, process.env.PATH].filter(Boolean).join(delimiter);
const targetDirectory = resolve(process.cwd(), "src-tauri/target.noindex");
const result = spawnSync(executable, process.argv.slice(2), {
  cwd: process.cwd(),
  env: { ...process.env, CARGO_TARGET_DIR: targetDirectory, PATH: path },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
