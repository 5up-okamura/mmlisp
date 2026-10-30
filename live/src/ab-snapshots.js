// Two working copies. Values can contain immutable EditorStates so each side
// keeps its own undo history; this module knows nothing about the editor/audio.
export class ABSnapshots {
  constructor() { this.reset(); }

  reset() {
    this.active = 'A';
    this.slots = { A: null, B: null };
  }

  switchTo(side, current) {
    if (side !== 'A' && side !== 'B') throw new Error('Unknown A/B side');
    if (side === this.active) return null;
    this.slots[this.active] = current;
    // EditorState is immutable: the first B starts from A, then diverges as
    // the editor produces new states. No capture or naming step is needed.
    const next = this.slots[side] ?? current;
    this.slots[side] = next;
    this.active = side;
    return next;
  }

  copyToOther(current) {
    const other = this.active === 'A' ? 'B' : 'A';
    this.slots[this.active] = current;
    this.slots[other] = current;
    return other;
  }
}
