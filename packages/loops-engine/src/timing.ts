export type TimingCategory = "jev" | "page" | "playwright" | "capture" | "pacing" | "engine";
export type TimingSpan = {
  id: number; parentId?: number; stepIndex: number | null; category: TimingCategory;
  label: string; startMs: number; durationMs?: number; selfMs?: number;
  status: "running" | "completed" | "error";
};
export type Measure = <T>(category: TimingCategory, label: string, work: () => Promise<T>) => Promise<T>;
export const unmeasured: Measure = (_category, _label, work) => work();

export class RunTiming {
  private state = { stepIndex: null as number | null, spans: [] as TimingSpan[], stack: [] as TimingSpan[] };
  private started: number;

  constructor(private emit: (span: TimingSpan) => void, private now = () => performance.now()) { this.started = now(); }

  step(index: number | null) { this.state.stepIndex = index; }

  measure: Measure = async (category, label, work) => {
    const span: TimingSpan = { id: this.state.spans.length, parentId: this.state.stack.at(-1)?.id,
      stepIndex: this.state.stepIndex, category, label, startMs: this.now() - this.started, status: "running" };
    this.state.spans.push(span); this.state.stack.push(span); this.emit({ ...span });
    try { const result = await work(); span.status = "completed"; return result; }
    catch (error) { span.status = "error"; throw error; }
    finally {
      span.durationMs = this.now() - this.started - span.startMs;
      const children = this.state.spans.filter(child => child.parentId === span.id);
      span.selfMs = Math.max(0, span.durationMs - children.reduce((total, child) => total + (child.durationMs ?? 0), 0));
      this.state.stack.pop(); this.emit({ ...span });
    }
  };

  snapshot() {
    const durationMs = this.now() - this.started;
    const spans = this.state.spans.map(span => ({ ...span }));
    return { spans, durationMs, unmeasuredMs: Math.max(0, durationMs - spans.reduce((total, span) => total + (span.selfMs ?? 0), 0)) };
  }
}
