import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { limiter, shuffledLimiter } from "../src/common/limit.js";

describe("limiter", () => {
  it("runs at most `size` tasks at once, starting them in submission order", async () => {
    const limit = limiter(3);
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          started.push(i);
          most = Math.max(most, ++running);
          await sleep(5 + (i % 3) * 5);
          running--;
          return i * 2;
        }),
      ),
    );
    assert.equal(most, 3);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], "each caller gets its own result");
  });

  it("frees the slot when a task fails", async () => {
    const limit = limiter(1);
    await assert.rejects(limit(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await limit(async () => "next"), "next");
  });

  it("rejects a size that isn't a whole number of at least 1", () => {
    for (const size of [0, -1, 1.5, Number.NaN]) assert.throws(() => limiter(size), /at least 1/);
  });
});

describe("shuffledLimiter", () => {
  /** A seeded random number generator (mulberry32), so a test sees the same order every run. */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("holds tasks until all are submitted, then runs every one in shuffled order, at most `size` at once", async () => {
    const limit = shuffledLimiter(3, 10, seeded(1));
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const results = Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          started.push(i);
          most = Math.max(most, ++running);
          await sleep(5);
          running--;
          return i * 2;
        }),
      ),
    );
    assert.deepEqual(await results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], "each caller gets its own result");
    assert.equal(most, 3);
    assert.deepEqual([...started].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.notDeepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("starts nothing before the last task is submitted, even when submissions arrive over time", async () => {
    const limit = shuffledLimiter(4, 3);
    const started: number[] = [];
    const first = limit(async () => started.push(0));
    const second = limit(async () => started.push(1));
    await sleep(10);
    assert.equal(started.length, 0, "held while waiting for the third");
    await Promise.all([first, second, limit(async () => started.push(2))]);
    assert.equal(started.length, 3);
  });

  it("runs tasks submitted after the total as slots free up, and frees the slot when a task fails", async () => {
    const limit = shuffledLimiter(1, 1);
    await assert.rejects(limit(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await limit(async () => "next"), "next");
  });
});
