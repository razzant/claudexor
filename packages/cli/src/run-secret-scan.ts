import { assertNoInlineSecretValues } from "@claudexor/util";

export function assertCliRunParamsHaveNoInlineSecrets(value: unknown): void {
  assertNoInlineSecretValues(value, "$", "CLI run params");
}
