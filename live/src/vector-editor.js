// ---------------------------------------------------------------------------
// The vector editor: a step vector drawn as bars on a canvas, redrawn with
// the pointer as Max's and Pd's arrays are — press, drag across, and every
// step the pointer passes takes the value under it. The subject (edit-tools.js
// vectorAt) gives the length, the range and the marks; the editor only draws
// inside the range, rounded to the subject's grain (`quantum`: whole steps,
// or a `*` macro's hundredths), so what it hands back is what the score can
// hold. With Alt (Option) held, a macro's steps the stroke passes become
// holds (`_`); a wave has none.
//
//   new VectorEditor(canvas, { onDraw(values, done), onHover(step, value) })
//   .show(subject)   draw a subject (null: nothing)
//   .values          the steps drawn, one per step (null: a hold)
//
// onDraw runs on every move of a stroke (done false) and once at its end
// (done true); onHover with the step under the pointer, or null off it.
// Colors are the page's tokens: values in --foreground, the zero line and the
// marks in --mid, the marks' names in --sub.
// ---------------------------------------------------------------------------

export class VectorEditor {
  constructor(canvas, { onDraw = () => {}, onHover = () => {} } = {}) {
    this.canvas = canvas;
    this.onDraw = onDraw;
    this.onHover = onHover;
    this.subject = null;
    this.values = [];
    this._last = null; // the stroke's previous [step, value]
    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    canvas.addEventListener("pointerup", (e) => this._up(e));
    canvas.addEventListener("pointercancel", (e) => this._up(e));
    canvas.addEventListener("pointerleave", () => { if (!this._last) this.onHover(null, null); });
  }

  show(subject) {
    this.subject = subject;
    this.values = subject ? [...subject.values] : [];
    this.draw();
  }

  get editable() {
    return !!this.subject?.writable;
  }

  // The step and value at a pointer event, the value rounded and kept in range.
  _at(e) {
    const r = this.canvas.getBoundingClientRect();
    const { min, max } = this.subject;
    const n = this.values.length;
    const step = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
    const y = 1 - (e.clientY - r.top) / r.height;
    if (e.altKey && this.subject.kind === "macro") return [step, null];
    const q = this.subject.quantum ?? 1;
    const value = Math.max(min, Math.min(max, Math.round((min + y * (max - min)) / q) * q));
    return [step, q < 1 ? Number(value.toFixed(6)) : value];
  }

  _down(e) {
    if (!this.editable || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this._last = null;
    this._paint(this._at(e));
  }

  _move(e) {
    if (!this.subject) return;
    const at = this._at(e);
    this.onHover(at[0], this.values[at[0]]);
    if (this._last) this._paint(at);
  }

  _up(e) {
    if (!this._last) return;
    this._last = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.onDraw([...this.values], true);
  }

  // Every step from the stroke's last point to this one, on the line between.
  _paint([step, value]) {
    const [s0, v0] = this._last ?? [step, value];
    const lo = Math.min(s0, step), hi = Math.max(s0, step);
    let changed = false;
    for (let s = lo; s <= hi; s++) {
      if (value == null) { // a hold stroke
        if (this.values[s] !== null) { this.values[s] = null; changed = true; }
        continue;
      }
      const q = this.subject.quantum ?? 1;
      const from = v0 ?? value; // after a hold stroke's point, from here
      const lerp = hi === lo ? value : from + ((value - from) * (s - s0)) / (step - s0);
      const v = q < 1 ? Number((Math.round(lerp / q) * q).toFixed(6)) : Math.round(lerp);
      if (this.values[s] !== v) { this.values[s] = v; changed = true; }
    }
    this._last = [step, value];
    if (changed) {
      this.draw();
      this.onDraw([...this.values], false);
    }
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (W < 2 || H < 2) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = this.subject;
    if (!s) return;
    const cs = getComputedStyle(c);
    const fg = cs.getPropertyValue("--foreground").trim() || "#7df";
    const mid = cs.getPropertyValue("--mid").trim() || "#678";
    const sub = cs.getPropertyValue("--sub").trim() || "#9bc";
    const n = this.values.length;
    const y = (v) => H - ((v - s.min) / (s.max - s.min || 1)) * H;
    // Bars stand on zero where the range has it, else on its floor.
    const base = y(s.min <= 0 && 0 <= s.max ? 0 : s.min);
    ctx.strokeStyle = mid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(base) + 0.5);
    ctx.lineTo(W, Math.round(base) + 0.5);
    ctx.stroke();
    const w = W / n;
    ctx.fillStyle = fg;
    this.values.forEach((v, i) => {
      if (v == null) return; // a hold writes nothing
      const top = y(v);
      ctx.fillRect(i * w + (w > 4 ? 1 : 0), Math.min(top, base), Math.max(1, w - (w > 4 ? 2 : 0)), Math.max(1, Math.abs(base - top)));
    });
    ctx.font = `10px ${cs.fontFamily || "monospace"}`;
    ctx.textBaseline = "top";
    for (const m of s.marks) {
      const x = Math.round(m.at * w) + 0.5;
      ctx.strokeStyle = mid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = sub;
      ctx.fillText(m.label, x + 2, 1);
    }
  }
}
