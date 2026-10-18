import assert from "node:assert/strict";
import test from "node:test";
import { parseLiveOptions } from "../live/options.js";

for (const args of [["--help"], ["--", "--help"], ["--config", "missing.json", "--help"]]) {
  test(`live options help is side-effect free: ${args.join(" ")}`, () => {
    const result = parseLiveOptions(args);
    assert.equal(result.kind, "help");
    if (result.kind === "help") assert.match(result.help, /费用[\s\S]*--allow-live/);
  });
}

test("live options require explicit config and cost opt-in, and accept a leading package-manager separator", () => {
  assert.equal(parseLiveOptions([]).kind, "error");
  assert.equal(parseLiveOptions(["--allow-live"]).kind, "error");
  assert.equal(parseLiveOptions(["--config", "file.json"]).kind, "error");
  for (const prefix of [[], ["--"]]) {
    assert.deepEqual(parseLiveOptions([...prefix, "--config", "file.json", "--allow-live"]), {
      kind: "ok", options: { configPath: "file.json", keepArtifacts: false },
    });
  }
  assert.deepEqual(parseLiveOptions(["--config", "file.json", "--allow-live", "--keep-artifacts"]), {
    kind: "ok", options: { configPath: "file.json", keepArtifacts: true },
  });
});

for (const extra of [["--api-key", "no-secret-on-cli"], ["--unknown"], ["positional"], ["--", "--unknown"], ["--allow-live"]]) {
  test(`live options reject unknown, positional, trailing or duplicate input: ${extra[0]}`, () => {
    const result = parseLiveOptions(["--config", "file.json", "--allow-live", ...extra]);
    assert.equal(result.kind, "error");
    assert.ok(!JSON.stringify(result).includes("no-secret-on-cli"));
  });
}

for (const args of [["--config"], ["--config", "--allow-live"], ["--config", " ", "--allow-live"]]) {
  test(`live options reject a missing configuration value: ${JSON.stringify(args)}`, () => {
    assert.equal(parseLiveOptions(args).kind, "error");
  });
}
