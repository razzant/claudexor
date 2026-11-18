# Claudexor for Hermes

Ask a second model a question from your Hermes session. The
`claudexor:claudexor` skill uses the local `claudexor mcp serve` connection.
[Set up the CLI and connect an account](https://github.com/razzant/claudexor#set-up-the-cli-and-account)
on the machine running Hermes. Both `node` and `claudexor` must be on the
Hermes process's PATH. If your CLI uses a custom `CLAUDEXOR_CONFIG_DIR`,
set its absolute path for the MCP server in the selected Hermes profile and
[verify the store before delegating](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#custom-claudexor-configuration-directory).

Open the [plugin manifest on GitHub](https://github.com/razzant/claudexor/blob/main/plugins/hermes/plugin.json)
at the revision you want. Press **y** to pin the page, inspect the plugin at
that commit, and copy its full 40-character SHA from the URL. In a terminal
using your intended Hermes profile, run this and paste the SHA when prompted:

```sh
printf 'Inspected commit SHA: ' && IFS= read -r claudexor_sha &&
  hermes plugins install razzant/claudexor/plugins/hermes --ref "${claudexor_sha:?Full SHA required}" --enable
```

The first install needs network access for Hermes' runtime. Confirm the pin
and enabled state with `hermes plugins list`, then start a new session in
that profile. If you restrict toolsets, allow the Claudexor MCP tools on the
intended platform in `hermes tools`. [Check status and get your first answer](https://github.com/razzant/claudexor#first-delegation-from-any-host).

## Access

Hermes starts the preinstalled `claudexor mcp serve` process over stdio. The
CLI can start its local daemon and the selected coding harness. Claudexor keeps
run records on the machine; the delegated prompt and selected files can reach
the model provider you configured and may incur charges. This plugin contains
no credentials and does not sign you in. For file work, name the project and
files. Request an isolated candidate if you want to review changes before
applying them with the Claudexor CLI.

Integration by [Ouroboros](https://github.com/razzant/ouroboros).
