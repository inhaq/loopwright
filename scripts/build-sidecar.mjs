#!/usr/bin/env node
/**
 * Compiles the engine server (src/server/index.ts) into a single self-contained
 * executable and places it where Tauri expects a sidecar binary:
 *
 *   desktop/src-tauri/binaries/loopwright-engine-<target-triple>
 *
 * Tauri resolves a sidecar declared as `binaries/loopwright-engine` by
 * appending the host target triple, so the file MUST carry that suffix. The
 * triple is read from `rustc -Vv` (overridable via --target / TAURI_ENV_TARGET_TRIPLE
 * for cross-compiles).
 *
 * Uses Bun's `--compile` because it bundles TypeScript directly and emits one
 * standalone binary with no node_modules to ship. Run with:
 *
 *   npm run build:sidecar
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple() {
  const explicit =
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    argValue("--target");
  if (explicit) return explicit;
  try {
    const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith("host:"));
    if (line) return line.slice("host:".length).trim();
  } catch {
    /* rustc not available */
  }
  throw new Error(
    "Could not determine target triple. Install rustc, or pass --target <triple> " +
      "(e.g. x86_64-unknown-linux-gnu, aarch64-apple-darwin, x86_64-pc-windows-msvc).",
  );
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function bunBinary() {
  return process.env.BUN_PATH || "bun";
}

const triple = hostTriple();
const isWindows = triple.includes("windows");
const ext = isWindows ? ".exe" : "";
const outDir = resolve(root, "desktop/src-tauri/binaries");
const outFile = resolve(outDir, `loopwright-engine-${triple}${ext}`);
const entry = resolve(root, "src/server/index.ts");

mkdirSync(outDir, { recursive: true });

console.log(`Building sidecar for ${triple}`);
console.log(`  entry:  ${entry}`);
console.log(`  output: ${outFile}`);

const args = ["build", entry, "--compile", "--outfile", outFile];
const target = bunCompileTarget(triple);
if (target) args.push(`--target=${target}`);

try {
  execFileSync(bunBinary(), args, { stdio: "inherit", cwd: root });
} catch (err) {
  console.error("\nSidecar build failed.");
  console.error("Ensure Bun is installed (https://bun.sh) or set BUN_PATH.");
  process.exit(typeof err?.status === "number" ? err.status : 1);
}

console.log("\nSidecar built successfully.");

/**
 * Maps a Rust target triple to Bun's `--target` for cross-compiled binaries.
 * Returns undefined to let Bun build for the current host.
 */
function bunCompileTarget(rustTriple) {
  const map = {
    "x86_64-unknown-linux-gnu": "bun-linux-x64",
    "aarch64-unknown-linux-gnu": "bun-linux-arm64",
    "x86_64-apple-darwin": "bun-darwin-x64",
    "aarch64-apple-darwin": "bun-darwin-arm64",
    "x86_64-pc-windows-msvc": "bun-windows-x64",
  };
  return map[rustTriple];
}
