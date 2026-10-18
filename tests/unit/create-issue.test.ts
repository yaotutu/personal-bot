import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { prepareIssue, submitIssue } from "../../scripts/create-issue.js";

const bug = {
  repo: "example/project",
  title: "停止后无法再次发送",
  type: "bug",
  status: "ready",
  description: "停止后发送按钮不可用",
  reproduction: "发送消息，停止，再发送",
  expected: "可以再次发送",
};

test("Issue 脚本生成固定 Bug 模板与唯一类型、状态标签", () => {
  assert.deepEqual(prepareIssue(bug), {
    repo: bug.repo,
    title: bug.title,
    labels: ["type:bug", "status:ready"],
    body: "## 问题描述\n停止后发送按钮不可用\n\n## 如何复现\n发送消息，停止，再发送\n\n## 预期行为\n可以再次发送\n",
  });
});

test("Issue 脚本生成维护模板，按需加入排除范围", () => {
  const input = {
    repo: bug.repo, title: "整理文档", type: "maintenance", status: "ready",
    goal: "减少过时说明", behavior: "文档与代码一致", acceptance: ["启动命令可用", "引用有效"],
  };
  const issue = prepareIssue(input);
  assert.deepEqual(issue.labels, ["type:maintenance", "status:ready"]);
  assert.equal(issue.body, "## 目标\n减少过时说明\n\n## 期望行为\n文档与代码一致\n\n## 验收标准\n- 启动命令可用\n- 引用有效\n");
  assert.ok(prepareIssue({ ...input, outOfScope: "不改业务代码" }).body.endsWith("## 本次不做\n不改业务代码\n"));
});

test("讨论和长期目标允许未细化字段，ready 不允许", () => {
  for (const status of ["discussion", "backlog"]) {
    assert.ok(prepareIssue({ repo: bug.repo, title: "待讨论", type: "feature", status, goal: "改善体验" }).body.includes("待澄清"));
    assert.ok(prepareIssue({ repo: bug.repo, title: "待复现", type: "bug", status, description: "偶发错误" }).body.includes("待澄清"));
  }
  assert.throws(() => prepareIssue({ ...bug, reproduction: undefined }));
  assert.throws(() => prepareIssue({ repo: bug.repo, title: "功能", type: "feature", status: "ready", goal: "目标" }));
});

test("非法枚举、字段、空文本、仓库与标题都在提交前拒绝", () => {
  for (const patch of [
    { type: "unknown" }, { status: "in-progress" }, { status: "blocked" },
    { title: "  " }, { title: "一行\n另一行" }, { repo: "--help" },
    { description: "" }, { labels: ["custom"] }, { expected: null },
  ]) {
    assert.throws(() => prepareIssue({ ...bug, ...patch }));
  }
  assert.throws(() => prepareIssue({ repo: bug.repo, title: "功能", type: "feature", status: "ready", goal: "目标", behavior: "行为", acceptance: [] }));
});

test("提交使用独立参数与正文 stdin，错误不重试", () => {
  const issue = prepareIssue({ ...bug, title: "$(touch /tmp/should-not-exist)", description: "`任意文本`\n--repo other/repo" });
  let calls = 0;
  const result = submitIssue(issue, (args, body) => {
    calls++;
    assert.deepEqual(args, ["issue", "create", "--repo", bug.repo, "--title", issue.title, "--label", "type:bug", "--label", "status:ready", "--body-file", "-"]);
    assert.equal(body, issue.body);
    return "created-issue-link\n";
  });
  assert.equal(result, "created-issue-link");
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(() => submitIssue(issue, () => { calls++; throw new Error("label missing"); }), /label missing/);
  assert.equal(calls, 1);
});

test("CLI 默认预览，非法输入或参数以非零状态退出", () => {
  const run = (input: string, args: string[] = []) => spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/create-issue.ts", ...args],
    { input, encoding: "utf8" },
  );
  const preview = run(JSON.stringify(bug));
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), prepareIssue(bug));
  for (const result of [run("{"), run(JSON.stringify({ ...bug, type: "wrong" }), ["--submit"]), run(JSON.stringify(bug), ["--wrong"])]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr);
  }
});
