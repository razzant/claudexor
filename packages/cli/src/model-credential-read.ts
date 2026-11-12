import { measureModelPreparation } from "@claudexor/util";
import type { CredentialGeneration } from "@claudexor/daemon";
import type { CredentialProfile } from "@claudexor/schema";
import { modelError } from "./model-service-refusals.js";

/** Each consumer keeps its own generation fence, including its cancellation
 * subscription, and learns the generation it read under. Raw adapter I/O may
 * be shared; these decisions never are. A login window reads as unknown (NaN);
 * only two known, different generations prove that the account changed. A read
 * this fence ended (not its caller, and not the read's own answer) runs once more
 * under the new generation; nothing from it is returned; a second change surfaces. */
export async function modelCredentialRead<T>(
  credentials: CredentialGeneration,
  harnessId: string,
  profile: CredentialProfile,
  caller: AbortSignal,
  read: (signal: AbortSignal, generation: number) => Promise<T>,
  retry = true,
): Promise<{ value: T; generation: number }> {
  const generation = credentials.generation(harnessId, profile.profile_id);
  const changed = new AbortController();
  const refuse = () =>
    changed.abort(
      modelError(
        "auth_changed",
        "The selected account changed during catalog discovery; try a new operation.",
      ),
    );
  const unsubscribe = credentials.onChange((subject) => {
    if (!subject || (subject.harnessId === harnessId && subject.profileId === profile.profile_id))
      refuse();
  });
  const signal = AbortSignal.any([caller, changed.signal]);
  try {
    signal.throwIfAborted();
    const value = await measureModelPreparation("catalogRead", () => read(signal, generation));
    const after = credentials.generation(harnessId, profile.profile_id);
    if (Number.isFinite(generation) && Number.isFinite(after) && generation !== after) refuse();
    signal.throwIfAborted();
    return { value, generation };
  } catch (error) {
    if (!retry || caller.aborted || error !== changed.signal.reason) throw error;
  } finally {
    unsubscribe();
  }
  return modelCredentialRead(credentials, harnessId, profile, caller, read, false);
}
