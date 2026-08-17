import { access } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type ProcessResult } from "./process";

export type ReleaseRequest = {
  pipeline: string;
  ids: string[];
};

export type CdtReleaseResult = {
  status: "success" | "failed" | "running";
  pipeline: string;
  ids: string[];
  runId?: string;
  version?: string;
  artifacts: string[];
  log?: string;
  reason?: string;
};

type Runner = (options: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
}) => Promise<ProcessResult>;

function parseJson(result: ProcessResult, label: string): any {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonErrors(payload: any): string[] {
  return Array.isArray(payload?.errors) ? payload.errors.map((error: unknown) => String(error)) : [];
}

function productionLike(pipeline: string, inspect: any, plan: any): boolean {
  const name = pipeline.toLowerCase();
  if (/^(prod|production|release|deploy)$/.test(name)) return true;
  if (/(^|[-_])(prod|production)([-_]|$)/.test(name)) return true;
  if (String(inspect?.declared_risk ?? "").toLowerCase() === "production") return true;
  if (String(plan?.declared_risk ?? "").toLowerCase() === "production") return true;
  if (String(plan?.overall_risk ?? "").toLowerCase() === "production") return true;

  const selectedSteps = JSON.stringify(inspect?.steps ?? []).toLowerCase();
  return /"(?:profile|environment|env)"\s*:\s*"(?:prod|production)"/.test(selectedSteps)
    || /"name"\s*:\s*"[^"]*(?:^|[._-])prod(?:[._-]|$)/.test(selectedSteps);
}

function artifactStrings(payload: any): string[] {
  if (!Array.isArray(payload?.artifacts)) return [];
  return payload.artifacts.map((artifact: unknown) => {
    if (typeof artifact === "string") return artifact;
    if (artifact && typeof artifact === "object") {
      const value = artifact as Record<string, unknown>;
      return String(value.path ?? value.url ?? value.name ?? JSON.stringify(value));
    }
    return String(artifact);
  });
}

export async function runCdtRelease(options: {
  cwd: string;
  request: ReleaseRequest;
  runner?: Runner;
  onProgress?: (message: string) => void;
}): Promise<CdtReleaseResult> {
  const runner = options.runner ?? runCommand;
  const { pipeline, ids } = options.request;
  try {
    await access(join(options.cwd, "cdt.yaml"));
  } catch {
    return { status: "failed", pipeline, ids, artifacts: [], reason: "cdt.yaml not found" };
  }

  try {
    options.onProgress?.(`CDT preflight · ${pipeline}`);
    const list = await runner({ command: "cdt", args: ["pipeline", "list"], cwd: options.cwd });
    if (list.code !== 0) throw new Error(list.stderr.trim() || "cdt pipeline list failed");
    const pipelines = list.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!pipelines.includes(pipeline)) throw new Error(`pipeline '${pipeline}' not found in cdt.yaml`);

    const inspect = parseJson(await runner({
      command: "cdt", args: ["pipeline", "inspect", pipeline, "--json"], cwd: options.cwd,
    }), "cdt pipeline inspect");
    const plan = parseJson(await runner({
      command: "cdt", args: ["pipeline", "plan", pipeline, "--json"], cwd: options.cwd,
    }), "cdt pipeline plan");
    if (productionLike(pipeline, inspect, plan)) throw new Error(`production pipeline '${pipeline}' is forbidden`);
    const errors = [...jsonErrors(inspect), ...jsonErrors(plan)];
    if (errors.length) throw new Error(errors.join("; "));

    const preflight = parseJson(await runner({
      command: "cdt", args: ["pipeline", "preflight", pipeline, "--json"], cwd: options.cwd,
    }), "cdt pipeline preflight");
    const preflightErrors = jsonErrors(preflight);
    if (preflight.status !== "ok" || preflightErrors.length) {
      throw new Error(preflightErrors.join("; ") || "CDT preflight is not ready");
    }

    const startArgs = ["agent-release", "start", pipeline];
    for (const id of ids) startArgs.push("--id", id);
    startArgs.push("--json");
    options.onProgress?.(`Starting CDT release · ${pipeline}`);
    const started = parseJson(await runner({ command: "cdt", args: startArgs, cwd: options.cwd }), "cdt agent-release start");
    const runId = typeof started.run_id === "string" ? started.run_id : undefined;
    if (!runId) throw new Error("CDT did not return run_id");

    options.onProgress?.(`CDT release ${runId} · waiting up to 90m`);
    const status = parseJson(await runner({
      command: "cdt",
      args: ["agent-release", "status", "--run", runId, "--wait", "--timeout", "90m", "--json"],
      cwd: options.cwd,
      timeoutMs: 91 * 60 * 1000,
    }), "cdt agent-release status");
    const common = {
      pipeline,
      ids,
      runId,
      version: typeof status.new_version === "string" ? status.new_version : undefined,
      artifacts: artifactStrings(status),
      log: typeof status.log === "string" ? status.log : undefined,
    };
    if (status.status === "success") return { status: "success", ...common };
    if (status.wait_status === "timeout" || ["running", "queued"].includes(status.status)) {
      return { status: "running", ...common, reason: "release is still running after 90m" };
    }
    return {
      status: "failed",
      ...common,
      reason: String(status.error ?? status.failed_step ?? `CDT status: ${status.status ?? "unknown"}`),
    };
  } catch (error) {
    return {
      status: "failed",
      pipeline,
      ids,
      artifacts: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
