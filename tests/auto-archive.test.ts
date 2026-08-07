import assert from "node:assert/strict";
import test from "node:test";
import { AutoArchiveScheduler } from "../src/auto-archive.js";

const terminalPhase = [{ title: "Done", status: "done" as const, body: [] }];

test("AutoArchiveScheduler coalesces terminal-phase writes", async () => {
  let calls = 0;
  const scheduler = new AutoArchiveScheduler(
    () => true,
    async () => { calls += 1; },
  );

  scheduler.schedule(terminalPhase);
  scheduler.schedule(terminalPhase);
  await scheduler.flush();

  assert.equal(calls, 1);
});

test("AutoArchiveScheduler remains inert when disabled or no phase is terminal", async () => {
  let calls = 0;
  const disabled = new AutoArchiveScheduler(() => false, async () => { calls += 1; });
  const enabled = new AutoArchiveScheduler(() => true, async () => { calls += 1; });

  disabled.schedule(terminalPhase);
  enabled.schedule([{ status: "active" }]);
  await Promise.all([disabled.flush(), enabled.flush()]);

  assert.equal(calls, 0);
});

test("AutoArchiveScheduler reports a failure and can retry later", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const scheduler = new AutoArchiveScheduler(
    () => true,
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("archive failed");
    },
    (error) => errors.push(error),
  );

  scheduler.schedule(terminalPhase);
  await scheduler.flush();
  scheduler.schedule(terminalPhase);
  await scheduler.flush();

  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
});
