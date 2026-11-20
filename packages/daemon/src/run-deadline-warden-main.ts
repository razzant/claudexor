/** Entry of the detached run-deadline warden process (`run-deadline-warden.ts`). */
import { runWarden } from "./run-deadline-warden.js";

const statePath = process.argv[2];
if (!statePath) process.exit(2);
runWarden(statePath).then(
  () => process.exit(0),
  () => process.exit(1),
);
