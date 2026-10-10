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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandProjection,
  interactionProjection,
  JournalManager,
  operatorDecisionProjection,
  ProjectPartitions,
  projectProjection,
  runEventProjection,
  threadProjection,
  type CommandStore,
  type InteractionStore,
  type JournalProjectionSlot,
  type OperatorDecisionStore,
  type ProjectStore,
  type RunEventStore,
  type ThreadStore,
} from "@claudexor/daemon";
import { DurableJournal, journalPartitionDirectory } from "@claudexor/journal";
import { afterEach, describe, expect, it } from "vitest";

interface GlobalSlots {
  commands: JournalProjectionSlot<CommandStore>;
  interactions: JournalProjectionSlot<InteractionStore>;
  decisions: JournalProjectionSlot<OperatorDecisionStore>;
  runEvents: JournalProjectionSlot<RunEventStore>;
  projects: JournalProjectionSlot<ProjectStore>;
  threads: JournalProjectionSlot<ThreadStore>;
}

interface PartitionPreparation {
  coverage: "complete" | "global_registry_unavailable";
  readyPartitions: string[];
  recoveryRequiredPartitions: string[];
}

interface ManagerPreparation {
  inspection: { status: "ready" | "recovery_required"; recovery: unknown };
}

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(name: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  cleanup.push(path);
  return path;
}

function registerGlobal(manager: JournalManager): GlobalSlots {
  return {
    commands: manager.registerProjection(commandProjection()),
    interactions: manager.registerProjection(interactionProjection()),
    decisions: manager.registerProjection(operatorDecisionProjection()),
    runEvents: manager.registerProjection(runEventProjection()),
    projects: manager.registerProjection(projectProjection()),
    threads: manager.registerProjection(threadProjection()),
  };
}

function partitions(root: string, slots: GlobalSlots): ProjectPartitions {
  return new ProjectPartitions(
    root,
    slots.projects,
    slots.commands,
    slots.interactions,
    slots.decisions,
    slots.runEvents,
    slots.threads,
  );
}

function prepareManager(manager: JournalManager): ManagerPreparation {
  return (manager as unknown as { prepare(): ManagerPreparation }).prepare();
}

function preparePartitions(value: ProjectPartitions): PartitionPreparation {
  return (value as unknown as { prepare(): PartitionPreparation }).prepare();
}

function seedCopiedRoot(): {
  root: string;
  projectIds: string[];
} {
  const source = tempRoot("startup-source");
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
        clientId: "startup-test",
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

  const copy = tempRoot("startup-copy");
  copyRootPreservingModes(source, copy);
  return { root: copy, projectIds };
}

function copyRootPreservingModes(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, force: true });
  const restore = (sourcePath: string, destinationPath: string): void => {
    const stat = lstatSync(sourcePath);
    chmodSync(destinationPath, stat.mode & 0o777);
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(sourcePath)) {
      restore(join(sourcePath, name), join(destinationPath, name));
    }
  };
  restore(source, destination);
}

function corruptFirstByte(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes, { mode: 0o600 });
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

describe("daemon startup recovery preparation", () => {
  it("leaves crash-GC and maintenance inputs untouched when one registered project is corrupt", () => {
    const { root, projectIds } = seedCopiedRoot();
    const corruptPath = join(
      journalPartitionDirectory(join(root, "journal"), `project:${projectIds[0]}`),
      "journal.bin",
    );
    corruptFirstByte(corruptPath);
    const pids = join(root, "pids.json");
    const config = join(root, "config.json");
    const workspace = join(root, "workspace-owner.json");
    writeFileSync(pids, '{"children":[{"pid":4242}]}\n', { mode: 0o600 });
    writeFileSync(config, '{"retired_key":"must-survive"}\n', { mode: 0o600 });
    writeFileSync(workspace, '{"owner":"must-survive"}\n', { mode: 0o600 });
    const guarded = [pids, config, workspace, corruptPath];
    const before = receipt(guarded);

    const global = new JournalManager(root);
    const slots = registerGlobal(global);
    const globalPreparation = prepareManager(global);
    expect(globalPreparation.inspection.status, JSON.stringify(globalPreparation.inspection)).toBe(
      "ready",
    );
    const projectPartitions = partitions(root, slots);
    const result = preparePartitions(projectPartitions);

    expect(result.coverage).toBe("complete");
    expect(result.recoveryRequiredPartitions).toEqual([`project:${projectIds[0]}`]);
    expect(result.readyPartitions).toEqual([`project:${projectIds[1]}`]);
    expect(receipt(guarded)).toBe(before);
    projectPartitions.close();
    global.close();
  });

  it("does not discover or touch project partitions when the copied global registry is corrupt", () => {
    const { root, projectIds } = seedCopiedRoot();
    const globalPath = join(
      journalPartitionDirectory(join(root, "journal"), "global"),
      "journal.bin",
    );
    corruptFirstByte(globalPath);
    const projectPaths = projectIds.map((id) =>
      join(journalPartitionDirectory(join(root, "journal"), `project:${id}`), "journal.bin"),
    );
    const before = receipt([globalPath, ...projectPaths]);

    const global = new JournalManager(root);
    const slots = registerGlobal(global);
    expect(prepareManager(global).inspection).toMatchObject({ status: "recovery_required" });
    const projectPartitions = partitions(root, slots);
    const result = preparePartitions(projectPartitions);

    expect(result).toMatchObject({
      coverage: "global_registry_unavailable",
      readyPartitions: [],
      recoveryRequiredPartitions: [],
    });
    expect(receipt([globalPath, ...projectPaths])).toBe(before);
    projectPartitions.close();
    global.close();
  });
});
