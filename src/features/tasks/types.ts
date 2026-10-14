/**
 * 异步任务域：用户交给助手在后台独立会话里执行的一次性工作。
 * 与定时任务（jobs）分开存储和调度；两者共享控制语义（取消/重试）与
 * Web 任务页投影。执行 = 独立 thread 的一次完整 pi 轮（含工具调用），
 * 结果回写任务记录；失败只诚实标记，可手动重试，无断点续跑。
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type Task = {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  source: "chat" | "web";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 最近一次执行的输出文本（截断存储，完整过程在任务 thread 历史）。 */
  result?: string;
  error?: string;
};

/** 任务存储 port；实现由 storage adapter 注入，feature 不碰文件系统。 */
export type TaskRepository = {
  read: () => Promise<Task[]>;
  update: <T>(change: (tasks: Task[]) => { tasks?: Task[]; result: T }) => Promise<T>;
};
