/**
 * @claudexor/schema — single source of truth for all Claudexor data shapes.
 *
 * Every other package imports types and validators from here. Do not define
 * competing shapes elsewhere. JSON Schema is generated from these Zod schemas
 * (see scripts/gen-jsonschema.ts).
 */
export * from "./primitives.js";
export * from "./auth.js";
export * from "./problem.js";
export * from "./operation.js";
export * from "./recovery.js";
export * from "./surface-run-controls.js";
export * from "./attachment.js";
export * from "./task.js";
export * from "./spec.js";
export * from "./context.js";
export * from "./harness.js";
export * from "./review.js";
export * from "./workproduct.js";
export * from "./budget.js";
export * from "./route.js";
export * from "./decision.js";
export * from "./delivery.js";
export * from "./control-run-detail.js";
export * from "./gate.js";
export * from "./events.js";
export * from "./telemetry.js";
export * from "./config.js";
export * from "./workspace.js";
export * from "./thread.js";
export * from "./project.js";
export * from "./orchestrate.js";
export * from "./control.js";
export * from "./control-operation-responses.js";
export * from "./control-thread-apply.js";
export * from "./control-run-scope.js";
export * from "./control-spec.js";
export * from "./setup.js";
export * from "./control-trust.js";
export * from "./control-secret.js";
export * from "./agent-capabilities.js";
export * from "./apply-eligibility.js";
