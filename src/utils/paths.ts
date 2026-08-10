import os from "node:os";
import path from "node:path";

/** Resolve the current user's home at call time for Windows, WSL, and tests. */
export function getHomeDirectory(): string {
  const candidate = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error("A valid absolute home directory is required");
  }
  return path.resolve(candidate);
}

export function resolveHomePath(value: string): string {
  if (value === "~") return getHomeDirectory();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(getHomeDirectory(), value.slice(2));
  }
  return value;
}

export function getAutomatonDirectory(): string {
  return path.join(getHomeDirectory(), ".automaton");
}
