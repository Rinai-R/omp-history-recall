import { expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createRuntimeFixture, streamReply, type FixtureUIFrame, type RuntimeFixture } from "./runtime-fixture";

// These integration timers deliberately share the platform clock with SDK HTTP
// cancellation and native render ticks; global fake time would freeze transport cleanup.

function widgets(fixture: RuntimeFixture): FixtureUIFrame[] {
  return fixture.uiFrames.filter(event => event.key === "history-recall-progress");
}

function widgetText(event: FixtureUIFrame | undefined): string {
  expect(event).toBeDefined();
  return stripVTControlCharacters(event!.lines.join("\n"));
}

function widgetMounted(fixture: RuntimeFixture): boolean {
  const event = fixture.uiEvents.findLast(event => event.kind === "widget" && event.key === "history-recall-progress");
  return event?.kind === "widget" && event.content !== undefined;
}

function expectFooterCleared(fixture: RuntimeFixture): void {
  expect(fixture.uiEvents.findLast(event => event.kind === "status" && event.key === "history-recall"))
    .toMatchObject({ text: undefined });
}

function counter(text: string, name: "completed" | "failed" | "calls"): number {
  const labels = { completed: "已提交", failed: "未提交", calls: "调用" };
  const match = new RegExp(`${labels[name]}\\s+(\\d+)`).exec(text);
  expect(match, `Missing ${name} counter in ${JSON.stringify(text)}`).not.toBeNull();
  return Number(match![1]);
}

async function waitFor(predicate: () => boolean, description: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

async function reachGate(entered: Promise<void>, work: Promise<unknown>): Promise<void> {
  await Promise.race([entered, work.then(() => { throw new Error("Indexing settled before reaching the local provider gate"); })]);
}

async function expectStopped(fixture: RuntimeFixture): Promise<void> {
  expectFooterCleared(fixture);
  expect(widgetMounted(fixture)).toBe(true);
  const events = fixture.uiEvents.length;
  const frames = fixture.uiFrames.length;
  const summary = widgetText(widgets(fixture).at(-1));
  await Bun.sleep(500);
  expect(fixture.uiEvents.length).toBe(events);
  expect(fixture.uiFrames.length).toBe(frames);
  expect(widgetText(widgets(fixture).at(-1))).toBe(summary);
}

async function expectDismissed(fixture: RuntimeFixture): Promise<void> {
  await expectStopped(fixture);
  await Bun.sleep(2000);
  expect(widgetMounted(fixture)).toBe(true);
  await waitFor(() => !widgetMounted(fixture), "the result widget to dismiss after three seconds", 1000);
  expectFooterCleared(fixture);
  const events = fixture.uiEvents.length;
  const frames = fixture.uiFrames.length;
  await Bun.sleep(300);
  expect(fixture.uiEvents.length).toBe(events);
  expect(fixture.uiFrames.length).toBe(frames);
}

it("processes the full queue with live event counters and auto-dismisses its completed TUI result", async () => {
  const analysisEntered = Promise.withResolvers<void>();
  const analysisRelease = Promise.withResolvers<void>();
  const repairEntered = Promise.withResolvers<void>();
  const repairRelease = Promise.withResolvers<void>();
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
  let analysisGated = false;
  let repairGated = false;
  const fixture = await createRuntimeFixture({ observeUI: true,
    async utilityReply(_input, _request, respond) {
      if (!analysisGated) {
        analysisGated = true;
        analysisEntered.resolve();
        await analysisRelease.promise;
      }
      return respond();
    },
    async nativeReply(_request, respond) {
      if (!repairGated) {
        repairGated = true;
        repairEntered.resolve();
        await repairRelease.promise;
      }
      return respond();
    },
  });
  let work: Promise<unknown> | undefined;
  try {
    expect(fixture.context.hasUI).toBe(true);
    expect(fixture.context.mode).toBe("tui");
    work = fixture.session.prompt("/history-recall index-all");
    await reachGate(analysisEntered.promise, work);
    const initial = widgets(fixture)[0];
    expect(initial.calls).toBe(0);
    expect(counter(widgetText(initial), "completed")).toBe(0);
    expect(counter(widgetText(initial), "calls")).toBe(0);
    expect(fixture.uiEvents.some(event => event.kind === "status" && event.key === "history-recall" && event.calls === 0 && event.text)).toBe(true);
    const waiting = widgetText(widgets(fixture).at(-1));
    expect(waiting).toMatch(/分析/);
    expect(waiting).toContain(path.basename(fixture.files.a));
    expect(waiting).toContain("0/3");
    expect(fixture.utilityRequests).toHaveLength(1);
    const beforeAnimation = widgets(fixture).length;
    await waitFor(() => widgets(fixture).slice(beforeAnimation).some(event => widgetText(event) !== waiting), "an animated frame while analysis is gated");
    for (const event of widgets(fixture).slice(beforeAnimation)) {
      const text = widgetText(event);
      expect(counter(text, "completed")).toBe(0);
      expect(counter(text, "failed")).toBe(0);
      expect(counter(text, "calls")).toBe(counter(waiting, "calls"));
      expect(text).toContain("0/3");
    }
    expect(fixture.utilityRequests).toHaveLength(1);
    expect(fixture.store.status().conversations).toBe(0);

    analysisRelease.resolve();
    await reachGate(repairEntered.promise, work);
    const repairing = widgetText(widgets(fixture).at(-1));
    expect(repairing).toMatch(/取证|整理/);
    expect(repairing).toContain(path.basename(fixture.files.b));
    expect(repairing).toContain("1/3");
    expect(counter(repairing, "completed")).toBe(1);
    expect(counter(repairing, "calls")).toBeGreaterThan(counter(waiting, "calls"));
    expect(counter(repairing, "calls")).toBeLessThanOrEqual(fixture.utilityRequests.length + fixture.nativeRequests.length);
    expect(fixture.store.status().conversations).toBe(1);
    repairRelease.resolve();
    await work;

    const summary = widgetText(widgets(fixture).at(-1));
    const status = fixture.store.status();
    expect(counter(summary, "completed")).toBe(status.conversations);
    expect(counter(summary, "completed")).toBe(3);
    expect(counter(summary, "failed")).toBe(0);
    expect(counter(summary, "calls")).toBe(status.indexing_calls_today);
    expect(counter(summary, "calls")).toBe(fixture.utilityRequests.length + fixture.nativeRequests.length);
    expect(status.jobs).toHaveLength(0);
    expect(widgets(fixture).some(event => /匹配主题/.test(widgetText(event)))).toBe(true);
    expect(widgets(fixture).some(event => /提交索引/.test(widgetText(event)))).toBe(true);
    expect(fixture.notifications.filter(event => event.type === "warning" || event.type === "error")).toEqual([]);
    expect(logs.filter(line => line.includes("[history-recall"))).toEqual([]);
    await expectDismissed(fixture);
    expect(fixture.errors).toEqual([]);
  } finally {
    analysisRelease.resolve();
    repairRelease.resolve();
    await work?.catch(() => {});
    await fixture.close();
    log.mockRestore();
  }
}, 120_000);

it("replaces a failed run before dismissal without letting its old timer erase the new live UI", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let mode: "fail" | "gate" | "normal" = "fail";
  const fixture = await createRuntimeFixture({ observeUI: true,
    async utilityReply(_input, _request, respond) {
      if (mode === "fail") return streamReply({ role: "assistant", content: "truncated" }, "length");
      if (mode === "gate") {
        mode = "normal";
        entered.resolve();
        await release.promise;
      }
      return respond();
    },
  });
  let work: Promise<unknown> | undefined;
  try {
    await fixture.session.prompt(`/history-recall index ${fixture.files.a}`);
    const failure = widgetText(widgets(fixture).at(-1));
    expect(failure).toContain("model_output_truncated");
    expect(counter(failure, "completed")).toBe(0);
    expect(counter(failure, "failed")).toBe(1);
    expect(counter(failure, "calls")).toBe(fixture.store.status().indexing_calls_today);
    expect(fixture.store.status().jobs.find(job => job.file === fixture.files.a)?.error).toBe("model_output_truncated");
    await expectStopped(fixture);

    const eventsBefore = widgets(fixture).length;
    const noticesBefore = fixture.notifications.length;
    const callsBefore = fixture.utilityRequests.length + fixture.nativeRequests.length;
    mode = "gate";
    work = fixture.session.prompt(`/history-recall index ${fixture.files.b}`);
    await reachGate(entered.promise, work);
    const restart = widgets(fixture).slice(eventsBefore).map(widgetText);
    expect(restart.every(text => !text.includes("model_output_truncated"))).toBe(true);
    expect(counter(restart[0], "completed")).toBe(0);
    expect(counter(restart[0], "failed")).toBe(0);
    expect(counter(restart[0], "calls")).toBe(0);
    const eventsWhileRunning = fixture.uiEvents.length;
    const framesWhileRunning = widgets(fixture).length;
    await Bun.sleep(3200);
    expect(widgetMounted(fixture)).toBe(true);
    expect(fixture.uiEvents.slice(eventsWhileRunning).some(event =>
      event.kind === "widget" && event.key === "history-recall-progress" && event.content === undefined)).toBe(false);
    expect(fixture.uiEvents.slice(eventsWhileRunning).some(event =>
      event.kind === "status" && event.key === "history-recall" && event.text === undefined)).toBe(false);
    expect(widgets(fixture).length).toBeGreaterThan(framesWhileRunning);
    expect(counter(widgetText(widgets(fixture).at(-1)), "completed")).toBe(0);
    release.resolve();
    await work;
    const success = widgetText(widgets(fixture).at(-1));
    expect(success).not.toContain("model_output_truncated");
    expect(counter(success, "completed")).toBe(1);
    expect(counter(success, "failed")).toBe(0);
    expect(counter(success, "calls")).toBe(fixture.utilityRequests.length + fixture.nativeRequests.length - callsBefore);
    await fixture.session.prompt("/history-recall status");
    expect(fixture.notifications.slice(noticesBefore).some(notice => notice.message.includes("model_output_truncated"))).toBe(false);
    expect(fixture.notifications.slice(noticesBefore).filter(notice => notice.type === "warning" || notice.type === "error")).toEqual([]);
    await expectStopped(fixture);
    expect(fixture.errors).toEqual([]);
  } finally {
    release.resolve();
    await work?.catch(() => {});
    await fixture.close();
  }
}, 120_000);

it("auto-dismisses real SDK tool cancellation without counting an uncommitted conversation as completed", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await createRuntimeFixture({ observeUI: true,
    async utilityReply(_input, _request, respond) {
      entered.resolve();
      await release.promise;
      return respond();
    },
  });
  let outcome: Promise<unknown> | undefined;
  try {
    const work = fixture.tool("history_recall_index", { file: fixture.files.a });
    // The SDK may persist its own cancellation tool result rather than the
    // extension's JSON result; the observable contract here is UI + durable state.
    outcome = work.then(value => ({ value }), (error: unknown) => ({ error }));
    await reachGate(entered.promise, outcome);
    expect(widgetText(widgets(fixture).at(-1))).toContain(path.basename(fixture.files.a));
    const abort = fixture.session.abort();
    release.resolve();
    await abort;
    await outcome;
    await waitFor(() => widgetText(widgets(fixture).at(-1)).includes("cancelled"), "the cancellation summary");
    const summary = widgetText(widgets(fixture).at(-1));
    expect(counter(summary, "completed")).toBe(0);
    expect(counter(summary, "failed")).toBe(0);
    expect(counter(summary, "calls")).toBe(1);
    expect(fixture.store.status().conversations).toBe(0);
    expect(fixture.store.status().jobs.find(job => job.file === fixture.files.a)).toMatchObject({ lease_until: 0 });
    await expectDismissed(fixture);
    expect(fixture.errors).toEqual([]);
  } finally {
    release.resolve();
    await outcome;
    await fixture.close();
  }
}, 120_000);

it("auto-dismisses the actual final model error after clearing its footer and stopping animation", async () => {
  const fixture = await createRuntimeFixture({ observeUI: true,
    utilityReply: () => streamReply({ role: "assistant", content: "truncated" }, "length"),
  });
  try {
    await fixture.session.prompt(`/history-recall index ${fixture.files.a}`);
    const summary = widgetText(widgets(fixture).at(-1));
    expect(summary).toContain("model_output_truncated");
    expect(counter(summary, "completed")).toBe(0);
    expect(counter(summary, "failed")).toBe(1);
    expect(counter(summary, "calls")).toBe(fixture.utilityRequests.length + fixture.nativeRequests.length);
    expect(fixture.store.status().jobs.find(job => job.file === fixture.files.a)?.error).toBe("model_output_truncated");
    await expectDismissed(fixture);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("disposes a pending result on teardown without firing later presentation callbacks", async () => {
  const fixture = await createRuntimeFixture({ observeUI: true });
  try {
    await fixture.session.prompt(`/history-recall index ${fixture.files.a}`);
    await expectStopped(fixture);
    await fixture.close();
    expect(widgetMounted(fixture)).toBe(false);
    expectFooterCleared(fixture);
    const events = fixture.uiEvents.length;
    const frames = fixture.uiFrames.length;
    await Bun.sleep(3200);
    await fixture.close();
    expect(fixture.uiEvents.length).toBe(events);
    expect(fixture.uiFrames.length).toBe(frames);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("reports headless stage transitions without flooding stdout while a provider is waiting", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
  const stderr = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
  let gated = false;
  const fixture = await createRuntimeFixture({ observeUI: false,
    async utilityReply(_input, _request, respond) {
      if (!gated) {
        gated = true;
        entered.resolve();
        await release.promise;
      }
      return respond();
    },
  });
  let work: Promise<unknown> | undefined;
  try {
    expect(fixture.context.hasUI).toBe(false);
    work = fixture.session.prompt(`/history-recall index ${fixture.files.a}`);
    await reachGate(entered.promise, work);
    const notices = () => logs.filter(line => line.includes("[history-recall"));
    expect(notices().some(line => /分析/.test(line))).toBe(true);
    const waiting = notices();
    await Bun.sleep(500);
    expect(notices()).toEqual(waiting);
    release.resolve();
    await work;
    expect(notices().some(line => /匹配主题/.test(line))).toBe(true);
    expect(notices().some(line => /提交索引/.test(line))).toBe(true);
    expect(fixture.store.status().conversations).toBe(1);
    expect(fixture.uiEvents).toEqual([]);
    const finished = notices();
    await Bun.sleep(500);
    expect(notices()).toEqual(finished);
    expect(fixture.errors).toEqual([]);
  } finally {
    release.resolve();
    await work?.catch(() => {});
    await fixture.close();
    log.mockRestore();
    stderr.mockRestore();
  }
}, 120_000);
