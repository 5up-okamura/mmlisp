# Basic waveforms (YM2612)

Sustained FM approximations of the classic oscillator shapes, plus two
303-inspired bass voices built on the same saw and square. One channel of
ordinary FM per voice; no CSM, PCM or effects. Original definitions, CC0.

```
wave-sine             one operator, a plain sine — sub bass and soft pads
wave-triangle         1st, 3rd, 5th and 7th harmonics added at roughly 1/n²
wave-saw              feedback saw, a modulator at 1x in series — bass and leads
wave-square           modulator at 2x — hollow, odd harmonics
wave-pulse-25         ALG 5, a 4x modulator over 1x/2x/3x carriers — thin, nasal
wave-pulse-12-approx  the first four harmonics of a 12.5% pulse
acid-saw              the saw with a decaying modulator: bright attack, fast decay
acid-square           the same articulation on the square
```

These match harmonic amplitudes, not waveforms. There is no duty-cycle control
and no PWM; the sharp top end of a 12.5% pulse is out of reach with four
operators; the triangle cannot match the NES's 32-step shape because operator
phase is not free; and the saw is not VRC6's stepped accumulator. NES noise
(LFSR) and DPCM are not here — use the PSG's `noise` channel and PCM.

The envelopes are instant-attack, sustain, short-release, so note length alone
shapes a phrase. Carriers are OP4 on the saw and square, OP1-4 on the triangle
and OP2-4 on the pulses; set the decay there to shape a voice
(`wave-saw :dr4 10 :sl4 5 :sr4 2 :rr4 10`). Changing a modulator's TL moves the
harmonic balance, which is not an analogue low-pass sweep.

For the acid voices a slide is a legato `~` plus `(glide 32)` — the pitch moves
without a key-on, so the FM envelope does not retrigger — and an accent is a
higher `:vel` with a shorter modulator decay. At 130 BPM a 16th step is about
115 ms and the slide about 58 ms, and slides scale with tempo, unlike a real
303. [demo-acid.mmlisp](demo-acid.mmlisp) plays a 16-step pattern twice on
each voice, with a slider for the modulator attenuation.

The square, saw and 25% pulse structures follow
[Plutiedev's chiptune sounds](https://www.plutiedev.com/chiptune-sounds);
the targets are NESdev's [pulse](https://www.nesdev.org/wiki/APU_Pulse),
[triangle](https://www.nesdev.org/wiki/APU_Triangle) and
[VRC6](https://www.nesdev.org/wiki/VRC6_audio) descriptions.
