import { redactSecrets } from "@claudexor/util";
import { z } from "zod/v3";

// The ordinary authenticated Stop RPC accepts these optional diagnostic fields.
// An older client or an unreadable field must still be able to stop the daemon.
const pid = z.number().int().positive().max(0x7fffffff).optional().catch(undefined);
const name = z
  .string()
  .refine(
    (label) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label) && redactSecrets(label) === label,
  )
  .optional()
  .catch(undefined);
const version = z
  .string()
  .regex(/^\d{1,10}\.\d{1,10}\.\d{1,10}$/)
  .optional()
  .catch(undefined);
export const DaemonStopSender = z.object({
  name,
  version,
  pid,
  ppid: pid,
});
export type DaemonStopSender = z.infer<typeof DaemonStopSender>;

export function describeStopSender(sender: DaemonStopSender): string {
  const fields = [
    sender.name,
    sender.version && `version=${sender.version}`,
    sender.pid && `pid=${sender.pid}`,
    sender.ppid && `ppid=${sender.ppid}`,
  ].filter(Boolean);
  return fields.length ? `client-reported: ${fields.join(" ")}` : "sender unknown";
}
