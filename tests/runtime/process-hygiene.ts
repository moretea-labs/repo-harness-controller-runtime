import { execFileSync } from "child_process";
import { terminateProcessTree } from "../../src/runtime/shared/process-tree";

export interface MatchingProcess {
  pid: number;
  ppid: number;
  command: string;
}

function normalizedMatchers(matchers: string[]): string[] {
  return matchers.map((entry) => entry.trim()).filter(Boolean);
}

export function findProcessesByCommand(matchers: string[]): MatchingProcess[] {
  const needles = normalizedMatchers(matchers);
  if (needles.length === 0) return [];
  let output = "";
  try {
    output = execFileSync(
      "ps",
      ["ax", "-o", "pid=", "-o", "ppid=", "-o", "command="],
      {
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 512 * 1024,
      },
    );
  } catch (_error) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      command: match[3] ?? "",
    }))
    .filter((entry) =>
      Number.isInteger(entry.pid) &&
      entry.pid > 0 &&
      entry.pid !== process.pid &&
      needles.some((needle) => entry.command.includes(needle)))
    .sort((left, right) => left.pid - right.pid);
}

export async function terminateProcessesByCommand(matchers: string[]): Promise<number[]> {
  const terminated = new Set<number>();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const matches = findProcessesByCommand(matchers);
    if (matches.length === 0) break;
    for (const match of matches) {
      terminated.add(match.pid);
      await terminateProcessTree(match.pid, {
        gracePeriodMs: 100,
        killAfterMs: 1_500,
        pollIntervalMs: 25,
      });
    }
    await Bun.sleep(25);
  }
  await waitForNoProcessesByCommand(matchers);
  return [...terminated];
}

export async function waitForNoProcessesByCommand(
  matchers: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = findProcessesByCommand(matchers);
    if (matches.length === 0) return;
    await Bun.sleep(25);
  }
  const remaining = findProcessesByCommand(matchers);
  if (remaining.length === 0) return;
  throw new Error(
    `processes still matched ${normalizedMatchers(matchers).join(", ")}: ${remaining
      .map((entry) => `${entry.pid}(ppid=${entry.ppid}):${entry.command}`)
      .join(" | ")}`,
  );
}
