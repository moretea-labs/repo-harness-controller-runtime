import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("portable test runner", () => {
  test("runs exhaustive tests as bounded isolated per-file processes", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain("git ls-files -z");
    expect(script).toContain('REPO_HARNESS_TEST_PARALLELISM:-1');
    expect(script).toContain('max_test_parallelism=4');
    expect(script).toContain('test_files=()');
    expect(script).toContain('exec bun test --isolate --max-concurrency "$test_parallelism" "$@" "${test_files[@]}"');
    expect(script).not.toContain("xargs -0");
    expect(script).not.toContain("bun test --parallel");
  });

  test("keeps explicit file invocations focused and isolated", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain('exec bun test --isolate "$@"');
  });
});
