// MIDI input for the live app: a keyboard plays the preview (and step input),
// a knob moves a panel slider it was assigned to. This file is the Web MIDI
// end — device access and message decoding, and the two value mappings; what
// a note or a CC does is the page's (index.html).
//
// Web MIDI exists in Chromium and Firefox only: Safari (and so every iOS
// browser) has none, and `supported` is false there — the page then shows no
// MIDI menu and nothing else changes.

export const midiSupported = typeof navigator !== 'undefined'
  && typeof navigator.requestMIDIAccess === 'function';

// handlers: { noteOn(note, vel127, ch), noteOff(note, ch), cc(num, value, ch),
// devices(names) } — any may be omitted. ch is 0..15.
export function createMidiInput(handlers) {
  let access = null;
  let enabled = false;

  const onMessage = (e) => {
    const [status, d1, d2] = e.data;
    const type = status & 0xf0;
    const ch = status & 0x0f;
    if (type === 0x90 && d2 > 0) handlers.noteOn?.(d1, d2, ch);
    else if (type === 0x80 || type === 0x90) handlers.noteOff?.(d1, ch);
    else if (type === 0xb0) handlers.cc?.(d1, d2, ch);
  };

  // Every input listens: one keyboard and one knob box are the usual setup,
  // and a device plugged in later joins without a trip to a menu.
  const attach = () => {
    if (!access) return;
    const names = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = enabled ? onMessage : null;
      if (input.state === 'connected') names.push(input.name || 'MIDI input');
    }
    handlers.devices?.(enabled ? names : []);
  };

  return {
    get enabled() { return enabled; },
    // Resolves true once the browser granted access (it asks the first time).
    async enable() {
      if (!midiSupported) return false;
      if (!access) {
        access = await navigator.requestMIDIAccess({ sysex: false });
        access.onstatechange = attach;
      }
      enabled = true;
      attach();
      return true;
    },
    disable() {
      enabled = false;
      attach();
    },
  };
}

// MIDI velocity 1..127 → MMLisp :vel 0..15 (127 → 15, the patch's own level).
export function midiVelToVel(v) {
  return Math.max(0, Math.min(15, Math.round((v * 15) / 127)));
}

// A CC value 0..127 across a slider's travel, snapped to its step. `reversed`
// is a slider drawn right-to-left (a def-val written high..low): the knob
// follows what is drawn, so 0 is its left end there too.
export function ccToSliderValue(value, min, max, step = 1, reversed = false) {
  const frac = (reversed ? 127 - value : value) / 127;
  const s = step > 0 ? step : 1;
  const v = min + Math.round((frac * (max - min)) / s) * s;
  return Math.max(Math.min(min, max), Math.min(Math.max(min, max), v));
}
