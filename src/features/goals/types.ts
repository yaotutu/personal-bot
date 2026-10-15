/**
 * 目标域：用户的长期目标与里程碑。借鉴 OpenMuse Goal 模型（title/category/
 * milestones/status）但不兼容其客户端，字段自主定义。
 * 目标本身不执行任何东西；执行交给定时/后台任务（后续可关联），
 * 这里只维护诚实的状态与进度。
 */
export type GoalStatus = "active" | "paused" | "completed" | "archived";

export type Milestone = {
  id: string;
  title: string;
  done: boolean;
  doneAt?: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: GoalStatus;
  milestones: Milestone[];
  createdAt: string;
  updatedAt: string;
};

/** 目标存储 port；实现由 storage adapter 注入。 */
export type GoalRepository = {
  read: () => Promise<Goal[]>;
  update: <T>(change: (items: Goal[]) => { items?: Goal[]; result: T }) => Promise<T>;
};
