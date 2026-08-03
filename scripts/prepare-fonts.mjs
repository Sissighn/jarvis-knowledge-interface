import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const targetDirectory = resolve(projectRoot, "public/fonts");

await mkdir(targetDirectory, { recursive: true });
await Promise.all([
  copyFile(
    resolve(projectRoot, "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2"),
    resolve(targetDirectory, "Geist-Variable.woff2"),
  ),
  copyFile(
    resolve(projectRoot, "node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2"),
    resolve(targetDirectory, "GeistMono-Variable.woff2"),
  ),
  copyFile(
    resolve(projectRoot, "node_modules/geist/LICENSE.txt"),
    resolve(targetDirectory, "LICENSE.txt"),
  ),
]);
