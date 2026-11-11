/** Release checks consume the same declarations and pick rules as maintenance. */
export async function checkHarnessPrograms(programs, deps, options = {}) {
  const checks = [];
  const sources = new Map();
  for (const program of programs) {
    for (const [platform, data] of Object.entries(program.platforms)) {
      for (const arch of Object.keys(data.architectures ?? { [deps.arch]: deps.arch })) {
        const source = deps.newestSource(program, platform, arch);
        if (!source) continue;
        const key = JSON.stringify([source, program.majorVersion]);
        if (sources.has(key)) continue;
        sources.set(key, true);
        try {
          const version = deps.pickNewest(
            source,
            (await deps.readVendorBytes(source.url)).toString("utf8"),
          );
          if (program.majorVersion && Number(version.split(".")[0]) !== program.majorVersion)
            throw new Error(`source no longer describes supported ${program.majorVersion}.x`);
          checks.push({
            harness: program.id,
            kind: "newest",
            source: source.url,
            status: "passed",
            version,
          });
        } catch (error) {
          checks.push({
            harness: program.id,
            kind: "newest",
            source: source.url,
            status: "failed",
            detail: String(error),
          });
        }
      }
    }
    const data = program.platforms[deps.platform];
    if (options.sourcesOnly) {
      checks.push({
        harness: program.id,
        kind: "help",
        status: "skipped",
        detail: "sources-only; no installed program inspected",
      });
      continue;
    }
    const selection = await deps.resolveSelectedProgramAsync(program);
    const verbs = new Set();
    for (const [action, command] of Object.entries(data ?? {})) {
      if (!["install", "update", "exactVersion"].includes(action)) continue;
      if (command.kind !== "exec") {
        checks.push({
          harness: program.id,
          kind: "help",
          action,
          status: "skipped",
          detail: "script installer has no CLI verb; never executed by this check",
        });
        continue;
      }
      const binary =
        command.command === "{program}"
          ? selection.path
          : deps.resolveHarnessBinary(command.command);
      // A verb's help never receives installation operands or exact-version input.
      const verb = command.args[0];
      const key = JSON.stringify([binary, command.command, verb]);
      if (verbs.has(key)) continue;
      verbs.add(key);
      if (!binary) {
        checks.push({
          harness: program.id,
          kind: "help",
          action,
          status: "skipped",
          detail: `program absent: ${command.command}`,
        });
        continue;
      }
      try {
        const args = [
          ...(command.command === "{program}" ? (program.childUpdateArgs ?? []) : []),
          ...(verb ? [verb] : []),
          "--help",
        ];
        const result = await deps.runCapture(binary, args, {
          env: program.childUpdateEnv,
          timeoutMs: 30_000,
        });
        if (result.code !== 0 || !(result.stdout + result.stderr).trim())
          throw new Error(`help did not answer (exit ${result.code})`);
        checks.push({ harness: program.id, kind: "help", action, binary, args, status: "passed" });
      } catch (error) {
        checks.push({
          harness: program.id,
          kind: "help",
          action,
          status: "failed",
          detail: String(error),
        });
      }
    }
  }
  return checks;
}
