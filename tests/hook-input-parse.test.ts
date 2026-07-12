import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const HOOK_INPUT_ASSET = join(ROOT, "assets/hooks/hook-input.sh");

function probeHookJsonGet(opts: {
  source: string;
  stdin: string;
  path: string;
  defaultValue?: string;
}) {
  const defaultValue = opts.defaultValue ?? "";
  const cmd = [
    "set -u",
    `source '${opts.source}'`,
    `hook_json_get '${opts.path}' '${defaultValue}'`,
  ].join("; ");
  return spawnSync("bash", ["-c", cmd], {
    input: opts.stdin,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOOK_REPO_ROOT: ROOT,
    },
  });
}

for (const source of [HOOK_INPUT_ASSET]) {
  describe(`hook_json_get (${source.replace(ROOT + "/", "")})`, () => {
    test("returns value when key is present in valid JSON", () => {
      const res = probeHookJsonGet({
        source,
        stdin: JSON.stringify({ run_id: "xyz" }),
        path: ".run_id",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("xyz");
      expect(res.stderr).not.toContain("[HookInput]");
    });

    test("returns default and stays silent when key is absent from valid JSON", () => {
      // Real-world repro: Claude UserPromptSubmit payload has no .run_id field.
      const res = probeHookJsonGet({
        source,
        stdin: JSON.stringify({
          session_id: "abc",
          prompt: "hi",
          hook_event_name: "UserPromptSubmit",
        }),
        path: ".run_id",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).not.toContain("[HookInput]");
    });

    test("falls back to default and emits WARN when stdin is malformed JSON", () => {
      const res = probeHookJsonGet({
        source,
        stdin: "not valid json{",
        path: ".run_id",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("[HookInput]");
    });

    test("returns default silently when stdin is empty", () => {
      const res = probeHookJsonGet({
        source,
        stdin: "",
        path: ".run_id",
        defaultValue: "fallback",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("fallback");
      expect(res.stderr).not.toContain("[HookInput]");
    });
  });
}
