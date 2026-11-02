// ---------------------------------------------------------------------------
// The sample editor: a def-pcm's wave on a canvas, its range and its loop as
// four handles dragged along it. The upper half takes the loop's two, the
// lower the range's, so they can share a place; a part with no loop gives the
// range's the height. What a handle may reach and
// what it writes are the subject's (edit-tools.js moveSamplePoint); the editor
// only draws and reports the time under the pointer. The wave fills the height,
// scaled to its peak (`.peak`), for its shape: the level is a number beside it.
//
//   new PcmEditor(canvas, { onDrag(handle, ms, done), onHover(text) })
//   .show(subject)   { key, data, dur, points, loop, writable } (null: nothing)
//   .points          where the four are: { start, end, loopStart, loopEnd }, ms
//   .peak            the wave's peak, 0..1 and more (`:fx` may pass full scale)
//
// onDrag runs on every move of a drag (done false), once at its end (done
// true), and says the points to draw by setting .points. onHover has what the
// pointer is on, "" off the canvas. Colors are the page's tokens: the range's
// wave in --foreground and the rest in --mid, the loop a --hover fill, the
// handles in --high and their names in --sub.
// ---------------------------------------------------------------------------

const REACH = 6; // px either side of a handle
const NAMES = { start: "pcm-start", end: "pcm-end", loopStart: "loop-start", loopEnd: "loop-end" };

export class PcmEditor {
  constructor(canvas, { onDrag = () => {}, onHover = () => {} } = {}) {
    this.canvas = canvas;
    this.onDrag = onDrag;
    this.onHover = onHover;
    this.subject = null;
    this.points = null;
    this.dragging = null; // the handle in hand
    this._moved = false;
    this._peaks = null; // { data, width, lo, hi }
    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    canvas.addEventListener("pointerup", (e) => this._up(e));
    canvas.addEventListener("pointercancel", (e) => this._up(e));
    canvas.addEventListener("pointerleave", () => { if (!this.dragging) this.onHover(""); });
  }

  show(subject) {
    this.subject = subject;
    this.points = subject?.points ?? null;
    this.draw();
  }

  get peak() {
    const data = this.subject?.data;
    if (!data) return 0;
    if (this._peak?.data !== data) {
      let top = 0;
      for (let i = 0; i < data.length; i++) top = Math.max(top, Math.abs(data[i]));
      this._peak = { data, top };
    }
    return this._peak.top;
  }

  get _ready() {
    return !!this.subject?.data && this.subject.dur > 0;
  }

  _x(e) {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  _ms(e) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.subject.dur;
  }

  // The handle at a pointer event, or null: the nearest of its half's.
  _handleAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const loopHalf = this.subject.loop && e.clientY - r.top < r.height / 2;
    const px = r.width / this.subject.dur;
    const x = this._x(e);
    let best = null, reach = REACH;
    for (const h of loopHalf ? ["loopStart", "loopEnd"] : ["start", "end"]) {
      const d = Math.abs(this.points[h] * px - x);
      if (d <= reach) { best = h; reach = d; }
    }
    return best;
  }

  _down(e) {
    if (!this.subject?.writable || !this._ready || e.button !== 0) return;
    const handle = this._handleAt(e);
    if (!handle) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = handle;
    this._moved = false;
  }

  _move(e) {
    if (!this._ready) return;
    if (this.dragging) {
      this._moved = true;
      this.onDrag(this.dragging, this._ms(e), false);
      this.onHover(`${NAMES[this.dragging]} ${Math.round(this.points[this.dragging])}ms`);
      this.draw();
      return;
    }
    const handle = this.subject.writable ? this._handleAt(e) : null;
    this.canvas.style.cursor = handle ? "ew-resize" : "";
    this.onHover(handle ? `${NAMES[handle]} ${Math.round(this.points[handle])}ms` : `${Math.round(this._ms(e))}ms`);
  }

  _up(e) {
    const handle = this.dragging;
    if (!handle) return;
    this.dragging = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this._moved) this.onDrag(handle, this._ms(e), true);
    this.draw();
  }

  // One [lo, hi] a column, for a wave far longer than the canvas is wide.
  _peaksFor(width) {
    const { data } = this.subject;
    if (this._peaks?.data === data && this._peaks.width === width) return this._peaks;
    const lo = new Float32Array(width), hi = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const from = Math.floor((x * data.length) / width);
      const to = Math.max(from + 1, Math.floor(((x + 1) * data.length) / width));
      let a = Infinity, b = -Infinity;
      for (let i = from; i < to && i < data.length; i++) {
        if (data[i] < a) a = data[i];
        if (data[i] > b) b = data[i];
      }
      lo[x] = a === Infinity ? 0 : a;
      hi[x] = b === -Infinity ? 0 : b;
    }
    return (this._peaks = { data, width, lo, hi });
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
    if (!this._ready) return;
    const s = this.subject, p = this.points;
    const cs = getComputedStyle(c);
    const token = (name) => cs.getPropertyValue(name).trim();
    const X = (ms) => Math.round((ms / s.dur) * W);
    if (s.loop) {
      ctx.globalAlpha = parseFloat(token("--hover")) / 100 || 0.18;
      ctx.fillStyle = token("--foreground");
      ctx.fillRect(X(p.loopStart), 0, X(p.loopEnd) - X(p.loopStart), H);
      ctx.globalAlpha = 1;
    }
    const { lo, hi } = this._peaksFor(W);
    const scale = this.peak > 0 ? 1 / this.peak : 1; // silence stays a line
    const y = (v) => ((1 - v * scale) * H) / 2;
    const inside = token("--foreground"), outside = token("--mid");
    const from = X(p.start), to = X(p.end);
    for (let x = 0; x < W; x++) {
      ctx.fillStyle = x >= from && x < to ? inside : outside;
      // Reaching to the column before: a steep wave's columns need not overlap.
      const top = y(x ? Math.max(hi[x], lo[x - 1]) : hi[x]);
      const bottom = y(x ? Math.min(lo[x], hi[x - 1]) : lo[x]);
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.font = `${cs.fontSize} ${cs.fontFamily || "monospace"}`;
    const handle = (h, top, left) => {
      const x = Math.min(W - 1, X(p[h])) + 0.5;
      // With no loop to share with, the range's take the height.
      const y0 = top || !s.loop ? 0 : H / 2, y1 = top ? H / 2 : H;
      ctx.strokeStyle = token("--high");
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.fillStyle = token("--high");
      const tip = top ? 0 : H;
      const toward = left ? -5 : 5;
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x + toward, tip);
      ctx.lineTo(x, tip + (top ? 5 : -5));
      ctx.fill();
      if (this.dragging !== h) return;
      ctx.fillStyle = token("--sub");
      ctx.textBaseline = top ? "top" : "bottom";
      ctx.textAlign = left ? "right" : "left";
      ctx.fillText(NAMES[h], x + (left ? -7 : 7), top ? 1 : H - 1);
      ctx.textAlign = "left";
    };
    if (s.loop) {
      handle("loopStart", true, false);
      handle("loopEnd", true, true);
    }
    handle("start", false, false);
    handle("end", false, true);
  }
}
