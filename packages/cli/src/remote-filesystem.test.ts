import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRemoteDirectory,
  readScopedProjectFile,
  remoteFilesystemServices,
} from "./remote-filesystem.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remote-fs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("payload-bytes"),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jfif-payload")]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from("gif-payload")]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.from("vp8-payload"),
]);

function projectStore(project: string) {
  return {
    get: (id: string) =>
      id === "prj-1"
        ? { id, root: project, schema_version: 3, created_at: "", updated_at: "" }
        : undefined,
  } as never;
}

describe("remote filesystem containment", () => {
  it("lists only visible home-contained directories — files and dot-names stay undisclosed", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "hello");
    symlinkSync("/tmp", join(root, "escape"));
    writeFileSync(join(root, "z-file.txt"), "file");
    writeFileSync(join(root, "id_ed25519"), "PRIVATE KEY");
    mkdirSync(join(root, "a-directory"));
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".env"), "SECRET=1");
    const listing = listRemoteDirectory(root, root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a-directory", "project"]);
    expect(listing.entries.every((entry) => entry.kind === "directory")).toBe(true);
    expect(listing.parent).toBeNull();
    expect(listing.truncated).toBe(false);
  });

  it("skips a visible symlink whose target hides inside a dot-tree", () => {
    mkdirSync(join(root, ".secrets"));
    mkdirSync(join(root, ".secrets", "vault"));
    symlinkSync(join(root, ".secrets", "vault"), join(root, "innocent"));
    mkdirSync(join(root, "visible"));
    const listing = listRemoteDirectory(root, root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["visible"]);
  });

  it("refuses to list INTO a hidden directory", () => {
    mkdirSync(join(root, ".ssh"));
    expect(() => listRemoteDirectory(join(root, ".ssh"), root)).toThrow(
      "directory is not listable",
    );
  });

  it("collapses absent/outside/file/hidden refusals into one constant answer (no oracle)", () => {
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, "server.key"), "PRIVATE");
    const probes = [
      join(root, "no-such-dir"), // absent inside home
      "/tmp", // outside home, exists
      "/no-such-root-anywhere-xyz", // outside home, absent
      join(root, "server.key"), // exists but is a file
      join(root, ".ssh"), // hidden, exists
      join(root, ".gnupg"), // hidden, absent
    ];
    for (const probe of probes) {
      let refusal: unknown;
      try {
        listRemoteDirectory(probe, root);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, probe).toBeInstanceOf(Error);
      expect((refusal as { status?: number }).status, probe).toBe(404);
      expect((refusal as { code?: string }).code, probe).toBe("directory_not_listable");
      // Constant message: identical for every cause and never echoes the path.
      expect((refusal as Error).message, probe).toBe("directory is not listable");
    }
  });

  it("discloses a bounded listing instead of silently hiding overflow", () => {
    for (let index = 0; index < 1_001; index += 1) {
      mkdirSync(join(root, `dir-${String(index).padStart(4, "0")}`));
    }
    const listing = listRemoteDirectory(root, root);
    expect(listing.entries).toHaveLength(1_000);
    expect(listing.truncated).toBe(true);
  });

  it("refuses directory traversal outside home", () => {
    expect(() => listRemoteDirectory("/tmp", root)).toThrow("directory is not listable");
  });

  it("serves each allowed raster image type, content-typed by magic bytes", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "shot.png"), PNG);
    writeFileSync(join(project, "photo.jpg"), JPEG);
    writeFileSync(join(project, "anim.gif"), GIF);
    writeFileSync(join(project, "modern.webp"), WEBP);
    const store = projectStore(project);
    expect(readScopedProjectFile(store, "prj-1", "shot.png").contentType).toBe("image/png");
    expect(readScopedProjectFile(store, "prj-1", "photo.jpg").contentType).toBe("image/jpeg");
    expect(readScopedProjectFile(store, "prj-1", "anim.gif").contentType).toBe("image/gif");
    expect(readScopedProjectFile(store, "prj-1", "modern.webp").contentType).toBe("image/webp");
    expect(readScopedProjectFile(store, "prj-1", "shot.png").data.equals(PNG)).toBe(true);
    expect(() => readScopedProjectFile(store, "prj-1", "../outside")).toThrow(/contained relative/);
  });

  it("refuses every non-image with a typed no-content refusal (QA-067)", () => {
    const project = join(root, "project");
    mkdirSync(project);
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".env"), "OPENROUTER_API_KEY=sk-secret");
    writeFileSync(join(project, ".git", "config"), "[remote]\n  url = git@host:repo\n");
    // Assembled rather than written literally: the repository secret scan cannot
    // tell a fixture apart from a leak, and this fixture only has to be a
    // non-image the endpoint refuses.
    const opensshKeyHeader = `-----BEGIN OPENSSH PRIVATE ${"KEY"}-----`;
    writeFileSync(join(project, "id_ed25519"), `${opensshKeyHeader}\nabc`);
    writeFileSync(join(project, "notes.txt"), "the deploy token is tok_123");
    const store = projectStore(project);
    for (const path of [".env", ".git/config", "id_ed25519", "notes.txt"]) {
      let refusal: unknown;
      try {
        readScopedProjectFile(store, "prj-1", path);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, path).toBeInstanceOf(Error);
      expect((refusal as { code?: string }).code, path).toBe("project_file_not_raster_image");
      expect((refusal as { status?: number }).status, path).toBe(415);
      expect((refusal as { message: string }).message, path).not.toMatch(/sk-secret|tok_123/);
      expect(refusal, path).not.toHaveProperty("data");
    }
  });

  it("refuses a renamed binary posing as .png — magic bytes decide, not the name", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, "totally-a-picture.png"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
    );
    expect(() =>
      readScopedProjectFile(projectStore(project), "prj-1", "totally-a-picture.png"),
    ).toThrow(/raster images only/);
  });

  it("refuses an out-of-project symlink and an oversized regular file", () => {
    const project = join(root, "project");
    mkdirSync(project);
    const outside = join(root, "outside.png");
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(project, "escape.png"));
    const large = join(project, "large.png");
    writeFileSync(large, PNG);
    truncateSync(large, 25 * 1024 * 1024 + 1);
    const store = projectStore(project);
    expect(() => readScopedProjectFile(store, "prj-1", "escape.png")).toThrow(/escapes/);
    expect(() => readScopedProjectFile(store, "prj-1", "large.png")).toThrow(/fetch limit/);
  });
});

describe("remote filesystem service registration (QA-067)", () => {
  it("wires nothing into a local daemon and both services under the remote runtime", () => {
    const projects = () => projectStore(join(root, "nowhere"));
    expect(remoteFilesystemServices(projects, {})).toEqual({});
    expect(remoteFilesystemServices(projects, { CLAUDEXOR_REMOTE_RUNTIME: "0" })).toEqual({});
    const services = remoteFilesystemServices(projects, { CLAUDEXOR_REMOTE_RUNTIME: "1" });
    expect(typeof services.listDirectory).toBe("function");
    expect(typeof services.fetchProjectFile).toBe("function");
  });

  it("serves a real project image end-to-end through the remote-runtime service", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "shot.png"), PNG);
    const services = remoteFilesystemServices(() => projectStore(project), {
      CLAUDEXOR_REMOTE_RUNTIME: "1",
    });
    const file = await services.fetchProjectFile?.("prj-1", "shot.png");
    expect(file?.contentType).toBe("image/png");
    expect(file?.data.equals(PNG)).toBe(true);
  });
});
