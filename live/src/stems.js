// ---------------------------------------------------------------------------
// The mixer's strips, and the score's stems (File > Export > Stems…)
//
// A strip is what Live's mixer mutes, solos and fades: a channel the score
// plays, in its machine's channel order (targets/) — or, where the chip's
// own sample voices are the mixer's (the YM2608's and the OPLL's ROM rhythm,
// one strip a sound the score plays, whichever track hits it; a part's
// `mixVoice`: the ADPCM-B, PCM8's voices, the DMC), that voice. fm3-csm-rate
// (Timer A) has no strip: it folds into fm3-csm's. `mixerStrips` is the
// mixer's model without its look (index.html buildChStripModel adds it).
//
// A stem is a strip soloed and rendered as the WAV export renders the score
// (export-wav.js): every stem starts at 0, so the files line up in a DAW, a
// looping score's all one length (its loop twice and the WAV's fade), a
// one-shot's each to its own last sound. A chip sounds with nothing keyed — the YM2612's DAC
// stands off zero, every channel's share — so the score rendered with every
// strip off is taken from each stem: a stem is its strip's own sound, and
// the stems summed with that floor are the WAV, but where the mix clips.
// ---------------------------------------------------------------------------

import { targetProfile } from "./targets.js";
import { renderWavSamples, encodeWav } from "./export-wav.js";

/**
 * The mixer's strips for `ir`: { head, trackIndex, voice?, rhythm? }, a
 * rhythm sound's with `rhythm: { sound, role, k, head, rhythmTracks,
 * samples }` (k its place in the part's kit, head the part's first channel).
 */
export function mixerStrips(ir) {
  const tracks = ir?.tracks ?? [];
  const target = targetProfile(ir?.metadata?.target);
  const order = target.channelNames.filter((h) => h !== "fm3-csm-rate");
  const headToTrack = new Map();
  tracks.forEach((t, ti) => {
    const head = t.scoreChannel ?? t.channel;
    if (head != null && !headToTrack.has(head)) headToTrack.set(head, ti);
  });
  // The ROM rhythm (a part with a kit: the YM2608's, the OPLL's).
  const kitPart = target.parts.find((p) => p.kit);
  const rhythmHeads = new Set(kitPart ? target.headsOf(kitPart.name) : []);
  const soundOf = new Map((ir?.metadata?.samples ?? []).filter((d) => d.rhythm).map((d) => [d.name, d.rhythm]));
  const sounds = new Set();
  const rhythmTracks = [];
  tracks.forEach((t, ti) => {
    if (!rhythmHeads.has(t.scoreChannel ?? t.channel)) return;
    rhythmTracks.push(ti);
    for (const e of t.events ?? []) if (e.cmd === "PCM_NOTE_ON" && soundOf.has(e.args?.sample)) sounds.add(soundOf.get(e.args.sample));
  });
  const strips = [];
  let rhythmDone = false;
  for (const head of order) {
    if (!headToTrack.has(head)) continue;
    if (rhythmHeads.has(head)) {
      if (rhythmDone) continue;
      rhythmDone = true;
      // The part's sounds in its order; each its hits from every rhythm track.
      Object.entries(target.partOf(head).kit).forEach(([role, sound], k) => {
        if (!sounds.has(sound)) return;
        const samples = new Set([...soundOf].filter(([, r]) => r === sound).map(([n]) => n));
        strips.push({ head: `rhythm-${sound}`, trackIndex: rhythmTracks[0], voice: sound, rhythm: { sound, role, k, head, rhythmTracks, samples } });
      });
      continue;
    }
    const strip = { head, trackIndex: headToTrack.get(head) };
    // A chip's own sample voice is the IR player's voice to mute or fade.
    const c = target.channels[head];
    if (c?.part.mixVoice) strip.voice = c.part.mixVoice(c.voice);
    strips.push(strip);
  }
  return strips;
}

/** A strip soloed (or not) on `player`, as the mixer's S does: by voice, else by track. */
export function soloStrip(player, strip, on = true) {
  if (strip.voice) player.soloVoice(strip.voice, on);
  else if (strip.trackIndex != null) player.soloTrack(strip.trackIndex, on);
}

/** A strip muted (or not) on `player`, as the mixer's M does. */
export function muteStrip(player, strip, on = true) {
  if (strip.voice) player.muteVoice(strip.voice, on);
  else if (strip.trackIndex != null) player.muteTrack(strip.trackIndex, on);
}

/**
 * The score's stems: each strip the song plays (a def-se's alone are not),
 * soloed and rendered, handed to `onStem` one at a time as it is made, so a
 * caller writes it away (a ZIP) and holds no more than one.
 *
 * @param {object} ir
 * @param {() => IRPlayer} makePlayer  a fresh player with `ir` loaded
 * @param {object} [opts]  renderWav's (pcm, rhythmRom, lpfOn …); onProgress
 *                         follows the whole set, 0..1
 * @param {(stem: { index, head, bytes }) => Promise|void} onStem
 * @returns {Promise<{ count, durationSec, pcmCount }>}  durationSec the longest
 */
export async function renderStems(ir, makePlayer, opts, onStem) {
  const strips = mixerStrips(ir).filter((s) => !ir.tracks[s.trackIndex]?.se);
  const renders = strips.length + 1;
  let done = 0;
  const render = (solo) => {
    const player = makePlayer();
    solo(player);
    const k = done++;
    return renderWavSamples(player, {
      ...opts,
      onProgress: opts.onProgress && ((f) => opts.onProgress(Math.min(1, (k + f) / renders))),
    });
  };
  // The floor: every strip off (a solo of no track). The Mega Drive's DAC
  // at rest (0x80) is channel 6 at rest, so a DAC stem's floor is the same.
  const floor = await render((p) => p.soloTrack(-1, true));
  let pcmCount = 0, longest = 0;
  for (const [index, strip] of strips.entries()) {
    const r = await render((p) => soloStrip(p, strip));
    pcmCount = Math.max(pcmCount, r.pcmCount);
    for (const [x, f] of [[r.L, floor.L], [r.R, floor.R]])
      for (let k = 0, last = f.length - 1; k < x.length; k++) x[k] -= f[Math.min(k, last)] ?? 0;
    longest = Math.max(longest, r.durationSec);
    await onStem({ index, head: strip.head, bytes: encodeWav(r.L, r.R, r.sampleRate) });
  }
  return { count: strips.length, durationSec: longest, pcmCount };
}
/** A stem's file name in the set: its place, then its strip (`03-sqr1.wav`). */
export const stemName = (i, head) => `${String(i + 1).padStart(2, "0")}-${head}.wav`;
