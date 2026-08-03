import { build } from "esbuild";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const clientDirectory = resolve(projectRoot, "dist/client");
const buildDirectory = resolve(projectRoot, ".desktop-build");
const binaryDirectory = resolve(projectRoot, "src-tauri/binaries");
const targetTriple = "aarch64-apple-darwin";
const binaryPath = resolve(binaryDirectory, `jarvis-server-${targetTriple}`);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
await mkdir(binaryDirectory, { recursive: true });

const assetMap = {};
for (const path of await filesIn(clientDirectory)) {
  const key = relative(clientDirectory, path).split("\\").join("/");
  assetMap[key] = {
    contentType: contentTypes[extname(path).toLowerCase()] || "application/octet-stream",
    body: (await readFile(path)).toString("base64"),
  };
}

await writeFile(
  resolve(buildDirectory, "assets.generated.mjs"),
  `export const assets = ${JSON.stringify(assetMap)};\n`,
  "utf8",
);

await build({
  entryPoints: [resolve(projectRoot, "desktop/server/index.ts")],
  outfile: resolve(buildDirectory, "server.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
});

const pkgExecutable = resolve(projectRoot, "node_modules/.bin/pkg");
const result = spawnSync(pkgExecutable, [
  "--targets", "node22-macos-arm64",
  "--compress", "GZip",
  "--no-bytecode",
  "--public-packages", "*",
  "--public",
  "--output", binaryPath,
  resolve(buildDirectory, "server.cjs"),
], { cwd: projectRoot, stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);
await chmod(binaryPath, 0o755);
console.log(`Desktop sidecar ready: ${binaryPath}`);
