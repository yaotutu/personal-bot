/**
 * 工作区只提供两类缓存失效提示，不保存事件历史，也不承载业务状态。
 * 所有连接属于同一个本地用户；订阅者必须同步入队，不能让网络写入阻塞业务。
 */
export type WorkspaceUpdate = "workspace_updated" | "actions_updated";
type Subscriber = { notify: (event: WorkspaceUpdate) => void; close: () => void };

export const createWorkspaceEvents = () => {
  const subscribers = new Set<Subscriber>();
  let closed = false;
  const disconnect = (subscriber: Subscriber) => {
    subscribers.delete(subscriber);
    try { subscriber.close(); } catch { /* 通知连接不改变已完成的业务结果。 */ }
  };
  return {
    subscribe: (subscriber: Subscriber): (() => void) => {
      if (closed) { disconnect(subscriber); return () => {}; }
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    invalidate: (event: WorkspaceUpdate): void => {
      if (closed) return;
      for (const subscriber of [...subscribers]) {
        try { subscriber.notify(event); }
        catch { disconnect(subscriber); }
      }
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      for (const subscriber of [...subscribers]) disconnect(subscriber);
    },
  };
};

export type WorkspaceEvents = ReturnType<typeof createWorkspaceEvents>;
