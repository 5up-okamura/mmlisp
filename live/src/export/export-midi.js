// File > Export > MIDI…: the score's MIDI plan (midi/midi-plan.js, which
// says what of a score MIDI can carry and how) written out as a Standard
// MIDI File — format 1, the IR's 96 ticks a quarter.

import { vlq, meta, midiPlan, PPQN } from "../midi/midi-plan.js";

function encodeTrack(events) {
  const sorted = events
    .map((e, i) => ({ ...e, tick: Math.max(0, Math.round(e.tick)), i: e.seq ?? i }))
    .sort((a, b) => a.tick - b.tick || a.order - b.order || a.i - b.i);
  const body = [];
  let at = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - at), ...e.bytes);
    at = e.tick;
  }
  body.push(0, ...meta(0x2f, []));
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}

/**
 * The score as a Standard MIDI File.
 *
 * @param {object} ir  compileMMLisp's IR, compiled with `voiceStamps: true`
 *                     for the voices' program changes and `voiceHoist: false`:
 *                     the hoist is the driver's wire (voice-hoist.js), and
 *                     cuts a note short for the voice change after it
 * @returns {{ bytes: Uint8Array, notes: string[],
 *             tracks: Array<{ name, channel, port, drums, notes: Array<{on, off, key, velocity}> }> }}
 *          `notes`: what the file could not say, one line each
 */
export function exportMidi(ir) {
  const plan = midiPlan(ir);
  const chunks = [encodeTrack(plan.conductor), ...plan.tracks.map((t) => encodeTrack(t.events))];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, 0, PPQN];
  const bytes = new Uint8Array(header.length + chunks.reduce((m, c) => m + c.length, 0));
  bytes.set(header, 0);
  let p = header.length;
  for (const c of chunks) { bytes.set(c, p); p += c.length; }
  return {
    bytes, notes: plan.notes,
    tracks: plan.tracks.map(({ name, channel, port, drums, notes }) => ({ name, channel: channel + 1, port, drums, notes })),
  };
}
