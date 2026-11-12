// TIME's bar length, off the page's thread: the measure plays the whole song
// through (IRPlayer.captureRegisterLog, as the VGM export bounds it), which
// on a long score stalls Play and a build for a second on a slow machine.
//
//   in:  { id, ir }
//   out: { id, loopStartSec, endSec } or { id, error }

import { IRPlayer } from './ir-player.js';

self.onmessage = (e) => {
  const { id, ir } = e.data;
  try {
    const p = new IRPlayer(() => {});
    p.loadJSON(ir);
    const { loopStartSec, endSec } = p.captureRegisterLog();
    self.postMessage({ id, loopStartSec, endSec });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
