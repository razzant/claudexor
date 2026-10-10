import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandProjection,
  DaemonServer,
  memoryFacts,
  interactionProjection,
  JournalManager,
  operatorDecisionProjection,
  ProjectPartitions,
  projectProjection,
  runEventProjection,
  threadProjection,
  type JournalManagerPreparation,
  type ProjectPartitionsPreparation,
} from "@claudexor/daemon";
import {
  DurableJournal,
  JournalRecoveryRequiredError,
  journalPartitionDirectory,
} from "@claudexor/journal";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeStartupAdmission,
  DaemonStartupAdmission,
  proveRecoveryTransport,
  recoveryBlockedPartitions,
} from "./daemon-startup.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function tempRoot(name: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function preparation(status: "ready" | "recovery_required"): JournalManagerPreparation {
  return { inspection: { status } } as unknown as JournalManagerPreparation;
}

function partitionsPreparation(
  input: Partial<Pick<ProjectPartitionsPreparation, "coverage" | "recoveryRequiredPartitions">>,
): ProjectPartitionsPreparation {
  return {
    coverage: input.coverage ?? "complete",
    recoveryRequiredPartitions: input.recoveryRequiredPartitions ?? [],
  } as unknown as ProjectPartitionsPreparation;
}

function orderedFixture(options: { failActivation?: boolean; failRevalidation?: boolean } = {}) {
  const order: string[] = [];
  const admission = new DaemonStartupAdmission();
  const recoveryRequired = () =>
    new JournalRecoveryRequiredError({
      status: "recovery_required",
      discardedTailBytes: 0,
      reason: "journal changed during validation",
      offset: 0,
    } as never);
  return {
    order,
    admission,
    input: {
      grant: {
        advanceFloor: () => {
          order.push("advanceFloor");
          return { schemaVersion: 2 as const, epoch: 2, state: "served" as const };
        },
      },
      global: {
        revalidatePreparation: () => {
          order.push("global.revalidatePreparation");
          if (options.failRevalidation) throw recoveryRequired();
        },
        activatePrepared: () => {
          order.push("global.activatePrepared");
          if (options.failActivation) throw recoveryRequired();
        },
        recoverAfterStartup: () => order.push("global.recoverAfterStartup"),
      },
      partitions: {
        revalidatePreparation: () => order.push("partitions.revalidatePreparation"),
        activatePrepared: () => order.push("partitions.activatePrepared"),
        recoverAfterStartup: () => order.push("partitions.recoverAfterStartup"),
      },
      crashGc: async () => {
        order.push("crashGc");
      },
      admission,
      log: () => {},
    },
  };
}

describe("two-stage startup admission ordering (issue #165 D5)", () => {
  it("starts recovery-only and opens normal admission through the coordinator only", () => {
    const admission = new DaemonStartupAdmission();
    expect(admission.snapshot()).toBe("recovery_only");
    admission.openNormal();
    expect(admission.snapshot()).toBe("normal");
  });

  it("revalidates every preparation FIRST; floor advance and destructive recovery follow only on all-green (C3)", async () => {
    const { order, admission, input } = orderedFixture();
    const mode = await completeStartupAdmission({ ...input, blockedPartitions: [] });
    expect(mode).toBe("normal");
    expect(admission.snapshot()).toBe("normal");
    expect(memoryFacts().atAdmission).toMatchObject({
      heapUsedBytes: expect.any(Number),
      rssBytes: expect.any(Number),
      at: expect.any(String),
    });
    expect(order).toEqual([
      "global.revalidatePreparation",
      "partitions.revalidatePreparation",
      "advanceFloor",
      "crashGc",
      "global.activatePrepared",
      "partitions.activatePrepared",
      "global.recoverAfterStartup",
      "partitions.recoverAfterStartup",
    ]);
  });

  it("a revalidation failure keeps the floor UNCHANGED with zero destructive work (C3)", async () => {
    const { order, admission, input } = orderedFixture({ failRevalidation: true });
    const mode = await completeStartupAdmission({ ...input, blockedPartitions: [] });
    expect(mode).toBe("recovery_only");
    expect(admission.snapshot()).toBe("recovery_only");
    expect(order).toEqual(["global.revalidatePreparation"]);
  });

  it("keeps the floor unchanged and destructive work OFF for a recovery-needed partition", async () => {
    const { order, admission, input } = orderedFixture();
    const mode = await completeStartupAdmission({
      ...input,
      blockedPartitions: ["project:abc"],
    });
    expect(mode).toBe("recovery_only");
    expect(admission.snapshot()).toBe("recovery_only");
    expect(order).toEqual([]);
  });

  it("stays on the recovery plane when prepared activation itself enters recovery", async () => {
    const { order, admission, input } = orderedFixture({ failActivation: true });
    const mode = await completeStartupAdmission({ ...input, blockedPartitions: [] });
    expect(mode).toBe("recovery_only");
    expect(admission.snapshot()).toBe("recovery_only");
    expect(order).toEqual([
      "global.revalidatePreparation",
      "partitions.revalidatePreparation",
      "advanceFloor",
      "crashGc",
      "global.activatePrepared",
    ]);
    expect(order).not.toContain("global.recoverAfterStartup");
  });

  it("collects every blocking partition from the stage-2 receipts", () => {
    expect(
      recoveryBlockedPartitions({
        globalPreparation: preparation("ready"),
        partitionsPreparation: partitionsPreparation({}),
      }),
    ).toEqual([]);
    expect(
      recoveryBlockedPartitions({
        globalPreparation: preparation("recovery_required"),
        partitionsPreparation: partitionsPreparation({ coverage: "global_registry_unavailable" }),
      }),
    ).toEqual(["global", "project-registry"]);
    expect(
      recoveryBlockedPartitions({
        globalPreparation: preparation("ready"),
        partitionsPreparation: partitionsPreparation({
          recoveryRequiredPartitions: ["project:p1"],
        }),
      }),
    ).toEqual(["project:p1"]);
  });
});

describe("recovery transport proof (issue #165 D5 stage 3)", () => {
  /** A REAL daemon socket serving `mode`; the proof must dial it itself. */
  async function servingSocket(mode: "normal" | "recovery_only"): Promise<string> {
    const socketPath = join(tempRoot("tp"), "d.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      servingMode: () => mode,
      commands: { all: () => [] },
      runner: async () => ({}),
    });
    await server.start();
    stopServers.push(() => server.stop());
    return socketPath;
  }
  const stopServers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stopServers.splice(0)) await stop();
  });

  it("accepts a recovery-only socket health report without a control plane", async () => {
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("recovery_only"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a socket that does not prove the recovery-only serving daemon", async () => {
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("normal"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).rejects.toThrow(/transport proof failed/);
  });

  it("dials the socket itself: a missing or wrong-token socket fails the proof", async () => {
    // Nothing else can stand in for the socket: an absent endpoint is a
    // transport failure, and a live one still demands the daemon token.
    await expect(
      proveRecoveryTransport({
        socketPath: join(tempRoot("tp-absent"), "d.sock"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("recovery_only"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "not-the-token",
        control: null,
      }),
    ).rejects.toThrow(/unauthorized/);
  });

  it("proves exact identity through the REAL control handshake and refuses a mismatch", async () => {
    const identity = { version: "3.4.0", sha: "b".repeat(40) };
    const serve = (engine: { version: string; sha: string }): Promise<Server> =>
      new Promise((resolve) => {
        const server = createServer((req, res) => {
          if (req.method === "POST" && req.url === "/v2/handshake") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                protocolMajor: CONTROL_PROTOCOL_MAJOR,
                compatible: true,
                operationsPath: "/v2/operations",
                engine: { ...engine, entry: "/opt/claudexor/daemon.js" },
                servingMode: "recovery_only",
              }),
            );
            return;
          }
          res.writeHead(404).end();
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
        cleanup.push(() => server.close());
      });

    const socketPath = await servingSocket("recovery_only");
    const matching = await serve(identity);
    const matchingPort = (matching.address() as { port: number }).port;
    await expect(
      proveRecoveryTransport({
        socketPath,
        identity,
        token: "token",
        control: { host: "127.0.0.1", port: matchingPort },
      }),
    ).resolves.toBeUndefined();

    const foreign = await serve({ version: "3.3.7", sha: "c".repeat(40) });
    const foreignPort = (foreign.address() as { port: number }).port;
    await expect(
      proveRecoveryTransport({
        socketPath,
        identity,
        token: "token",
        control: { host: "127.0.0.1", port: foreignPort },
      }),
    ).rejects.toThrow(/exact recovery-only runtime/);
  });
});

// Copied-journal integration (reuses I-B's daemon-startup-recovery patterns):
// one registered project partition is corrupt in a copied root. Stage 2 must
// flag it read-only, and the stage-4 coordinator must leave the floor, crash
// GC and every byte of the root untouched while the recovery plane stays on.
describe("copied-journal startup admission integration", () => {
  function seedCopiedRoot(): { root: string; projectIds: string[] } {
    const source = tempRoot("id-startup-source");
    const projectRoots = [join(source, "repo-a"), join(source, "repo-b")];
    for (const projectRoot of projectRoots) mkdirSync(projectRoot);
    const global = new JournalManager(source);
    const slots = registerGlobal(global);
    global.start();
    const projectIds = projectRoots.map(
      (projectRoot, index) =>
        slots.projects.current().register({
          root: projectRoot,
          idempotencyKey: `register-${index}`,
          clientId: "id-startup-test",
        }).project.id,
    );
    for (const projectId of projectIds) {
      const projectJournal = new DurableJournal({
        rootDir: join(source, "journal"),
        partition: `project:${projectId}`,
      });
      projectJournal.append("integration.seed", { projectId });
      projectJournal.close();
    }
    global.close();
    const copy = tempRoot("id-startup-copy");
    cpSync(source, copy, { recursive: true, force: true });
    const restore = (sourcePath: string, destinationPath: string): void => {
      const stat = lstatSync(sourcePath);
      chmodSync(destinationPath, stat.mode & 0o777);
      if (!stat.isDirectory()) return;
      for (const name of readdirSync(sourcePath)) {
        restore(join(sourcePath, name), join(destinationPath, name));
      }
    };
    restore(source, copy);
    return { root: copy, projectIds };
  }

  function registerGlobal(manager: JournalManager) {
    return {
      commands: manager.registerProjection(commandProjection()),
      interactions: manager.registerProjection(interactionProjection()),
      decisions: manager.registerProjection(operatorDecisionProjection()),
      runEvents: manager.registerProjection(runEventProjection()),
      projects: manager.registerProjection(projectProjection()),
      threads: manager.registerProjection(threadProjection()),
    };
  }

  function receipt(paths: string[]): string {
    const hash = createHash("sha256");
    for (const path of paths) {
      const stat = statSync(path);
      hash.update(`${path}\0${stat.mode & 0o777}\0${stat.size}\0`);
      hash.update(readFileSync(path));
    }
    return hash.digest("hex");
  }

  it("keeps the recovery plane on with floor unchanged and zero writes for a corrupt copied partition", async () => {
    const { root, projectIds } = seedCopiedRoot();
    const corruptPath = join(
      journalPartitionDirectory(join(root, "journal"), `project:${projectIds[0]}`),
      "journal.bin",
    );
    const bytes = readFileSync(corruptPath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(corruptPath, bytes, { mode: 0o600 });
    const guarded = [corruptPath];
    const before = receipt(guarded);

    const global = new JournalManager(root);
    const slots = registerGlobal(global);
    const globalPreparation = global.prepare();
    const partitions = new ProjectPartitions(
      root,
      slots.projects,
      slots.commands,
      slots.interactions,
      slots.decisions,
      slots.runEvents,
      slots.threads,
    );
    const receiptBefore = partitions.prepare();
    cleanup.push(() => {
      partitions.close();
      global.close();
    });

    const blocked = recoveryBlockedPartitions({
      globalPreparation,
      partitionsPreparation: receiptBefore,
    });
    expect(blocked).toEqual([`project:${projectIds[0]}`]);

    const admission = new DaemonStartupAdmission();
    let floorAdvanced = 0;
    let crashGcRan = 0;
    const mode = await completeStartupAdmission({
      grant: {
        advanceFloor: () => {
          floorAdvanced += 1;
          return { schemaVersion: 2 as const, epoch: 2, state: "served" as const };
        },
      },
      blockedPartitions: blocked,
      global,
      partitions,
      crashGc: async () => {
        crashGcRan += 1;
      },
      admission,
      log: () => {},
    });

    expect(mode).toBe("recovery_only");
    expect(admission.snapshot()).toBe("recovery_only");
    expect(floorAdvanced).toBe(0);
    expect(crashGcRan).toBe(0);
    expect(receipt(guarded)).toBe(before);
  });

  it("activates, terminalizes and opens normal admission for a healthy copied root", async () => {
    const { root, projectIds } = seedCopiedRoot();
    const global = new JournalManager(root);
    const slots = registerGlobal(global);
    const globalPreparation = global.prepare();
    const partitions = new ProjectPartitions(
      root,
      slots.projects,
      slots.commands,
      slots.interactions,
      slots.decisions,
      slots.runEvents,
      slots.threads,
    );
    const receiptBefore = partitions.prepare();
    cleanup.push(() => {
      partitions.close();
      global.close();
    });

    const blocked = recoveryBlockedPartitions({
      globalPreparation,
      partitionsPreparation: receiptBefore,
    });
    expect(blocked).toEqual([]);

    const admission = new DaemonStartupAdmission();
    let floorAdvanced = 0;
    const mode = await completeStartupAdmission({
      grant: {
        advanceFloor: () => {
          floorAdvanced += 1;
          return { schemaVersion: 2 as const, epoch: 2, state: "served" as const };
        },
      },
      blockedPartitions: blocked,
      global,
      partitions,
      crashGc: async () => {},
      admission,
      log: () => {},
    });

    expect(mode).toBe("normal");
    expect(admission.snapshot()).toBe("normal");
    expect(floorAdvanced).toBe(1);
    expect(global.ready()).toBe(true);
    // The registered project stores are live product authorities again.
    expect(
      slots.projects
        .current()
        .list()
        .map((project) => project.id),
    ).toEqual(expect.arrayContaining(projectIds));
  });
});
