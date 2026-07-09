# @claudexor/orchestrator

Internal package of [Claudexor](https://github.com/razzant/claudexor) — Hub that composes all subsystems and implements the five canonical modes (ask, plan, audit, agent, orchestrate) with their strategy flags (best-of-N race, attempt caps, until-clean, swarm, create).

Published as part of the Claudexor toolchain; it follows the monorepo's
lockstep version and has no separate semver contract. Use the `claudexor`
CLI (or `@claudexor/cli`) as the supported entry point.
