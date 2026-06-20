#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

export const DEFAULT_G1_REPORT = ".ai/harness/runs/loop-engine-03-no-go-router-schema-repair.json";
export const DEFAULT_SHADOW_REPORT = ".ai/harness/runs/loop-engine-shadow-divergence.json";
export const DEFAULT_OUT = ".ai/harness/runs/loop-engine-07-cutover-gate.json";
export const REQUIRED_CLASSIFIER_FILES = [
  "src/cli/hook/prompt-intents.ts",
  "src/cli/hook/prompt-guard-decision.ts",
] as const;

export interface CutoverGateOptions {
  repo: string;
  g1Report: string;
  shadowReport: string;
  out: string;
  minSamples: number;
  now?: Date;
}

export interface CutoverGateReport {
  protocol: "loop-engine-cutover-gate/v1";
  generated_at: string;
  inputs: {
    g1_report: string;
    shadow_report: string;
    min_samples: number;
  };
  g1: {
    status: "go" | "no-go" | "missing" | "invalid";
    reason: string;
  };
  shadow: {
    status: "go" | "no-go" | "missing" | "invalid";
    reason: string;
    sample_count: number | null;
    window_days: number | null;
    phase_probe_within_baseline: boolean | null;
  };
  classifier_guardrail: {
    authority: "typescript";
    required_files: Array<{
      path: string;
      present: boolean;
    }>;
    present: boolean;
    violation: boolean;
  };
  cutover: {
    allowed: boolean;
    mode: "eligible" | "blocked";
    reason: string;
  };
}

interface JsonObject {
  [key: string]: unknown;
}

function usage(): string {
  return [
    "Usage: scripts/loop-engine-cutover-gate.ts [--repo PATH] [--g1-report PATH] [--shadow-report PATH] [--out PATH] [--min-samples N] [--json]",
    "",
    "Evaluates whether the loop-engine Track A cutover is allowed.",
  ].join("\n");
}

function resolveInRepo(repo: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(repo, candidate);
}

function relativeToRepo(repo: string, candidate: string): string {
  const rel = relative(repo, resolveInRepo(repo, candidate));
  return rel.startsWith("..") || isAbsolute(rel) ? candidate : rel.replaceAll("\\", "/");
}

function readJson(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function stringAt(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectAt(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function readG1(repo: string, reportPath: string): CutoverGateReport["g1"] {
  const absolute = resolveInRepo(repo, reportPath);
  if (!existsSync(absolute)) {
    return { status: "missing", reason: "Second G1 report is missing." };
  }
  const report = readJson(absolute);
  if (!report) {
    return { status: "invalid", reason: "Second G1 report is not valid JSON." };
  }

  const topLevel = stringAt(report.conclusion);
  const goNoGo = objectAt(report.go_no_go);
  const recommendation = stringAt(goNoGo.recommendation);
  const codex = objectAt(report.codex);
  const claude = objectAt(report.claude);
  const codexRecommendation = stringAt(objectAt(codex.go_no_go).recommendation);
  const claudeRecommendation = stringAt(objectAt(claude.go_no_go).recommendation);
  const reason = stringAt(report.reason) || stringAt(goNoGo.reason) || "Second G1 report did not include a reason.";

  const isGo = topLevel === "go" ||
    recommendation === "go" ||
    (codexRecommendation === "go" && claudeRecommendation === "go");
  if (isGo) return { status: "go", reason };

  const isNoGo = topLevel === "no-go" ||
    recommendation === "no-go" ||
    codexRecommendation === "no-go" ||
    claudeRecommendation === "no-go";
  if (isNoGo) return { status: "no-go", reason };

  return { status: "invalid", reason: "Second G1 report has no recognized go/no-go recommendation." };
}

function readShadow(repo: string, reportPath: string, minSamples: number): CutoverGateReport["shadow"] {
  const absolute = resolveInRepo(repo, reportPath);
  if (!existsSync(absolute)) {
    return {
      status: "missing",
      reason: "Shadow divergence report is missing; cutover remains blocked.",
      sample_count: null,
      window_days: null,
      phase_probe_within_baseline: null,
    };
  }
  const report = readJson(absolute);
  if (!report) {
    return {
      status: "invalid",
      reason: "Shadow divergence report is not valid JSON.",
      sample_count: null,
      window_days: null,
      phase_probe_within_baseline: null,
    };
  }

  const goNoGo = objectAt(report.go_no_go);
  const recommendation = stringAt(goNoGo.recommendation) || stringAt(report.recommendation);
  const sampleCount = numberAt(report.sample_count) ?? numberAt(report.samples);
  const windowDays = numberAt(report.window_days) ?? numberAt(report.duration_days);
  const divergence = objectAt(report.divergence);
  const criticalCount = numberAt(divergence.critical_count) ?? numberAt(report.critical_divergence_count) ?? 0;
  const falsePositiveCount = numberAt(divergence.false_positive_count) ?? numberAt(report.false_positive_count) ?? 0;
  const falseNegativeCount = numberAt(divergence.false_negative_count) ?? numberAt(report.false_negative_count) ?? 0;
  const phaseProbe = objectAt(report.phase_probe);
  const phaseWithinBaseline = typeof phaseProbe.within_baseline === "boolean"
    ? phaseProbe.within_baseline
    : (
        numberAt(phaseProbe.current_ms) !== null && numberAt(phaseProbe.baseline_ms) !== null
          ? (numberAt(phaseProbe.current_ms) ?? Infinity) <= (numberAt(phaseProbe.baseline_ms) ?? -Infinity)
          : null
      );

  const enoughCoverage = (sampleCount ?? 0) >= minSamples || (windowDays ?? 0) >= 14;
  const noCriticalDivergence = criticalCount === 0 && falsePositiveCount === 0 && falseNegativeCount === 0;
  const phaseOk = phaseWithinBaseline === true;

  if (recommendation === "go" && enoughCoverage && noCriticalDivergence && phaseOk) {
    return {
      status: "go",
      reason: stringAt(goNoGo.reason) || "Shadow divergence report meets G2.",
      sample_count: sampleCount,
      window_days: windowDays,
      phase_probe_within_baseline: phaseWithinBaseline,
    };
  }

  const reasons = [];
  if (recommendation !== "go") reasons.push("recommendation is not go");
  if (!enoughCoverage) reasons.push(`coverage is below ${minSamples} samples or 14 days`);
  if (!noCriticalDivergence) reasons.push("critical route divergence exists");
  if (!phaseOk) reasons.push("phase-probe timing is not within baseline");
  return {
    status: recommendation === "no-go" ? "no-go" : "invalid",
    reason: reasons.join("; "),
    sample_count: sampleCount,
    window_days: windowDays,
    phase_probe_within_baseline: phaseWithinBaseline,
  };
}

export function evaluateCutoverGate(options: CutoverGateOptions): CutoverGateReport {
  const repo = resolve(options.repo);
  const g1 = readG1(repo, options.g1Report);
  const shadow = readShadow(repo, options.shadowReport, options.minSamples);
  const requiredFiles = REQUIRED_CLASSIFIER_FILES.map((filePath) => ({
    path: filePath,
    present: existsSync(join(repo, filePath)),
  }));
  const classifierPresent = requiredFiles.every((file) => file.present);
  const classifierViolation = !classifierPresent && shadow.status !== "go";

  let allowed = false;
  let reason = "";
  if (classifierViolation) {
    reason = "typescript_classifier_missing_before_g2";
  } else if (g1.status !== "go") {
    reason = `g1_${g1.status}`;
  } else if (shadow.status !== "go") {
    reason = shadow.status === "missing" ? "missing_shadow_divergence_report" : `shadow_${shadow.status}`;
  } else {
    allowed = true;
    reason = "g1_and_shadow_g2_go";
  }

  return {
    protocol: "loop-engine-cutover-gate/v1",
    generated_at: (options.now ?? new Date()).toISOString(),
    inputs: {
      g1_report: relativeToRepo(repo, options.g1Report),
      shadow_report: relativeToRepo(repo, options.shadowReport),
      min_samples: options.minSamples,
    },
    g1,
    shadow,
    classifier_guardrail: {
      authority: "typescript",
      required_files: requiredFiles,
      present: classifierPresent,
      violation: classifierViolation,
    },
    cutover: {
      allowed,
      mode: allowed ? "eligible" : "blocked",
      reason,
    },
  };
}

interface CliOptions {
  repo: string;
  g1Report: string;
  shadowReport: string;
  out: string;
  minSamples: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions | { error: string; help?: boolean } {
  const opts: CliOptions = {
    repo: process.cwd(),
    g1Report: DEFAULT_G1_REPORT,
    shadowReport: DEFAULT_SHADOW_REPORT,
    out: DEFAULT_OUT,
    minSamples: 100,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { error: "", help: true };
    if (arg === "--repo") {
      opts.repo = argv[++i] ?? "";
    } else if (arg === "--g1-report") {
      opts.g1Report = argv[++i] ?? "";
    } else if (arg === "--shadow-report") {
      opts.shadowReport = argv[++i] ?? "";
    } else if (arg === "--out") {
      opts.out = argv[++i] ?? "";
    } else if (arg === "--min-samples") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return { error: "invalid --min-samples" };
      opts.minSamples = parsed;
    } else if (arg === "--json") {
      opts.json = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  if (!opts.repo || !opts.g1Report || !opts.shadowReport || !opts.out) {
    return { error: "missing required option value" };
  }
  return opts;
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.help) {
      console.log(usage());
      return 0;
    }
    console.error(`loop-engine-cutover-gate: ${parsed.error}`);
    console.error(usage());
    return 2;
  }

  const repo = resolve(parsed.repo);
  const report = evaluateCutoverGate({ ...parsed, repo });
  const outPath = resolveInRepo(repo, parsed.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (parsed.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`loop-engine-cutover-gate allowed=${report.cutover.allowed} reason=${report.cutover.reason} out=${relativeToRepo(repo, parsed.out)}`);
  }
  return report.classifier_guardrail.violation ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
