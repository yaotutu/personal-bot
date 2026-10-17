import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const text = z.string().trim().min(1);
const common = {
  repo: text.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  title: text.refine((value) => !/[\r\n]/.test(value), "标题必须为单行"),
  status: z.enum(["discussion", "backlog", "ready"]),
};

// 提报结构与业务运行时隔离；严格拒绝拼错的字段，避免内容在提交时被静默丢弃。
const issueSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...common,
    type: z.literal("bug"),
    description: text,
    reproduction: text.optional(),
    expected: text.optional(),
  }),
  z.strictObject({
    ...common,
    type: z.enum(["feature", "maintenance"]),
    goal: text,
    behavior: text.optional(),
    acceptance: z.array(text).min(1).optional(),
    outOfScope: text.optional(),
  }),
]).superRefine((issue, ctx) => {
  if (issue.status !== "ready") return;
  const required = issue.type === "bug"
    ? ["reproduction", "expected"] as const
    : ["behavior", "acceptance"] as const;
  for (const key of required) {
    if (!(key in issue) || Reflect.get(issue, key) === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: "ready 状态必须提供此字段" });
    }
  }
});

export function prepareIssue(input: unknown) {
  const issue = issueSchema.parse(input);
  const section = (heading: string, value: string | undefined) =>
    `## ${heading}\n${value ?? "待澄清"}`;
  const sections = issue.type === "bug"
    ? [
      section("问题描述", issue.description),
      section("如何复现", issue.reproduction),
      section("预期行为", issue.expected),
    ]
    : [
      section("目标", issue.goal),
      section("期望行为", issue.behavior),
      section("验收标准", issue.acceptance?.map((item) => `- ${item}`).join("\n")),
      ...(issue.outOfScope ? [section("本次不做", issue.outOfScope)] : []),
    ];
  return {
    repo: issue.repo,
    title: issue.title,
    labels: [`type:${issue.type}`, `status:${issue.status}`],
    body: `${sections.join("\n\n")}\n`,
  };
}

type PreparedIssue = ReturnType<typeof prepareIssue>;
type RunGh = (args: string[], body: string) => string;

// 不使用 shell 拼接；正文走 stdin，需求文本不能成为命令或命令行选项。
const runGh: RunGh = (args, body) => execFileSync("gh", args, {
  input: body,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
});

export function submitIssue(issue: PreparedIssue, execute: RunGh = runGh) {
  return execute([
    "issue", "create",
    "--repo", issue.repo,
    "--title", issue.title,
    "--label", issue.labels[0]!,
    "--label", issue.labels[1]!,
    "--body-file", "-",
  ], issue.body).trim();
}

// 默认预览无网络副作用；只有用户确认后显式传 --submit 才创建 Issue，不补建标签、不自动重试。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--submit")) {
      throw new Error("用法：pnpm exec tsx scripts/create-issue.ts [--submit] < issue.json");
    }
    const issue = prepareIssue(JSON.parse(readFileSync(0, "utf8")));
    const result = args[0] === "--submit" ? { url: submitIssue(issue) } : issue;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      process.stderr.write(`输入校验失败：${error.message}\n`);
    } else {
      const failure = error as { stderr?: Buffer | string; message?: string };
      process.stderr.write(`Issue 未确认创建成功：${failure.stderr?.toString().trim() || failure.message || "未知错误"}\n`);
    }
    process.exitCode = 1;
  }
}
