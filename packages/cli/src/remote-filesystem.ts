import {
  closeSync,
  constants,
  accessSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectStorePort } from "@claudexor/daemon";
import { ControlDirectoryListing } from "@claudexor/schema";

const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_PROJECT_FILE_BYTES = 25 * 1024 * 1024;
// Enough bytes to identify every allowed raster signature (WebP needs 12).
const IMAGE_HEADER_BYTES = 12;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * QA-067: the project-file endpoint exists for exactly one consumer — the
 * remote markdown image gallery. Content type is identified by magic bytes,
 * never by file name: a file whose leading bytes are not a known raster
 * signature is refused before any further content is read. A matching file's
 * REMAINING bytes are then served verbatim — the sniff authenticates the
 * header only, not the whole container, so a raster-prefixed polyglot (PNG
 * magic + arbitrary tail) is served in full. Accepted risk: writing such a
 * file into a registered project already requires owning the remote user.
 * SVG is deliberately excluded: it is a scripting-capable text format, not a
 * raster image.
 */
function sniffRasterImage(header: Buffer): string | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 6) {
    const gif = header.subarray(0, 6).toString("latin1");
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("latin1") === "RIFF" &&
    header.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * QA-067: hidden trees under HOME (`~/.ssh`, `~/.gnupg`, `~/.aws`, harness
 * homes, …) are where credentials and secret-bearing names live, and no
 * legitimate remote project root lives inside one — so the picker neither
 * lists a hidden directory nor lists INTO one.
 */
function hiddenUnderHome(home: string, canonical: string): boolean {
  const rel = relative(home, canonical);
  if (rel === "") return false;
  return rel.split(sep).some((segment) => segment.startsWith("."));
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * QA-067: a refusal must not be an existence oracle. The listing deliberately
 * hides hidden trees and everything outside HOME, so the four refusal causes
 * — absent, outside home, not a directory, hidden — must be indistinguishable
 * by status, code, and message: one typed refusal with constant text that
 * never echoes the requested path. Distinct responses here would confirm
 * guessed secret-bearing names the listing never discloses.
 */
function refuseDirectoryListing(): never {
  throw Object.assign(new Error("directory is not listable"), {
    status: 404,
    code: "directory_not_listable",
  });
}

function canonicalDirectory(path: string, root: string): string {
  // Shape-only validation (no filesystem state involved) may stay specific.
  if (!isAbsolute(path)) {
    throw Object.assign(new Error("directory path must be absolute"), { status: 400 });
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    refuseDirectoryListing();
  }
  if (!contained(root, canonical)) refuseDirectoryListing();
  if (!statSync(canonical).isDirectory()) refuseDirectoryListing();
  if (hiddenUnderHome(root, canonical)) refuseDirectoryListing();
  return canonical;
}

export function listRemoteDirectory(requestedPath: string | undefined, homePath = homedir()) {
  const home = realpathSync(homePath);
  const path = canonicalDirectory(requestedPath || home, home);
  const candidates = [];
  for (const name of readdirSync(path)) {
    // QA-067: project selection needs visible directories only — file names
    // and dot-entries are undisclosed (they can carry secret-bearing names).
    if (name.startsWith(".")) continue;
    const lexical = join(path, name);
    try {
      const target = realpathSync(lexical);
      if (!contained(home, target) || hiddenUnderHome(home, target)) continue;
      const stat = statSync(target);
      if (!stat.isDirectory()) continue;
      let readable = true;
      try {
        accessSync(target, constants.R_OK);
      } catch {
        readable = false;
      }
      candidates.push({
        name,
        path: target,
        kind: "directory" as const,
        readable,
      });
    } catch {
      // Broken and inaccessible symlinks are not actionable picker entries.
    }
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name));
  const entries = candidates.slice(0, MAX_DIRECTORY_ENTRIES);
  const parentPath = path === home ? null : resolve(path, "..");
  return ControlDirectoryListing.parse({
    path,
    home,
    parent: parentPath && contained(home, parentPath) ? parentPath : null,
    entries,
    truncated: candidates.length > MAX_DIRECTORY_ENTRIES,
  });
}

export interface ScopedProjectFile {
  data: Buffer;
  contentType: string;
  fileName: string;
}

/** A run's project identity and optional recorded caller-owned workspace override. */
export interface RunWorkspaceBinding {
  projectRoot: string | null;
  workspaceRoot: string | null;
}

/** The run's recorded project root names this project (canonical lookup; a
 *  root that no longer resolves matches only the registered spelling). */
function identifiesProject(projects: ProjectStorePort, projectId: string, root: string): boolean {
  if (projects.get(projectId)?.root === root) return true;
  try {
    return projects.findByRoot(root)?.id === projectId;
  } catch {
    return false;
  }
}

/**
 * A run-bound read keeps the project id as the stable address but reads the
 * run's own execution tree: every supplied run must belong to this project.
 * An unavailable recorded workspace is a typed refusal, never the project's same-named file.
 */
function boundWorkspaceRoot(
  projects: ProjectStorePort,
  projectId: string,
  binding: RunWorkspaceBinding,
  projectRoot: string,
): string {
  if (!binding.projectRoot || !identifiesProject(projects, projectId, binding.projectRoot)) {
    throw Object.assign(new Error("run does not belong to this project"), {
      status: 409,
      code: "run_project_mismatch",
    });
  }
  if (binding.workspaceRoot === null) return realpathSync(projectRoot);
  try {
    const root = realpathSync(binding.workspaceRoot);
    if (statSync(root).isDirectory()) return root;
  } catch {
    // Missing and unreadable workspaces share one refusal below.
  }
  throw Object.assign(new Error("the run's execution workspace is unavailable"), {
    status: 410,
    code: "execution_workspace_unavailable",
  });
}

export function readScopedProjectFile(
  projects: ProjectStorePort,
  projectId: string,
  requestedPath: string,
  binding?: RunWorkspaceBinding,
): ScopedProjectFile {
  const project = projects.get(projectId);
  if (!project) throw Object.assign(new Error(`no such project: ${projectId}`), { status: 404 });
  if (
    !requestedPath ||
    isAbsolute(requestedPath) ||
    requestedPath.includes("\0") ||
    requestedPath.split(/[\\/]/).includes("..")
  ) {
    throw Object.assign(new Error("project file path must be a contained relative path"), {
      status: 400,
    });
  }
  const root = binding
    ? boundWorkspaceRoot(projects, projectId, binding, project.root)
    : realpathSync(project.root);
  const lexical = resolve(root, requestedPath);
  let canonical: string;
  let expected: ReturnType<typeof statSync>;
  try {
    canonical = realpathSync(lexical);
    expected = statSync(canonical);
  } catch {
    throw Object.assign(new Error("project file does not exist"), { status: 404 });
  }
  if (!contained(root, canonical)) {
    throw Object.assign(new Error("project file path escapes its registered project"), {
      status: 403,
      code: "project_file_path_escape",
    });
  }
  let descriptor: number;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw Object.assign(new Error("project file changed or is not a regular file"), {
      status: 409,
      code: "project_file_changed",
    });
  }
  try {
    const openedPath = openedDescriptorPath(descriptor, canonical);
    if (!contained(root, openedPath)) {
      throw Object.assign(new Error("opened project file escapes its registered project"), {
        status: 403,
        code: "project_file_path_escape",
      });
    }
    const before = fstatSync(descriptor);
    if (before.dev !== expected.dev || before.ino !== expected.ino || !before.isFile()) {
      throw Object.assign(new Error("project file changed before it was opened"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    if (before.size > MAX_PROJECT_FILE_BYTES) {
      throw Object.assign(
        new Error(`project file exceeds the ${MAX_PROJECT_FILE_BYTES} byte fetch limit`),
        { status: 413, code: "project_file_too_large" },
      );
    }
    const buffer = Buffer.allocUnsafe(Math.min(MAX_PROJECT_FILE_BYTES + 1, before.size + 1));
    let bytes = 0;
    // Sniff the magic bytes FIRST: a non-image is refused before its content
    // is read (QA-067 — this endpoint must never page a secret into memory).
    while (bytes < Math.min(IMAGE_HEADER_BYTES, buffer.length)) {
      const count = readSync(
        descriptor,
        buffer,
        bytes,
        Math.min(IMAGE_HEADER_BYTES, buffer.length) - bytes,
        null,
      );
      if (count === 0) break;
      bytes += count;
    }
    const contentType = sniffRasterImage(buffer.subarray(0, bytes));
    if (!contentType) {
      throw Object.assign(new Error("project file fetch serves raster images only"), {
        status: 415,
        code: "project_file_not_raster_image",
      });
    }
    for (;;) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_PROJECT_FILE_BYTES) {
        throw Object.assign(
          new Error(`project file exceeds the ${MAX_PROJECT_FILE_BYTES} byte fetch limit`),
          { status: 413, code: "project_file_too_large" },
        );
      }
    }
    const after = fstatSync(descriptor);
    let finalPath: string;
    let final: ReturnType<typeof statSync>;
    try {
      finalPath = realpathSync(lexical);
      final = statSync(finalPath);
    } catch {
      throw Object.assign(new Error("project file changed while it was being read"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size !== bytes ||
      final.dev !== after.dev ||
      final.ino !== after.ino ||
      finalPath !== canonical
    ) {
      throw Object.assign(new Error("project file changed while it was being read"), {
        status: 409,
        code: "project_file_changed",
      });
    }
    return {
      data: buffer.subarray(0, bytes),
      contentType,
      fileName: openedPath.split(sep).at(-1) ?? "remote-file",
    };
  } finally {
    closeSync(descriptor);
  }
}

export interface RemoteFilesystemServices {
  listDirectory?: (path?: string) => Promise<ControlDirectoryListing>;
  fetchProjectFile?: (
    projectId: string,
    path: string,
    binding?: RunWorkspaceBinding,
  ) => Promise<ScopedProjectFile>;
}

/**
 * QA-067: the filesystem routes exist for the SSH remote runtime (the app
 * browses the remote host through the control tunnel). A local daemon must not
 * grow a generic bearer-reachable filesystem surface, so the services — and
 * with them the routes, which answer 501 without a bound service — are wired
 * only when the process runs as the remote runtime.
 */
export function remoteFilesystemServices(
  projects: () => ProjectStorePort,
  env: NodeJS.ProcessEnv = process.env,
): RemoteFilesystemServices {
  if (env.CLAUDEXOR_REMOTE_RUNTIME !== "1") return {};
  return {
    listDirectory: async (path?: string) => listRemoteDirectory(path),
    fetchProjectFile: async (projectId: string, path: string, binding?: RunWorkspaceBinding) =>
      readScopedProjectFile(projects(), projectId, path, binding),
  };
}

function openedDescriptorPath(descriptor: number, fallback: string): string {
  // Linux exposes the kernel-bound pathname for an open descriptor. Darwin's
  // /dev/fd entries are not symlinks and realpath cannot recover F_GETPATH, so
  // the inode checks before and after the bounded descriptor read remain the
  // portability fence there.
  try {
    return realpathSync(`/proc/self/fd/${descriptor}`);
  } catch {
    return fallback;
  }
}
