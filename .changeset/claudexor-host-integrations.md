---
"claudexor": minor
---

Connect Hermes Agent, Pi, and OpenClaw to the local Claudexor MCP server and delegation skill. Install the Hermes plugin by Git commit or load the OpenClaw bundle from a checkout.

The shared skill uses MCP Ask's `noProject` option from [#730](https://github.com/razzant/claudexor/pull/730) for self-contained questions with no project selected. It carries a named account into the first Ask and shows the full isolated change before asking for approval to apply it.

Pi integration by [Ouroboros](https://github.com/razzant/ouroboros). The `claudexor` npm package adds the Pi extension, MCP descriptor, skill, and `pi-package` keyword for gallery discovery. Use `pi install npm:claudexor` with a release that includes the extension. For older releases, load `packages/claudexor` from a Git checkout containing it.
