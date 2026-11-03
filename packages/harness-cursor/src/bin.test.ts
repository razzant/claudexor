import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLaunchableExecutable, resolveHarnessBinary } from "@claudexor/core";
import { resolveCursorBin } from "./bin.js";

const roots: string[] = [];
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "cursor-bin-"));
  roots.push(root);
  return root;
}
/** A file the resolver may accept as launchable. Nothing in this suite runs
 * it: resolution reads names, modes and links only, so its bytes are inert. */
function exe(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "resolved, never executed\n");
  chmodSync(path, 0o755);
  return path;
}
function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}
/** The vendor installer's layout: `<root>/cursor-agent/versions/<v>/cursor-agent`. */
function cursorInstall(root: string, version = "2026.09.26-dd393fe"): string {
  return exe(join(root, "share", "cursor-agent", "versions", version, "cursor-agent"));
}
/** Resolution over an EXACT PATH with core's own launchability rule, so these
 * cases never depend on what the host has in its system directories. */
function onPath(...dirs: string[]): (bin: string) => string | null {
  return (bin) => {
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      if (isLaunchableExecutable(candidate)) return candidate;
    }
    return null;
  };
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

// Pure resolver decisions: no links and nothing executed, so they hold on
// every platform.
describe("resolveCursorBin", () => {
  it("returns the explicit override verbatim without looking anything up", () => {
    const looked: string[] = [];
    const bin = resolveCursorBin({ CLAUDEXOR_CURSOR_BIN: "/opt/cursor" }, (name) => {
      looked.push(name);
      return null;
    });
    expect(bin).toBe("/opt/cursor");
    expect(looked).toEqual([]);
  });

  it("keeps the bare cursor-agent name whenever it resolves, without consulting agent", () => {
    const looked: string[] = [];
    const bin = resolveCursorBin({}, (name) => {
      looked.push(name);
      return `/normalized/bin/${name}`;
    });
    expect(bin).toBe("cursor-agent");
    expect(looked).toEqual(["cursor-agent"]);
  });

  it("never returns an agent that is not the binary inside a Cursor install", () => {
    const root = sandbox();
    exe(join(root, "plain", "agent"));
    // The install layout is present, but the `agent` on PATH is not it.
    cursorInstall(root);
    expect(resolveCursorBin({}, onPath(join(root, "plain")))).toBe("cursor-agent");
  });

  it("rejects a relative agent answer from the resolver", () => {
    expect(resolveCursorBin({}, (name) => (name === "agent" ? "agent" : null))).toBe(
      "cursor-agent",
    );
  });

  it("falls back to the legacy name when neither command exists", () => {
    expect(resolveCursorBin({}, () => null)).toBe("cursor-agent");
  });

  it("finds no launcher in the current Windows install, which has only script launchers", () => {
    // %LOCALAPPDATA%\cursor-agent as the current install.ps1 (2026.09.26-dd393fe)
    // leaves it for its x64 and arm64 packages: they contain no
    // `cursor-agent.exe`, so its conditional `.exe` alias copy does not run,
    // leaving `.cmd`/`.ps1` launchers, their `agent.*` copies, and the
    // `node.exe` they start through PowerShell. Claudexor never spawns a
    // harness through a shell, so neither name resolves under the win32 rule.
    // Resolution only: nothing here is executed.
    const root = join(sandbox(), "cursor-agent");
    for (const name of ["cursor-agent.cmd", "cursor-agent.ps1", "agent.cmd", "agent.ps1"])
      exe(join(root, name));
    for (const name of ["cursor-agent.cmd", "cursor-agent.ps1", "node.exe", "index.js"])
      exe(join(root, "versions", "2026.09.26-dd393fe", name));
    const looked: string[] = [];
    const bin = resolveCursorBin({}, (name) => {
      looked.push(name);
      return resolveHarnessBinary(name, { HOME: root, PATH: root }, "/no/such/node", "win32");
    });
    expect(bin).toBe("cursor-agent");
    expect(looked).toEqual(["cursor-agent", "agent"]);
  });
});

// install.sh links `~/.local/bin/agent` and `cursor-agent` into
// `versions/<v>/cursor-agent`, and the realpath rule is proven over real
// symlinks. Windows creates those only with a privilege, and Cursor's Windows
// installer copies instead of linking, so these cases are POSIX-only.
describe.skipIf(process.platform === "win32")("resolveCursorBin over installer links", () => {
  it("returns the absolute launcher of an agent that resolves into a Cursor install", () => {
    const root = sandbox();
    const launcher = link(cursorInstall(root), join(root, "bin", "agent"));
    expect(resolveCursorBin({}, onPath(join(root, "bin")))).toBe(launcher);
  });

  it("skips a dangling cursor-agent link an update left behind and uses the verified agent", () => {
    const root = sandbox();
    const bin = join(root, "bin");
    link(
      join(root, "share", "cursor-agent", "versions", "gone", "cursor-agent"),
      join(bin, "cursor-agent"),
    );
    const launcher = link(cursorInstall(root), join(bin, "agent"));
    expect(resolveCursorBin({}, onPath(bin))).toBe(launcher);
  });

  it("never returns an agent linked to a lookalike outside the install layout", () => {
    const root = sandbox();
    // A link to a same-named file outside the layout.
    link(exe(join(root, "elsewhere", "cursor-agent")), join(root, "lookalike", "agent"));
    // Right basenames, wrong parent: not `<...>/cursor-agent/versions/<v>/`.
    link(
      exe(join(root, "share", "other", "versions", "1", "cursor-agent")),
      join(root, "wrongroot", "agent"),
    );
    for (const dir of ["lookalike", "wrongroot"]) {
      expect(resolveCursorBin({}, onPath(join(root, dir)))).toBe("cursor-agent");
    }
  });

  it("only considers the first agent the child would see", () => {
    // A Cursor agent shadowed by an unrelated one is not discovered: the scan
    // stops where name resolution stops, and nothing is executed to probe it.
    const root = sandbox();
    exe(join(root, "first", "agent"));
    link(cursorInstall(root), join(root, "second", "agent"));
    expect(resolveCursorBin({}, onPath(join(root, "first"), join(root, "second")))).toBe(
      "cursor-agent",
    );
  });
});

// The default lookup is the harness PATH every Cursor spawn uses. These cases
// place the fixture under a temporary HOME and stand down when the host itself
// has either command outside HOME, so no host binary can answer for them. They
// are POSIX-only: the fixture is the installer's links, and on Windows the
// default lookup takes only `.exe`/`.com` images.
const emptyHome = mkdtempSync(join(tmpdir(), "cursor-bin-host-"));
const hostHasCursorNames = ["cursor-agent", "agent"].some(
  (name) => resolveHarnessBinary(name, { HOME: emptyHome, PATH: "" }) !== null,
);
rmSync(emptyHome, { recursive: true, force: true });

describe.skipIf(process.platform === "win32" || hostHasCursorNames)(
  "resolveCursorBin on the harness PATH",
  () => {
    it("finds the installer's ~/.local/bin/agent even when the inherited PATH lacks it", () => {
      const home = sandbox();
      const launcher = link(
        cursorInstall(join(home, ".local")),
        join(home, ".local", "bin", "agent"),
      );
      expect(resolveCursorBin({ HOME: home, PATH: "" })).toBe(launcher);
    });

    it("judges the agent the child would run, not an inherited-PATH agent behind it", () => {
      // An unrelated agent in a harness-PATH prefix outranks the inherited
      // entry, so a Cursor agent there must not be vouched for by name.
      const home = sandbox();
      exe(join(home, ".local", "bin", "agent"));
      const inherited = join(home, "custom", "bin");
      link(cursorInstall(home), join(inherited, "agent"));
      expect(resolveCursorBin({ HOME: home, PATH: [inherited].join(delimiter) })).toBe(
        "cursor-agent",
      );
    });
  },
);
