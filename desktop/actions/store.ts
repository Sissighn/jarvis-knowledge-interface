/** Owner-only file storage for local credentials. Nothing here ever leaves this Mac. */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { databaseDirectory } from "../indexer/config";

const SECRET_FILE_MODE = 0o600;

function secretPath(fileName: string) {
  return resolve(databaseDirectory(), fileName);
}

export function readSecret<T>(fileName: string): T | null {
  try {
    return JSON.parse(readFileSync(secretPath(fileName), "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeSecret(fileName: string, value: unknown) {
  const path = secretPath(fileName);
  mkdirSync(databaseDirectory(), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: SECRET_FILE_MODE });
  // writeFileSync only applies the mode when it creates the file.
  chmodSync(path, SECRET_FILE_MODE);
}

export function clearSecret(fileName: string) {
  rmSync(secretPath(fileName), { force: true });
}
