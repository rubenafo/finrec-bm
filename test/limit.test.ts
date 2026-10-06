import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { limiter } from "../src/common/limit.js";

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
