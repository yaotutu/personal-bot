/**
 * 同一物理文件路径的进程内提交队列。手动 HTTP 写入和模型审批提交必须
 * 使用同一个实例，避免两条入口在最终版本检查与 rename 之间交错覆盖。
 * 这不是跨进程锁，也不提供重试或事务恢复。
 */
export type WorkspaceCommitQueue = <T>(target: string, work: () => Promise<T>) => Promise<T>;

export const createWorkspaceCommitQueue = (): WorkspaceCommitQueue => {
  const pending = new Map<string, Promise<void>>();
  return <T>(target: string, work: () => Promise<T>): Promise<T> => {
    const previous = pending.get(target) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    pending.set(target, tail);
    void tail.then(() => {
      if (pending.get(target) === tail) pending.delete(target);
    });
    return result;
  };
};
