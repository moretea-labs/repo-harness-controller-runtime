#!/usr/bin/env bun
import { resolve } from "path";
import { formatControllerServiceStatus } from "./lifecycle";
import {
  formatControllerRestartScheduled,
  requestControllerServiceRestart,
  runControllerRestartCoordinator,
} from "./restart-coordinator";

function option(args: string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Lifecycle startup derives child commands from process.argv[1]. This helper
// is not the public CLI, so preserve the real repo-harness CLI entrypoint for
// the newly started Supervisor, Gateway, Daemon, and Local Bridge processes.
process.argv[1] = resolve(import.meta.dir, "..", "index.ts");

const [action, ...args] = process.argv.slice(2);
const repo = option(args, "--repo") ?? process.cwd();
const controllerHome = option(args, "--controller-home") ?? process.env.REPO_HARNESS_CONTROLLER_HOME;
const requestId = option(args, "--request-id");
const logFile = option(args, "--log-file");
const json = args.includes("--json");

if (action === "request") {
  const result = await requestControllerServiceRestart({
    repo,
    controllerHome,
    logFile,
    requestId,
    reason: option(args, "--reason"),
    requestedBy: option(args, "--requested-by") ?? "controller-runtime-script",
    mode: args.includes("--detached") ? "detached" : "auto",
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.action === "restart_scheduled") console.log(formatControllerRestartScheduled(result));
  else console.log(formatControllerServiceStatus(result.status));
} else if (action === "run") {
  if (!requestId) throw new Error("--request-id is required for restart coordinator run");
  const state = await runControllerRestartCoordinator({ repo, controllerHome, requestId, logFile });
  console.log(json ? JSON.stringify(state, null, 2) : `Controller restart ${state.requestId}: ${state.phase}`);
} else {
  throw new Error(`unknown restart coordinator action: ${action ?? "(missing)"}`);
}
