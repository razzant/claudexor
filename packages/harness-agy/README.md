# @claudexor/harness-agy

Adapter for Google's Antigravity CLI (`agy`): translates
`agy -p --output-format stream-json` into typed `HarnessEvent`s.

Accounts use NAMED credential-profile bindings only (there is no engine-default
agy credential). Every binding has a Claudexor-owned HOME that scopes vendor
state under `$HOME/.gemini/...`; credential custody is platform-defined.
On Darwin, Claudexor lazily prepares the profile's own
`Library/Keychains/login.keychain-db` before an agy child starts. When setup
succeeds this prevents the missing-keychain prompt; an unsafe profile path
refuses that child before it can trigger SecurityAgent, while an operational
setup miss leaves the vendor's own file fallback available. The implementation
bootstraps the DB under a neutral filename and adopts the canonical name,
because Apple's `security` tool treats a path containing `login.keychain` as a
user search-list entry. This keeps host default/list preferences untouched.
The vendor still owns the item; no host Keychain is bridged and no credential
bytes are copied. Linux keeps the config-file/HOME route.
Windows uses the current OS user's Credential Manager identity, permits one
enabled binding, and treats HOME as state scoping rather than an independent
Google identity.
Readiness always comes from the bounded vendor `/model` probe, never from the
presence or absence of `antigravity-oauth-token`. See `src/profile.ts` for the
route and verification contract.

A readonly run adds session-only settings that deny every command and file
write while keeping the profile's own rules, so a denied call returns to the
model as a tool error instead of ending the turn (`src/session-policy.ts`);
this needs agy 1.4.10 or newer, and an older CLI stops a readonly run before
the model with an update remedy. Settings it cannot read refuse the run before
it starts. Every run takes its decisions, and the grant it saves, from one
snapshot of the profile settings, and saves the grant only while the file
still holds that snapshot; a run that finds it changed writes nothing and
stops before sending, so start it again. An `allow`, `deny` or `ask` list that
is not a list of rules is never rewritten and gets no terminal request. A
workspace_write run adds no blanket permission for commands, writes or network access:
on agy 1.5.8 or newer its session-only settings request the vendor's terminal
sandbox (`enableTerminalSandbox` with `proceed-in-sandbox`), naming no
permission list, unless the profile saved a different value for either of
those two settings (each may be unset or already hold the requested value). The request is
disclosed as requested only once its file is in place at launch; the
effective mode is agy's. When only saving the read grant fails, the session
file of a run on agy 1.5.7 or newer carries the profile's lists as read with
the grant, and input delivered as files is refused rather than sent if that
file cannot be written. The sandbox can read whatever the profile's read rules
allow, including the `read_file(*)` grant every agy run keeps
(`src/read-grant.ts`), so it is no isolation for untrusted code. On an agy
older than 1.5.7, or of unknown version, a profile set to strict or with
unreadable settings is refused before its settings are written or anything is
sent (on macOS the profile keychain may already be prepared), because
accept-edits may loosen strict there; from 1.5.7 a strict profile is admitted,
but its edits still ask. On an agy older than 1.5.8, or of unknown version, a
profile that saved `command(*)` or `toolPermission: "always-proceed"`, or
whose settings cannot be checked, is refused the same way, because headless
runs there could ignore Gemini Enterprise admin controls; updating agy lifts
both refusals, and saved rules are never changed. Other runs on such a version
keep ordinary edits without the request, and the run starts only on the
program observation it decided on (`src/workspace-write-cli.ts`,
`src/run-input.ts`). Input over a conservative 128 KiB limit (agy cut larger
piped input at 192,000 bytes) is saved unchanged in the run's `context/`
directory and named by a bootstrap that does not grow with it
(`src/input-file.ts`); it is refused, with the reason, when no read grant
reaches the run or the profile's own `strict` or a `read_file(*)` ask or deny
rule holds every read. Only those known declarations are checked, so delivery
is no guarantee that agy reads every file. Shorter input runs as before.

Fixtures under `fixtures/` pin the recorded 1.1.13 stream shapes, plus one
1.5.0 readonly denial recording; see `fixtures/manifest.yaml` for provenance
and stream-semantics expectations.

Model enumeration uses the named profile's `agy models` table through the same
bounded, pipe-EOF runner as doctor and quota, with self-update disabled. Failed
or malformed reads remain unknown. An unscoped query returns marked historical
hints without probing a host account. Catalog absence is advisory: an explicit
unlisted id reaches the vendor unchanged with the engine's unverified-model
disclosure. Known Gemini and Claude/GPT families retain their declared quota
scope for new ids; an unrelated model family has unknown applicability.
`fixtures/models.tsv` records the October 2026 table with the version ambiguity
disclosed in `fixtures/manifest.yaml`.
