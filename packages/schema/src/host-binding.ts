import { z } from "zod/v3";

/** Local integration format; independent of the runtime and generator versions. */
export const HOST_BINDING_VERSION = 1;
export const DaemonLifecycleOwner = z.enum(["standalone", "external"]);

/** The embedding host selects the runtime and owns daemon start/stop. No secrets. */
export const ExternalHostBinding = z
  .object({
    schemaVersion: z.literal(HOST_BINDING_VERSION),
    command: z.tuple([z.string().min(1)]).rest(z.string()),
    configDir: z.string().min(1),
    daemonOwner: z.literal("external"),
  })
  .strict();
export type ExternalHostBinding = z.infer<typeof ExternalHostBinding>;
