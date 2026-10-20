/**
 * “会话用途”固定写在 INSTRUCTIONS.md 的 `## 会话用途` 标题下（紧随标题的首段非空文本，以空行或下一标题结束）。
 * 它由用户创建会话时声明，是 Dream 判断“这条信息是否属于当前会话”的依据，
 * 所以 Dream 绝不能改写它；用户和对话工具仍可自由修改。
 */
export const PURPOSE_HEADING = "## 会话用途";

/** 提取用途段正文（标题下第一段非空内容，遇到空行或新标题即结束）；不存在时返回空串。 */
export const readPurpose = (instructions: string): string => {
  const lines = instructions.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === PURPOSE_HEADING);
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#+\s/.test(line.trim())) break;
    if (!line.trim()) {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.trim());
  }
  return body.join("\n").trim();
};

/** 用途段是否被改变；两侧都按规整后的正文比较，忽略首尾空白差异。 */
export const purposeChanged = (before: string, after: string): boolean =>
  readPurpose(before) !== readPurpose(after);

/** 把创建会话时声明的用途写成指令文件的开头；用途为空则不生成该段。 */
export const withPurpose = (instructions: string, purpose: string): string => {
  const text = purpose.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  if (!text) return instructions;
  const rest = instructions.trim();
  return `${PURPOSE_HEADING}\n${text}${rest ? `\n\n${rest}` : ""}`;
};
