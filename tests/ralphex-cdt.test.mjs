import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const cdt = await jiti.import(resolve(root, "extensions/ralphex/cdt.ts"));

function response(payload, code = 0) {
  return {
    code,
    stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
    stderr: "",
    assistantText: "",
  };
}

test("ralphex CDT release performs preflight, forwards IDs, and waits by run id", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-cdt-"));
  try {
    await writeFile(join(temporary, "cdt.yaml"), "version: 1\n", "utf8");
    const calls = [];
    const runner = async (options) => {
      calls.push(options);
      const command = options.args.join(" ");
      if (command === "pipeline list") return response("test\nprod\n");
      if (command === "pipeline inspect test --json") return response({ declared_risk: "standard", errors: [], steps: [] });
      if (command === "pipeline plan test --json") return response({ declared_risk: "standard", overall_risk: "upload", errors: [] });
      if (command === "pipeline preflight test --json") return response({ status: "ok", errors: [] });
      if (command === "agent-release start test --id BTL-1 --id BTL-2 --json") return response({ run_id: "run-123" });
      if (command === "agent-release status --run run-123 --wait --timeout 90m --json") {
        return response({
          status: "success",
          run_id: "run-123",
          new_version: "1.2.3+45",
          log: ".cdt/runs/run-123/output.log",
          artifacts: [{ path: "build/app.aab" }],
        });
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = await cdt.runCdtRelease({
      cwd: temporary,
      request: { pipeline: "test", ids: ["BTL-1", "BTL-2"] },
      runner,
    });

    assert.equal(result.status, "success");
    assert.equal(result.runId, "run-123");
    assert.equal(result.version, "1.2.3+45");
    assert.deepEqual(result.artifacts, ["build/app.aab"]);
    assert.equal(calls.at(-1).timeoutMs, 91 * 60 * 1000);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex CDT integration rejects production before starting a release", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-cdt-prod-"));
  try {
    await writeFile(join(temporary, "cdt.yaml"), "version: 1\n", "utf8");
    const calls = [];
    const runner = async (options) => {
      calls.push(options.args.join(" "));
      if (options.args.join(" ") === "pipeline list") return response("prod\n");
      if (options.args[1] === "inspect") return response({ declared_risk: "production", errors: [], steps: [] });
      if (options.args[1] === "plan") return response({ declared_risk: "production", overall_risk: "production", errors: [] });
      throw new Error("release must not reach preflight or start");
    };

    const result = await cdt.runCdtRelease({
      cwd: temporary,
      request: { pipeline: "prod", ids: [] },
      runner,
    });

    assert.equal(result.status, "failed");
    assert.match(result.reason, /production pipeline 'prod' is forbidden/);
    assert.deepEqual(calls, ["pipeline list", "pipeline inspect prod --json", "pipeline plan prod --json"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex CDT timeout is reported as still running, not as plan failure", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-cdt-timeout-"));
  try {
    await writeFile(join(temporary, "cdt.yaml"), "version: 1\n", "utf8");
    const runner = async ({ args }) => {
      const command = args.join(" ");
      if (command === "pipeline list") return response("test\n");
      if (command.startsWith("pipeline inspect")) return response({ declared_risk: "standard", errors: [], steps: [] });
      if (command.startsWith("pipeline plan")) return response({ declared_risk: "standard", overall_risk: "upload", errors: [] });
      if (command.startsWith("pipeline preflight")) return response({ status: "ok", errors: [] });
      if (command.startsWith("agent-release start")) return response({ run_id: "run-timeout" });
      return response({ status: "running", wait_status: "timeout", run_id: "run-timeout" });
    };

    const result = await cdt.runCdtRelease({ cwd: temporary, request: { pipeline: "test", ids: [] }, runner });
    assert.equal(result.status, "running");
    assert.equal(result.runId, "run-timeout");
    assert.match(result.reason, /still running/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
