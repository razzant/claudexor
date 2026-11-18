#!/usr/bin/env node
import { deepStrictEqual, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [mode, input] = process.argv.slice(2);
if (mode !== "--tarball" || !input) {
  console.error("usage: verify-npm-claudexor-package.mjs --tarball FILE");
  process.exit(1);
}

const tarball = resolve(input);
// Darwin bsdtar normally hides AppleDouble members even from a verbose listing.
const readOptions = process.platform === "darwin" ? ["--options", "!mac-ext"] : [];
const tar = (flag, ...members) =>
  execFileSync("/usr/bin/tar", [...readOptions, flag, tarball, ...members]);
const bins = ["bin/claudexor.js", "bin/claudexord.js"];
const pi = ["pi/index.js", "pi/mcp.json", "pi/skills/claudexor/SKILL.md"];
const files = ["package.json", "README.md", "LICENSE", ...bins, "bin/libuv-pool.js", ...pi];
const directories = new Set([
  "package/",
  "package/bin/",
  "package/pi/",
  "package/pi/skills/",
  "package/pi/skills/claudexor/",
]);

// packWithSourceModes adds directory entries. Check the exact regular members and
// archive modes, then read fixed members to stdout without extracting a tree.
const names = tar("-tzf").toString().replace(/\n$/, "").split("\n");
const details = tar("-tvzf").toString().replace(/\n$/, "").split("\n");
deepStrictEqual(names.length, details.length, "inconsistent tar listings");
deepStrictEqual(new Set(names).size, names.length, "duplicate tar member");
const regular = [];
for (const [i, name] of names.entries()) {
  const permissions = details[i].split(/\s+/, 1)[0];
  if (permissions.startsWith("d") && directories.has(name)) continue;
  ok(permissions.startsWith("-"), `unexpected tar member type for ${name}: ${permissions}`);
  regular.push(name);
  if (bins.some((path) => name === `package/${path}`)) {
    ok(permissions[3] === "x", `${name} is not owner-executable`);
  }
}
deepStrictEqual(regular.sort(), files.map((path) => `package/${path}`).sort());

const readMember = (path) => tar("-xOzf", `package/${path}`);
const manifest = JSON.parse(readMember("package.json"));
deepStrictEqual(manifest.name, "claudexor");
deepStrictEqual(manifest.mcpName, "io.github.razzant/claudexor");
deepStrictEqual(manifest.type, "module");
ok(typeof manifest.version === "string" && manifest.version.length > 0, "missing package version");
deepStrictEqual(manifest.dependencies, { "@claudexor/cli": manifest.version });
deepStrictEqual(Object.keys(manifest.bin).sort(), ["claudexor", "claudexord"]);
for (const name of ["claudexor", "claudexord"]) {
  deepStrictEqual(manifest.bin[name].replace(/^\.\//, ""), `bin/${name}.js`);
}
deepStrictEqual(manifest.files.toSorted(), ["bin", ...pi]);
deepStrictEqual(manifest.pi, { extensions: ["./pi/index.js"], skills: ["./pi/skills"] });
ok(
  Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package"),
  "missing pi-package keyword",
);
for (const path of pi) {
  const source = new URL(`../packages/claudexor/${path}`, import.meta.url);
  ok(readMember(path).equals(readFileSync(source)), `packed ${path} differs from the source`);
}

console.log(
  `Claudexor npm wrapper verified: executable bins, MCP identity and Pi resources (${manifest.version})`,
);
