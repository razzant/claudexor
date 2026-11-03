/** Golden contract for a Raw API route through the built CLI, its own daemon and
 * the real registry: a route that reads no files plans no project, a request names
 * only a model somebody chose, and convergence rounds accumulate on one delivery
 * base. Offline: OpenRouter's base URL is a loopback server in its own process
 * (`cli` runs synchronously), and what it received is read back from its log. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, cli, makeSandbox, readRunFile } from "./support.js";

let sb: Sandbox;
let stopRouter: () => void = () => {};
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  stopRouter();
  sb.dispose();
});

interface Received {
  model: string;
  prompt: string;
}

/** A catalog listing `vendor/m` and scripted patch answers, in its own process. */
async function router(answers: string[]): Promise<{
  env: NodeJS.ProcessEnv;
  received: () => Received[];
}> {
  const log = join(sb.home, "router-posts.jsonl");
  const script = `
    import { appendFileSync } from "node:fs";
    import { createServer } from "node:http";
    const answers = ${JSON.stringify(answers)};
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") {
          res.end(JSON.stringify({ data: [{ id: "vendor/m", context_length: 1000000 }] }));
          return;
        }
        const body = JSON.parse(raw);
        const messages = body.messages;
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ model: body.model, prompt: messages.at(-1).content }) + "\\n");
        const patch = answers.shift() ?? "";
        res.end(JSON.stringify({
          model: body.model,
          choices: [{ message: { content: patch ? JSON.stringify({ patch }) : "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  stopRouter = () => child.kill();
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    child.once("exit", (code) => reject(new Error(`router exited (${code})`)));
  });
  return {
    env: {
      OPENROUTER_API_KEY: "canary-placeholder-credential",
      CLAUDEXOR_OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
    },
    received: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Received)
        : [],
  };
}

const edit = (path: string, from: string, to: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const create = (path: string, line: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;

const failureCode = (runDir: string) =>
  /^code: (.+)$/m.exec(readRunFile(runDir, "final/failure.yaml"))?.[1];

describe("raw API canary golden stories", () => {
  it("[INV-104:raw-model-required] no chosen model sends nothing; saving one once is enough", async () => {
    const { env, received } = await router([edit("README.md", "# canary fixture", "# raw")]);
    const refused = cli(sb, ["agent", "Update the heading", "--harness", "openrouter", "--json"], {
      env,
    });
    expect(refused.code, refused.stdout + refused.stderr).not.toBe(0);
    expect(received()).toEqual([]);
    const { runDir: refusedDir } = refused.json() as { runDir: string };
    expect(failureCode(refusedDir)).toBe("model_selection_required");
    expect(readRunFile(refusedDir, "final/failure.yaml")).toContain(
      "claudexor settings set harness.openrouter.default_model",
    );

    const saved = cli(sb, ["settings", "set", "harness.openrouter.default_model", "vendor/m"], {
      env,
    });
    expect(saved.code, saved.stderr).toBe(0);
    const ran = cli(
      sb,
      ["agent", "Update the heading", "--harness", "openrouter", "--no-review", "--json"],
      { env },
    );
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(received().map((post) => post.model)).toEqual(["vendor/m"]);
  });

  it("[INV-104:raw-instance-model] each instance reads its own variable, judged like any explicit model", async () => {
    const { env, received } = await router([edit("README.md", "# canary fixture", "# raw")]);
    sb.env.CLAUDEXOR_RAWAPI_MODEL = "vendor/generic-only";
    sb.env.CLAUDEXOR_OPENROUTER_MODEL = "vendor/absent";
    const absent = cli(sb, ["agent", "Update the heading", "--harness", "openrouter", "--json"], {
      env,
    });
    expect(absent.code).not.toBe(0);
    expect(absent.stdout + absent.stderr).toContain("refused model 'vendor/absent'");
    expect(received()).toEqual([]);
  });

  it("[INV-042:raw-plan-review-refused] a route that reads no files plans no project and reviews no change", async () => {
    const { env, received } = await router([]);
    const plan = cli(
      sb,
      ["plan", "Plan the change", "--harness", "openrouter", "--model", "vendor/m", "--json"],
      { env },
    );
    expect(plan.code, plan.stdout + plan.stderr).not.toBe(0);
    expect(plan.stdout + plan.stderr).toContain("cannot read project files");
    const council = cli(
      sb,
      [
        "plan",
        "Plan the change",
        "--council",
        "--n",
        "2",
        "--harness",
        "openrouter",
        "--harness",
        "fake-success",
        "--primary-harness",
        "openrouter",
        "--model",
        "vendor/m",
        "--json",
      ],
      { env },
    );
    expect(council.code, council.stdout + council.stderr).not.toBe(0);
    expect(council.stdout + council.stderr).toContain("cannot read project files");
    expect(received()).toEqual([]);
  });

  it("[INV-041:raw-rounds-cumulative] a second round edits what the first created; the result holds both", async () => {
    const { env, received } = await router([
      edit("README.md", "# canary fixture", "# raw") + create("new.txt", "round one"),
      edit("new.txt", "round one", "round two"),
    ]);
    const gate = join(sb.home, "gate.mjs");
    writeFileSync(
      gate,
      'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("new.txt", "utf8").includes("round two") ? 0 : 1);\n',
    );
    const run = cli(
      sb,
      [
        "agent",
        "Build it",
        "--harness",
        "openrouter",
        "--model",
        "vendor/m",
        "--attempts",
        "2",
        "--no-review",
        "--test",
        JSON.stringify([process.execPath, gate]),
        "--json",
      ],
      { env },
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(received()).toHaveLength(2);
    const second = received()[1]!.prompt;
    expect(second).toContain("RAW_CONTEXT_PACKET:");
    expect(second).toContain("round one");
    const { runDir } = run.json() as { runDir: string };
    const patch = readRunFile(runDir, "final/patch.diff");
    expect(patch).toContain("+# raw");
    expect(patch).toContain("+round two");
    expect(patch).not.toContain("round one");
    expect(readFileSync(join(sb.repo, "README.md"), "utf8")).toBe("# canary fixture\n");
  });
});
