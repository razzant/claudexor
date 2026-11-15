/**
 * Test support for suites that start real processes (#694): how a test measures
 * the identity of a process it started, reads what a fixture published, and ends
 * its own processes. One home, so each rule is written once: a failed `ps` read is
 * unknown (never "gone", never "alive"), a published PID is a whole decimal above
 * 1, and a process is signalled only while its PID still names the start time the
 * test measured. Nothing here signals a group or matches a name.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bounded wait for a condition (a failure detector, never the success path). */
export async function until(what: string, condition: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A process identity: its PID and its measured kernel start time, so a recycled
 * PID never reads as the same process on a busy host. */
export interface Identity {
  pid: number;
  start: string;
}

/** The start time of `pid`: its text, `gone` when ps names no such process, or
 * null when ps itself failed (unknown: never read as gone, never as alive). */
export const startOf = (pid: number): string | "gone" | null => {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)])
        .toString()
        .trim() || "gone"
    );
  } catch (error) {
    // ps exits 1 with no output for a pid it does not find.
    const status = (error as { status?: number }).status;
    const out = String((error as { stdout?: unknown }).stdout ?? "").trim();
    return status === 1 && out === "" ? "gone" : null;
  }
};

/** A published PID: a whole positive decimal above 1, or the record is defective. */
export function publishedPid(text: string, source: string): number {
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) <= 1)
    throw new Error(`${source} published ${JSON.stringify(text)}, not a process id`);
  return Number(text);
}

/** The PIDs published so far in `dir`: one file per publication, put there by
 * rename (whole or absent), holding decimals separated by whitespace. */
export function publishedPids(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".tmp"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split(/\s+/)
        .filter(Boolean)
        .map((text) => publishedPid(text, join(dir, name))),
    );
}

/** Read until every answer is known (a failed ps read is retried, never guessed). */
export async function known<T>(what: string, read: () => Array<T | null>): Promise<T[]> {
  const end = Date.now() + 30_000;
  for (;;) {
    const answers = read();
    if (!answers.includes(null)) return answers as T[];
    if (Date.now() > end) throw new Error(`timed out reading ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Each PID with its measured start; one that ended before it was identified is
 * an error, never an identity. */
export async function identify(pids: number[]): Promise<Identity[]> {
  const starts = await known("the start time of each process", () => pids.map(startOf));
  return pids.map((pid, index) => {
    if (starts[index] === "gone") throw new Error(`process ${pid} ended before it was identified`);
    return { pid, start: starts[index]! };
  });
}

/** `alive`: the same process still runs; `ended`: gone, or its PID names another
 * start; null: the read failed, which proves neither. */
export const stateOf = (id: Identity): "alive" | "ended" | null => {
  const now = startOf(id.pid);
  return now === null ? null : now === id.start ? "alive" : "ended";
};

/** Whether every one of them is that same process, once each answer is known. */
export const allAlive = async (ids: Identity[]): Promise<boolean> =>
  (await known("the state of each process", () => ids.map(stateOf))).every(
    (state) => state === "alive",
  );

/** Every one of them is proven ended (an unknown read is not an end). */
export const allEnded = (ids: Identity[]): boolean => ids.every((id) => stateOf(id) === "ended");

/**
 * End the test's own processes in `own` by measured identity, emptying the list:
 * an entry stays in custody until its end is proven (gone, or its PID now names
 * another start), an unknown read keeps it and reads again, and the cleanup fails
 * loudly if one cannot be proven ended within the bound.
 */
export async function endIdentified(own: Identity[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (own.length > 0) {
    for (const entry of [...own]) {
      const now = startOf(entry.pid);
      if (now === null) continue; // unknown: keep it and read again
      if (now !== entry.start) {
        own.splice(own.indexOf(entry), 1);
        continue;
      }
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* its end is proven by the next read, not by this */
      }
    }
    if (own.length === 0) return;
    if (Date.now() > deadline)
      throw new Error(`own test processes not proven ended: ${JSON.stringify(own)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The held part of a fixture filter: ONE process that waits for `release` (or for
 * its test directory to go) and then passes its input through. A signal sent to
 * its group ends it at once. A `/bin/sh` loop of short `sleep`s does not do that
 * reliably: the shell can miss a SIGINT that lands just as a `sleep` exits, and
 * would then stand for a survivor no test meant. */
export const HOLD_JS =
  "const fs=require('node:fs');const [release,root]=process.argv.slice(2);" +
  "const t=setInterval(()=>{if((release&&fs.existsSync(release))||!fs.existsSync(root)){" +
  "clearInterval(t);process.stdin.pipe(process.stdout);}},20);";

/** Write that program under `root`; returns the shell words that `exec` it. */
export function holdUntil(root: string, release: string): string {
  const program = join(root, "hold-until.cjs");
  writeFileSync(program, HOLD_JS);
  return `exec '${process.execPath}' '${program}' '${release}' '${root}'`;
}

/**
 * A filter that leaves a process behind: it starts one detached child with no
 * pipes (`left.cjs`: it publishes `{pid, scope}` — its PID and the scope markers
 * it carries — by rename, then lives until its test directory goes, or for
 * `life` ms), waits until the child published itself, and then holds (`hold`),
 * fails (`fail`) or passes its input through (`pass`). The child is in no group
 * and on no pipe of the filter's Git: that Git's own end says nothing of it.
 * Returns the filter's command and what the children published so far.
 */
export function leavingFilter(
  root: string,
  mode: "hold" | "fail" | "pass",
  life = 0,
): { command: string; left: () => Array<{ pid: number; scope: string[] }> } {
  const pids = join(root, "left");
  const child = join(root, "left.cjs");
  const filter = join(root, "leaving-filter.cjs");
  writeFileSync(
    child,
    "const fs=require('node:fs');const [pids,root,life]=process.argv.slice(2);" +
      "const scope=Object.keys(process.env).filter((k)=>k.startsWith('CLAUDEXOR_RUN_SCOPE_'));" +
      "fs.mkdirSync(pids,{recursive:true});const own=pids+'/'+process.pid;" +
      "fs.writeFileSync(own+'.tmp',JSON.stringify({pid:process.pid,scope}));fs.renameSync(own+'.tmp',own);" +
      "const end=Number(life)>0?Date.now()+Number(life):Infinity;" +
      "setInterval(()=>{if(!fs.existsSync(root)||Date.now()>end)process.exit(0);},25);",
  );
  writeFileSync(
    filter,
    "const fs=require('node:fs');const [mode,child,pids,root,life]=process.argv.slice(2);" +
      "const c=require('node:child_process').spawn(process.execPath,[child,pids,root,life],{detached:true,stdio:'ignore'});c.unref();" +
      "const t=setInterval(()=>{if(!fs.existsSync(pids+'/'+c.pid))return;clearInterval(t);" +
      "if(mode==='fail')process.exit(1);if(mode==='pass'){process.stdin.pipe(process.stdout);return;}" +
      "setInterval(()=>{if(!fs.existsSync(root))process.exit(0);},25);},10);",
  );
  return {
    command: `'${process.execPath}' '${filter}' ${mode} '${child}' '${pids}' '${root}' ${life}`,
    left: () =>
      existsSync(pids)
        ? readdirSync(pids)
            .filter((name) => !name.endsWith(".tmp"))
            .map((name) => {
              const published = JSON.parse(readFileSync(join(pids, name), "utf8")) as {
                pid: number;
                scope: string[];
              };
              publishedPid(String(published.pid), join(pids, name));
              return published;
            })
        : [],
  };
}
