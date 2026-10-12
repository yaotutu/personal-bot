/**
 * Apps 页可编辑的助手身份设置。
 *
 * 这组字段属于 memory.json 的业务数据；SOUL.md/USER.md 是另一条只读的
 * profile 文件输入，后续由 pi prompt adapter 负责读取，不能混成一个存储入口。
 */
export type Identity = {
  name: string;
  tone: string;
  avatar: string;
  showChatUpdates: boolean;
};

export const defaultIdentity: Identity = {
  name: "Personal Bot",
  tone: "warm",
  avatar: "sky",
  showChatUpdates: true,
};
