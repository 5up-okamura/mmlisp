// The FM voice search's stages, off the page's thread (voice-estimate.js):
// the page keeps a few of these and hands each an algorithm, so the eight
// algorithms of stage 1 and the candidates of stage 2 run side by side.
//
//   in:  { id, op: 'prepare' | 'search' | 'refine', args }   (args as the stage takes them)
//   out: { id, result } or { id, error }

import { prepareVoiceTarget, searchAlgorithm, refineAlgorithm } from './voice-estimate.js';

self.onmessage = (e) => {
  const { id, op, args } = e.data;
  try {
    const result = op === 'prepare' ? prepareVoiceTarget(args.data, args.sampleRate)
      : op === 'search' ? searchAlgorithm(args) : refineAlgorithm(args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
