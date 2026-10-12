/**
 * 同一实例内把完整的“读、改、写”串行化，避免并发操作覆盖彼此。
 * 队列只负责顺序，不吞掉当前调用的错误；失败也不会阻塞后续操作。
 * 每个 repository 持有自己的队列，不提供跨进程锁或重试策略。
 */
export const createSerializedWriter = () => {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = pending.then(work, work);
    pending = run.catch(() => undefined);
    return run;
  };
};
