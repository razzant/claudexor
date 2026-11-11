import { z } from "zod/v3";

const HttpsUrl = z.string().url().startsWith("https://");
/** Templates substitute {program}, {version}, {home}, {localAppData}, {arch}.
 * They are argv/environment values, never shell source. */
export const HarnessProgramCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exec"),
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("script"),
      url: HttpsUrl,
      interpreter: z.string(),
      interpreterArgs: z.array(z.string()),
      args: z.array(z.string()),
      env: z.record(z.string()).optional(),
    })
    .strict(),
]);
export type HarnessProgramCommand = z.infer<typeof HarnessProgramCommand>;

export const HarnessNewestSource = z
  .object({
    url: HttpsUrl,
    pick: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text") }).strict(),
      z
        .object({ kind: z.literal("json"), field: z.string(), stripPrefix: z.string().optional() })
        .strict(),
      z.object({ kind: z.literal("pattern"), pattern: z.string() }).strict(),
    ]),
  })
  .strict();
export type HarnessNewestSource = z.infer<typeof HarnessNewestSource>;

export const HarnessProgramPlatform = z
  .object({
    /** Folder templates may use {env:NAME}; absent vendor inputs omit that folder. */
    launcherDirs: z.array(z.string()),
    install: HarnessProgramCommand.optional(),
    update: HarnessProgramCommand.optional(),
    exactVersion: HarnessProgramCommand.optional(),
    newest: HarnessNewestSource.optional(),
    /** Vendor-specific architecture spelling in the newest URL. */
    architectures: z.record(z.string()).optional(),
    reasons: z
      .object({
        install: z.string().optional(),
        update: z.string().optional(),
        exactVersion: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HarnessProgramPlatform = z.infer<typeof HarnessProgramPlatform>;

/** Distribution facts live beside the adapter; no engine-owned install kind. */
export const HarnessProgram = z
  .object({
    id: z.string(),
    launchers: z
      .array(z.object({ name: z.string(), realPathPattern: z.string().optional() }).strict())
      .min(1),
    overrideEnv: z.string(),
    platforms: z
      .object({
        darwin: HarnessProgramPlatform.optional(),
        linux: HarnessProgramPlatform.optional(),
        win32: HarnessProgramPlatform.optional(),
      })
      .strict(),
    installationEnv: z.array(z.string()),
    /** Only proves conversion of copies older engines made. Never an install target. */
    legacyNpmPackage: z.string().optional(),
    /** A vendor-supported line boundary, e.g. OpenCode's V1 driver. */
    majorVersion: z.number().int().positive().optional(),
    childUpdateEnv: z.record(z.string()).optional(),
    childUpdateArgs: z.array(z.string()).optional(),
  })
  .strict();
export type HarnessProgram = z.infer<typeof HarnessProgram>;

/** One observation of exactly the invocation the resolver selected. */
export const SelectedHarnessProgram = z
  .object({
    path: z.string().nullable(),
    realPath: z.string().nullable(),
    version: z.string().nullable(),
    versionOutput: z.string().nullable(),
    overrideEnv: z.string().nullable(),
    overrideValue: z.string().nullable(),
  })
  .strict();
export type SelectedHarnessProgram = z.infer<typeof SelectedHarnessProgram>;
