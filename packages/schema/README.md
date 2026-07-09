# @claudexor/schema

The data-shape single source of truth of
[Claudexor](https://github.com/razzant/claudexor): Zod schemas, TypeScript
types, and the generated draft-07 JSON Schemas under `generated/`.

Unlike the engine-internal packages, the SHAPES here are part of Claudexor's
stable 1.0 contract: the control API DTOs and the generated
`generated/<Name>.schema.json` files evolve add-only within a major version
(see "Stability at 1.0" in the repository README). The generated files carry
field-level `description`s and are referenced by name from
`docs/reference/endpoints.json`.

The package follows the monorepo's lockstep version. Use the `claudexor` CLI
as the supported entry point for driving runs; consume this package when you
need the typed shapes or the JSON Schemas themselves.
