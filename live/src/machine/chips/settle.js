// A run of one chip's writes (`{ port, addr, data }`, in time order) as the
// few that leave the chip as the run left it: a seek's burst
// (IRPlayer.seek) is the chip's state at the point, not every write up to
// it — a minute of a song is tens of thousands of writes, a chip's state a
// few dozen to a few hundred.
//
// A register's last write, in the order those last writes came — a subset
// of the run in its own order, so a latch pair (OPN's $A4 then $A0) keeps
// its order. A chip says where that is not its state (its `seek`):
//   drop(port, addr, data)  a write that triggers rather than sets (a
//                           rhythm key, a sample's start) — the seek keys
//                           nothing on;
//   key()                   a factory for the register a write is, where its
//                           address does not say (a table written through
//                           one port, a register split by a bit); called on
//                           every write in order;
//   prelude                 writes that open its memory before the rest (a
//                           wave memory written only while the channel is
//                           off) — each sent only where the run wrote that
//                           register, whose last write then sets it back;
// and a chip whose writes are a stream has a `settle` of its own (the
// SN76489's latch bytes, the PC Engine's wave port).
// Returns [port, addr, data] writes.
export function settleWrites(writes, chip) {
  if (chip?.settle) return chip.settle(writes);
  const seek = chip?.seek ?? {};
  const keyOf = seek.key?.() ?? ((w) => w.port * 256 + w.addr);
  const last = new Map();
  writes.forEach((w, i) => {
    const key = keyOf(w);
    if (!seek.drop?.(w.port, w.addr, w.data)) last.set(key, i);
  });
  const kept = [...last.values()].sort((a, b) => a - b);
  const state = kept.map((i) => [writes[i].port, writes[i].addr, writes[i].data]);
  const opens = (seek.prelude ?? []).filter(([port, addr]) => state.some((w) => w[0] === port && w[1] === addr));
  return [...opens, ...state];
}
