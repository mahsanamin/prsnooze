"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Queue } = require("../lib/queue");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("raising runtime concurrency immediately drains another queued review", async () => {
  const releases = [];
  const queue = new Queue(() => new Promise((resolve) => releases.push(resolve)), { concurrency: 1 });
  queue.enqueue({ id: "one" });
  queue.enqueue({ id: "two" });
  await tick();
  assert.deepEqual(queue.status().runningJobIds, ["one"]);
  assert.deepEqual(queue.status().pending, ["two"]);

  queue.setConcurrency(2);
  await tick();
  assert.deepEqual(queue.status().runningJobIds.sort(), ["one", "two"]);
  assert.deepEqual(queue.status().pending, []);
  releases.forEach((release) => release());
  await tick();
});

test("lowering runtime concurrency lets active work finish", async () => {
  const releases = [];
  const queue = new Queue(() => new Promise((resolve) => releases.push(resolve)), { concurrency: 2 });
  queue.enqueue({ id: "one" });
  queue.enqueue({ id: "two" });
  await tick();
  queue.setConcurrency(1);
  assert.equal(queue.status().running, 2);
  assert.equal(queue.status().concurrency, 1);
  releases.forEach((release) => release());
  await tick();
});

