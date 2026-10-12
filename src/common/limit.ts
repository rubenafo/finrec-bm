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

/**
 * A concurrency limiter that starts tasks in random order: it holds every task
 * until `total` have been submitted, shuffles them, then runs them at most
 * `size` at once. Tasks submitted after that run as slots free up.
 */
export function shuffledLimiter(size: number, total: number, random: () => number = Math.random): Limit {
  if (!Number.isInteger(size) || size < 1) throw new Error(`concurrency must be a whole number of at least 1, not ${size}`);
  let running = 0;
  let submitted = 0;
  let open = total <= 0;
  const waiting: (() => void)[] = [];
  const startNext = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return async (task) => {
    await new Promise<void>((resolve) => {
      submitted++;
      if (open && running < size) {
        running++;
        return resolve();
      }
      waiting.push(resolve);
      if (!open && submitted >= total) {
        open = true;
        // Fisher-Yates shuffle.
        for (let i = waiting.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [waiting[i], waiting[j]] = [waiting[j]!, waiting[i]!];
        }
        while (running < size && waiting.length > 0) {
          running++;
          waiting.shift()!();
        }
      }
    });
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiting task, or free it.
      startNext();
    }
  };
}
