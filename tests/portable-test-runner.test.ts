import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("portable test runner", () => {
  test("runs exhaustive tests as bounded isolated per-file processes", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain("git ls-files -z");
    expect(script).toContain('xargs -0 -n 1 -P "$test_parallelism"');
    expect(script).toContain('exec bun test --no-orphans "${args[@]}" "$file"');
    expect(script).not.toContain("bun test --parallel");
  });

  test("keeps explicit file invocations focused and isolated", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain('exec bun test --isolate "$@"');
  });
});
