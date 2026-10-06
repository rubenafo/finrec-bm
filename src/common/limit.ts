/** Runs a task when a slot is free, so no more than the limiter's size run at once. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A concurrency limiter: at most `size` tasks run at once, and waiting tasks
 * start in the order they were submitted.
 */
export function limiter(size: number): Limit {
  if (!Number.isInteger(size) || size < 1) throw new Error(`concurrency must be a whole number of at least 1, not ${size}`);
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiting task, or free it.
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
