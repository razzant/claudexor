import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isLaunchableExecutable } from "./executable-inspection.js";

/** A vendor entry remains the identity. Its interpreter is only launch transport. */
export interface HarnessInterpreter {
  binary: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HarnessCommand {
  entrypoint: string;
  interpreter?: HarnessInterpreter;
  launcher?: string;
}

function textFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Decode argv syntax, never evaluate shell substitutions or extra commands. */
function words(value: string): string[] | null {
  if (/[\r\n&|<>^%!`$]/.test(value)) return null;
  const out: string[] = [];
  let token = "";
  let quote: string | null = null;
  let started = false;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(token);
  return out;
}

function nodeShebang(
  path: string,
): { args: string[]; rawArgs: string; env: Record<string, string> } | null {
  let line: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(4096);
    const size = readSync(fd, header, 0, header.length, 0);
    const end = header.subarray(0, size).indexOf(10);
    if (end < 0 && size === header.length) return null;
    line = header
      .subarray(0, end < 0 ? size : end)
      .toString("utf8")
      .replace(/\r$/, "");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!line?.startsWith("#!")) return null;
  const parts = words(line.slice(2).trim());
  if (!parts) return null;
  const env: Record<string, string> = {};
  if (parts[0] === "/usr/bin/env") {
    parts.shift();
    if (parts.at(0) === "-S") parts.shift();
    while (parts[0]?.includes("=")) {
      const assignment = parts.shift()!;
      const offset = assignment.indexOf("=");
      const name = assignment.slice(0, offset);
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) return null;
      env[name] = assignment.slice(offset + 1);
    }
  }
  if (!/^(?:node|node\.exe)$/.test(parts.shift() ?? "")) return null;
  const body = line.slice(2).trim();
  const marker = body.match(/(?:^|[ \t])node(?:\.exe)?(?=[ \t]|$)/);
  if (!marker) return null;
  return { args: parts, rawArgs: body.slice(marker.index! + marker[0].length).trim(), env };
}

const NPM_HEAD =
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
  ].join("\n") + "\n";

/** Recognize COMPLETE npm cmd-shim forms, not merely a matching last line. */
function npmShimTarget(path: string): { entrypoint: string; removesJsExtension: boolean } | null {
  const text = textFile(path)?.replace(/\r\n/g, "\n").trimEnd();
  if (!text) return null;
  const target = text.match(/"%(?:dp0%|~dp0)\\([^"]+)"\s+%\*/)?.[1];
  if (!target) return null;
  const entry = resolve(dirname(path), ...target.split("\\"));
  const shebang = /\.(?:exe|com)$/i.test(entry) ? null : nodeShebang(entry);
  const args = shebang?.rawArgs ?? "";
  const vars = Object.entries(shebang?.env ?? {})
    .map(([key, value]) => `@SET ${key}=${value}\n`)
    .join("");
  const native = `${NPM_HEAD}"%dp0%\\${target}"   %*`;
  const node = `${NPM_HEAD}${vars}\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%" ${args} "%dp0%\\${target}" %*`;
  const node8 = node
    .replace('  SET "_prog=node"\n)', '  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)')
    .replace(" & set PATHEXT=%PATHEXT:;.JS;=;% & ", " & ");
  const legacy = `@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe" ${args} "%~dp0\\${target}" %*\n) ELSE (\n  @SETLOCAL\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\n  node ${args} "%~dp0\\${target}" %*\n)`;
  // Insignificant indentation/spacing is normalized only outside quoted words.
  const normalize = (input: string) =>
    input
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  if (
    normalize(text) !== normalize(native) &&
    (!shebang || ![node, node8, legacy].some((form) => normalize(text) === normalize(form)))
  )
    return null;
  // The declared npm bin ties command name and entry without any vendor layout table.
  const command = basename(path).replace(/\.cmd$/i, "");
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const metadata = textFile(join(dir, "package.json"));
    if (metadata) {
      try {
        const pkg = JSON.parse(metadata) as {
          name?: string;
          bin?: string | Record<string, string>;
        };
        const bin =
          typeof pkg.bin === "string"
            ? pkg.name?.split("/").at(-1) === command
              ? pkg.bin
              : undefined
            : pkg.bin?.[command];
        if (typeof bin === "string" && realpathSync(resolve(dir, bin)) === realpathSync(entry))
          return { entrypoint: entry, removesJsExtension: normalize(text) === normalize(node) };
      } catch {
        /* not this package's bin */
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/** A selected file's physical invocation. PATH is already composed by its owner. */
export function commandForFile(
  path: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathDelimiter: string,
  source: NodeJS.ProcessEnv = process.env,
): HarnessCommand | null {
  if (!isLaunchableExecutable(path, platform)) return null;
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(path)) {
    return { entrypoint: path };
  }
  const shim = extname(path).toLowerCase() === ".cmd";
  const decoded = shim ? npmShimTarget(path) : null;
  const entrypoint = shim ? decoded?.entrypoint : path;
  if (!entrypoint || !isLaunchableExecutable(entrypoint, platform)) return null;
  if (/\.(?:exe|com)$/i.test(entrypoint)) {
    return { entrypoint, launcher: path };
  }
  const shebang = nodeShebang(entrypoint);
  if (!shebang) return null;
  const candidates = [
    ...(shim ? [join(dirname(path), "node.exe")] : []),
    ...pathValue
      .split(pathDelimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "node.exe")),
  ];
  const node = candidates.find((candidate) => isLaunchableExecutable(candidate, platform));
  if (!node) return null;
  // npm's SETLOCAL shebang declarations expire at endLocal. The current
  // template applies only this PATHEXT edit AFTER endLocal; older forms do not.
  const pathExt = Object.entries(source).find(([key]) => key.toUpperCase() === "PATHEXT")?.[1];
  const env = shim
    ? decoded?.removesJsExtension && pathExt !== undefined
      ? { PATHEXT: pathExt.replace(/;\.js;/gi, ";") }
      : {}
    : shebang.env;
  const interpreter: HarnessInterpreter = {
    binary: node,
    args: shebang.args,
    ...(Object.keys(env).length ? { env } : {}),
  };
  return {
    entrypoint,
    interpreter,
    ...(shim ? { launcher: path } : {}),
  };
}

export function interpretedCommand(
  entrypoint: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  interpreter?: HarnessInterpreter,
): { binary: string; args: string[]; env: NodeJS.ProcessEnv } {
  return interpreter
    ? {
        binary: interpreter.binary,
        args: [...interpreter.args, entrypoint, ...args],
        env: { ...env, ...interpreter.env },
      }
    : { binary: entrypoint, args: [...args], env };
}
