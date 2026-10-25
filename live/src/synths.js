// The synth cores (synth-*.js; their contract is synth-md.js's header), by
// target name: the worklet plays a score's writes on its target's, and the
// WAV export renders through the same one. A machine's synth is registered
// here, once.
import { MegaDriveSynth, SCOPE_CHANNELS } from "./synth-md.js";
import { Pc88Synth, SCOPE_LANES as PC88_SCOPE_LANES } from "./synth-pc88.js";
import { X68kSynth, SCOPE_LANES as X68K_SCOPE_LANES } from "./synth-x68k.js";
import { MsxSynth, SCOPE_LANES as MSX_SCOPE_LANES } from "./synth-msx.js";

export const SYNTHS = { md: MegaDriveSynth, pc88: Pc88Synth, x68k: X68kSynth, msx: MsxSynth };

/** The synth for `name` (a target's), the Mega Drive's for any other. */
export const synthFor = (name) => SYNTHS[name] ?? MegaDriveSynth;

// The most scope lanes a synth posts.
export const SCOPE_MAX = Math.max(SCOPE_CHANNELS, PC88_SCOPE_LANES, X68K_SCOPE_LANES, MSX_SCOPE_LANES);
