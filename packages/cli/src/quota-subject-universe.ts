import { loadConfig } from "@claudexor/config";
import {
  accountResourceSourceHarnesses,
  harnessHasDefaultCredentialStore,
  quotaRefreshDemandHarnesses,
  type QuotaSubject,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { readAccountsMigrationFile } from "./accounts-unified-migration.js";

/** The refresh-demand universe for every enabled primary-capable harness:
 * its enabled native credential plus every enabled config-directory profile.
 * Source traits own the harness list, so adding a primary quota source cannot
 * silently miss this subject projection. API-key resource sources refresh only
 * on request, so their harnesses add no subject and no `no_source` absence. */
export function quotaSubjectUniverseFromConfig(): QuotaSubject[] {
  const global = loadConfig(noProjectRepoRoot()).global;
  const profiles = global.credential_profiles;
  const subjects: QuotaSubject[] = [];
  const migrated = readAccountsMigrationFile();
  for (const harness of new Set([
    ...quotaRefreshDemandHarnesses(),
    ...accountResourceSourceHarnesses("account"),
  ])) {
    const settings = global.harnesses[harness];
    if (settings?.enabled === false) continue;
    // agy has no unprofiled default subject (PLAN Л-4): its universe is
    // profiles-only, so a null-subject default is never expected of it.
    // A MIGRATED harness has no null subject either (unified account model):
    // its former default store IS the auto-registered row, which the profile
    // loop below already covers — emitting both would double-probe one store.
    if (
      harnessHasDefaultCredentialStore(harness) &&
      migrated[harness] === undefined &&
      settings?.native_credentials_enabled !== false
    ) {
      subjects.push({
        harness,
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: null,
      });
    }
    for (const profile of profiles) {
      if (profile.harness_id !== harness || !profile.enabled) continue;
      if (profile.credential_kind !== "config_dir_login") continue;
      subjects.push({
        harness,
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: profile.profile_id,
      });
    }
  }
  return subjects;
}
