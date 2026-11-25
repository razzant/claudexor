#!/usr/bin/env node
/**
 * Internal candidate-assets driver for scripts/smoke-remote-install-ssh.sh:
 * calls the built install modules in packages/cli/dist against the harness's
 * local container (`ssh://remote@127.0.0.1:<port>`) over its isolated ssh
 * wrapper, re-signing local candidate assets with an ephemeral key. Does NOT
 * prove real CLI argv or the pinned release key (use `--published` for that).
 *
 * Linux CI only: requires the harness's private work directory env marker and
 * exact positional args (`ASSETS_DIR PORT`); derives `out` and `bin/ssh` from
 * that work directory and never accepts a host, user, or ssh-program argument.
 * It runs with an empty environment plus the variables below, and refuses
 * any other inherited variable, so no runner secret reaches it or its ssh.
 */
import { generateKeyPairSync } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { signRemoteRuntimeManifest } from "./lib/remote-runtime-manifest-contract.mjs";

const ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "CI",
  "GITHUB_ACTIONS",
  "CLAUDEXOR_REMOTE_INSTALL_SMOKE_WORK",
]);

function fail(message) {
  console.error(`remote install smoke: ${message}`);
  process.exit(1);
}

const safe = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._:/-]+$/.test(value) ? value : "unknown";

async function runCandidateAssetsSmoke(argv) {
  const ci = process.env.CI;
  const inCi = ci === "true" || ci === "1" || process.env.GITHUB_ACTIONS === "true";
  if (process.platform !== "linux" || !inCi) {
    fail("Linux CI only");
  }
  const workDir = process.env.CLAUDEXOR_REMOTE_INSTALL_SMOKE_WORK ?? "";
  if (!isAbsolute(workDir) || process.env.HOME !== join(workDir, "controller-home")) {
    fail("must run inside smoke-remote-install-ssh.sh");
  }
  const inherited = Object.keys(process.env).filter((name) => !ENVIRONMENT.has(name));
  if (inherited.length > 0) {
    fail(`must start with an empty environment (inherited ${inherited.length} variables)`);
  }
  if (argv.length !== 2) {
    fail("expected ASSETS_DIR and PORT");
  }
  const [assetsDir, portText] = argv;
  const validPort = /^[1-9][0-9]{0,4}$/.test(portText) && Number(portText) <= 65_535;
  if (assetsDir.length === 0 || !validPort) {
    fail("missing candidate-assets fixture parameters");
  }
  const outDir = join(workDir, "out");
  const sshProgram = join(workDir, "bin", "ssh");
  const destination = `ssh://remote@127.0.0.1:${portText}`;
  try {
    const dist = new URL("../packages/cli/dist/", import.meta.url);
    const { installRemoteHost } = await import(new URL("remote-host-install.js", dist));
    const { preflightRemoteHost } = await import(new URL("remote-host-preflight.js", dist));
    const { systemSshTransport } = await import(new URL("remote-host-transport.js", dist));
    const { remoteRuntimeManifestUrl } = await import(new URL("remote-host-manifest.js", dist));

    // Candidate (unsigned) or published (signed) manifest: drop the seal fields
    // and seal the same facts again with this run's key.
    const manifestPath = join(assetsDir, "remote-runtime-manifest.json");
    const facts = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const seal of ["signature", "keyId", "algorithm", "schemaVersion", "kind"]) {
      delete facts[seal];
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const authority = {
      keyId: "claudexor-remote-install-smoke-only",
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const manifest = signRemoteRuntimeManifest(
      facts,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      authority,
    );
    const archives = new Map(
      manifest.assets.map((asset) => [asset.archiveUrl, join(assetsDir, asset.archiveName)]),
    );
    const fetchImpl = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === remoteRuntimeManifestUrl(manifest.version)) {
        return new Response(JSON.stringify(manifest));
      }
      const file = archives.get(url);
      if (file) return new Response(Readable.toWeb(createReadStream(file)));
      return new Response("not found", { status: 404 });
    };
    const deps = {
      transport: systemSshTransport(destination, sshProgram),
      fetchImpl,
      authority,
      version: manifest.version,
    };
    const save = (name, value) =>
      writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

    const empty = await preflightRemoteHost(destination, deps);
    save("preflight-empty", empty);
    if (
      empty.state !== "empty" ||
      empty.server.user !== "remote" ||
      empty.server.home !== "/home/remote" ||
      empty.server.target !== "linux-x64" ||
      !Array.isArray(empty.server.hostKeys) ||
      empty.server.hostKeys.length === 0 ||
      empty.install?.sudo !== false ||
      empty.install?.version !== manifest.version ||
      empty.install?.buildSha !== manifest.buildSha ||
      !/^[0-9a-f]{64}$/.test(empty.digest ?? "")
    ) {
      fail(`unexpected empty preflight (state=${safe(empty?.state)})`);
    }
    const stillEmpty = await deps.transport.run('test ! -e "$HOME/.claudexor"');
    if (stillEmpty.localFailure !== undefined || stillEmpty.status !== 0) {
      fail("preflight mutated the empty host before install");
    }
    const installed = await installRemoteHost(destination, empty.digest, deps);
    save("install", installed);
    const ownPointer = new RegExp(
      `^versions/${manifest.version.replaceAll(".", "\\.")}-${empty.install.archiveSha256}-[0-9a-f]{32}$`,
    );
    if (
      installed.outcome !== "installed" ||
      installed.runtime.version !== manifest.version ||
      installed.runtime.buildSha !== manifest.buildSha ||
      !ownPointer.test(installed.runtime.pointer)
    ) {
      fail(`unexpected install answer (outcome=${safe(installed?.outcome)})`);
    }
    // Install starts no daemon; connecting is the separate `remote bootstrap`.
    const noDaemon = await deps.transport.run(
      'test ! -e "$HOME/.claudexor/v3/daemon/claudexord.sock"',
    );
    if (noDaemon.localFailure !== undefined || noDaemon.status !== 0) {
      fail("install left a daemon socket before the separate connect step");
    }
    const after = await preflightRemoteHost(destination, deps);
    save("preflight-installed", after);
    if (
      after.state !== "installed" ||
      after.install !== null ||
      after.digest !== null ||
      after.runtime?.version !== installed.runtime.version ||
      after.runtime?.buildSha !== installed.runtime.buildSha ||
      after.runtime?.pointer !== installed.runtime.pointer
    ) {
      fail(`unexpected installed preflight (state=${safe(after?.state)})`);
    }
    const repeat = await installRemoteHost(destination, empty.digest, deps).then(
      () => null,
      (error) => error,
    );
    if (repeat?.code !== "preflight_changed") {
      fail(`second install was not refused with preflight_changed (code=${safe(repeat?.code)})`);
    }
    for (const [name, value] of Object.entries({ empty, installed, after })) {
      if (/"(token|endpoint)"/.test(JSON.stringify(value))) {
        fail(`${name} carries a daemon endpoint`);
      }
    }
    console.log(JSON.stringify({ version: manifest.version, pointer: installed.runtime.pointer }));
  } catch (error) {
    fail(`driver failed (code=${safe(error?.code)})`);
  }
}

await runCandidateAssetsSmoke(process.argv.slice(2));
