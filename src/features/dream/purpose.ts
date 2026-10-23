/**
 * “空间用途”固定写在 INSTRUCTIONS.md 的 `## 空间用途` 标题下（紧随标题的首段非空文本，以空行或下一标题结束）。
 * 它由用户声明，是 Dream 判断“这条信息是否属于当前空间”的依据，
 * 所以 Dream 绝不能改写它；用户和对话工具仍可自由修改。
 */
export const PURPOSE_HEADING = "## 空间用途";

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

/** 清除指令文本中的 `## 空间用途` 段落（包含标题、其下首段正文及紧随的空行），保留其余规则。 */
export const stripPurpose = (instructions: string): string => {
  let text = instructions.replace(/\r\n/g, "\n");
  while (true) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === PURPOSE_HEADING);
    if (start === -1) break;

    let end = start + 1;
    let hasBody = false;
    while (end < lines.length) {
      const line = lines[end]!;
      if (/^#+\s/.test(line.trim())) break;
      if (!line.trim()) {
        if (hasBody) {
          while (end < lines.length && !lines[end]!.trim()) end++;
          break;
        }
        end++;
        continue;
      }
      hasBody = true;
      end++;
    }

    const before = lines.slice(0, start).join("\n").trim();
    const after = lines.slice(end).join("\n").trim();
    text = before && after ? `${before}\n\n${after}` : before || after;
  }
  return text.trim();
};

/** 把空间声明的用途写入指令文件开头，替换或清除已有用途段，保留其余规则；用途为空时仅清除用途段。 */
export const withPurpose = (instructions: string, purpose: string): string => {
  const remaining = stripPurpose(instructions);
  const text = purpose
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (!text) return remaining;
  return `${PURPOSE_HEADING}\n${text}${remaining ? `\n\n${remaining}` : ""}`;
};
