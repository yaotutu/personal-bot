import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

// 只读时钟工具：只读本地时钟。不碰文件、shell、网络，参数为空对象，
// 模型无法借它表达任何副作用。错误信息也只包含本地时间格式化的失败原因。
export const currentTimeTool = defineTool({
  name: "currentTime",
  label: "Current time",
  description:
    "Get the current local date and time of the server, including its time zone. " +
    "Use it whenever the user asks what time or date it is now. Takes no arguments.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => {
    const now = new Date();
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
    const local = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
    const text = `${local} (${timeZone})\nISO 8601: ${now.toISOString()}`;
    return {
      content: [{ type: "text", text }],
      details: { iso: now.toISOString(), timeZone, locale },
    };
  },
});
