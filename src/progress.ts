import { Text, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import type { IndexResult, WorkProgress } from "./store";

const WIDGET = "history-recall-progress";
const STATUS = "history-recall";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STAGES: Record<WorkProgress["stage"], string> = {
  reading: "读取会话", analysis: "分析内容", selection: "匹配主题", preparing_repair: "核对历史来源",
  repair: "子代理取证与整理", validating: "复核证据", publishing: "提交索引", completed: "会话已提交", failed: "会话未提交",
};

/** Toasts belong to the interactive UI; never write over its renderer. */
export function announce(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(`[history-recall${type === "info" ? "" : `:${type}`}] ${message}`);
}

/** One explicit indexing run; animation does no indexing, SQL polling or model work. */
export class IndexProgress {
  private readonly started = Date.now();
  private stoppedAt?: number;
  private timer?: NodeJS.Timeout;
  private dismissTimer?: NodeJS.Timeout;
  private disposed = false;
  private redraw?: () => void;
  private frame = 0;
  private stage = "扫描待索引会话";
  private file = "";
  private model = "";
  private total = 0;
  private pending = 0;
  private completed = 0;
  private failed = 0;
  private calls = 0;
  private observedCalls = 0;
  private code?: string;
  private detail = "";
  private outcome: "running" | "done" | "paused" | "error" = "running";

  constructor(private readonly ctx: Pick<ExtensionContext, "hasUI" | "ui">) {
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET, (tui, theme) => {
        const text = new Text("", 0, 0);
        this.redraw = () => tui.requestRender();
        return {
          render: (width: number) => {
            if (this.disposed) return [];
            const tone = this.outcome === "error" ? "error" : this.outcome === "done" ? "success" : "accent";
            text.setText(this.lines().map((line, index) => theme.fg(index === 0 ? tone : "muted", line)).join("\n"));
            return text.render(width);
          },
          invalidate: () => text.invalidate(),
          dispose: () => this.dispose(),
        };
      }, { placement: "aboveEditor" });
      this.timer = setInterval(() => { this.frame = (this.frame + 1) % FRAMES.length; this.redraw?.(); }, 120);
      this.timer.unref();
    }
    this.refresh();
  }

  setQueue(total: number, pending: number, model: string): void {
    if (this.disposed || this.outcome !== "running") return;
    this.total = total; this.pending = pending;
    this.model = model.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 100);
    this.refresh();
  }

  update(progress: WorkProgress): void {
    if (this.disposed || this.outcome !== "running") return;
    this.stage = STAGES[progress.stage];
    this.file = path.basename(progress.file).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 100);
    this.completed = progress.completed; this.failed = progress.failed;
    this.total = Math.max(this.total, progress.job);
    this.calls = Math.max(this.calls, progress.calls); this.code = progress.code;
    this.refresh();
  }

  modelCall(): void {
    if (this.disposed || this.outcome !== "running") return;
    this.calls = Math.max(this.calls, ++this.observedCalls);
    this.refresh();
  }

  cancelling(): void {
    if (this.disposed || this.outcome !== "running") return;
    this.stage = "正在取消，等待在途请求结束";
    this.refresh();
  }

  finish(result: IndexResult, pending: number): void {
    if (this.disposed || this.outcome !== "running") return;
    this.stop();
    this.completed = result.completed; this.failed = result.failed; this.calls = result.calls; this.pending = pending;
    this.code = result.errors.at(-1)?.code;
    this.outcome = result.errors.length ? "error" : "done";
    this.stage = result.errors.length ? "本轮有任务失败" : "本轮完成";
    if (!result.completed && !result.failed && pending) this.stage = "暂无可运行任务，等待已有任务或重试";
    this.detail = result.repair_deferred.length ? `${result.repair_deferred.length} 个历史来源暂不可用于修复` : "";
    this.refresh();
    this.dismiss();
  }

  fail(code: string): void {
    if (this.disposed || this.outcome !== "running") return;
    this.stop(); this.code = code;
    this.outcome = code === "cancelled" ? "paused" : "error";
    this.stage = code === "cancelled" ? "已取消，进度已保存" : "索引未完成";
    this.refresh();
    this.dismiss();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    clearTimeout(this.dismissTimer);
    this.dismissTimer = undefined;
    this.redraw = undefined;
    if (this.ctx.hasUI) {
      this.ctx.ui.setStatus(STATUS, undefined);
      this.ctx.ui.setWidget(WIDGET, undefined);
    }
  }

  private dismiss(): void {
    if (!this.ctx.hasUI || this.disposed) return;
    this.dismissTimer = setTimeout(() => this.dispose(), 3000);
    this.dismissTimer.unref();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stoppedAt ??= Date.now();
  }

  private lines(): string[] {
    const seconds = Math.floor(((this.stoppedAt ?? Date.now()) - this.started) / 1000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const heading = `历史索引 ${this.outcome === "running" ? FRAMES[this.frame] + " " : ""}${this.stage} · ${elapsed}`;
    const counters = `已提交 ${this.completed} · 未提交 ${this.failed} · 调用 ${this.calls}`;
    const code = this.code ? ` · ${this.code}` : "";
    if (this.outcome !== "running") {
      return [heading + code, `${counters} · 队列 ${this.pending}${this.detail ? ` · ${this.detail}` : ""}`];
    }
    const processed = this.completed + this.failed;
    const filled = this.total ? Math.min(12, Math.floor(12 * processed / this.total)) : 0;
    return [heading,
      `${"━".repeat(filled)}${"─".repeat(12 - filled)} 本轮已处理 ${processed}/${this.total || "…"} · 队列 ${Math.max(0, this.pending - this.completed)}`,
      `${this.file || "等待任务"}${this.model ? ` · ${this.model}` : ""}`,
      counters + code];
  }

  private refresh(): void {
    if (this.disposed) return;
    if (this.ctx.hasUI) {
      this.ctx.ui.setStatus(STATUS, this.outcome === "running" ? `索引 · ${this.stage} · ${this.calls} 次调用` : undefined);
      this.redraw?.();
    } else if (this.outcome === "running") {
      console.error(`[history-recall] ${this.stage}${this.file ? ` · ${this.file}` : ""} · 已提交 ${this.completed} · 调用 ${this.calls}`);
    } else {
      console.log(`[history-recall] ${this.lines().join(" | ")}`);
    }
  }
}
