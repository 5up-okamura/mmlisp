# Multi-bank PCM — development record and remaining work

Work in progress on `feat/pcm-multibank`, 2026-10-07. The user requested
undoing commit `28062a0`, translating Markdown to English, and moving development
records out of user documentation. After those changes and the PAL/three-voice
feasibility review, the user explicitly requested committing the current work.
The user authorized continued work through PAL 1–2, NTSC 3, and PAL 3, with a commit after each milestone. Source comments and documentation are English.

The current user-facing behavior belongs in [Multi-bank PCM](../../docs/pcm-multibank.md),
[MMB](../../docs/mmb.md), and [the driver specification](../../docs/driver.md).
The sections below are historical snapshots of the investigation and experimental
builds, not a second specification of the current implementation. Some builds
were superseded; references to missing integration describe their own stage.

## User decisions and remaining work

- Prioritize total capacity above 32 KiB within one song and simultaneous
  samples from different banks. Keep pitch prebaked; runtime pitch was not
  selected for this implementation.
- The user accepted the residual timing of the two-voice precomputed prototype,
  while noting that the passage near seven seconds still sounded slightly slow.
- Keep developer research, listening logs, individual-song benchmarks, and
  implementation history here. `docs/` is for composers and driver users.
- Markdown must be in English. The conversation with the user remains Japanese.
- Normal C/SGDK integration passes waveform, command-intent, and FM/PSG checks,
  but its timing is worse than the precomputed prototype. Further host timing
  work is open; do not claim the user's listening acceptance applies to the
  integrated build without a new listening test.
- Multi-bank three-voice/PAL support, cross-bank single-sample streaming, real
  hardware, and heavy DMA/game workload testing remain open.

## Integration measurements and artifacts

The normal-driver two-voice test is
`drv/out/sin008/rom-integrated-two-release/`: 45 seconds, 445,802 matching DAC
values, 398 checked PCM starts, 2,430 matching FM writes, and 2,899 PSG writes.
FM interval error was 24.83 ms at the 95th percentile and 36.84 ms maximum;
bus-stop rate loss was about 0.718%. A minimal-app trial did not improve the
maximum, so do not attribute the timing problem solely to the example's UI.

The latest one-voice test is `drv/out/sin008/rom-integrated-one-release/`:
30 seconds, 295,100 matching DAC values, 138 PCM starts, and matching FM/PSG
streams. Its FM interval error was 18.37 ms at the 95th percentile and
33.94 ms maximum. The user's source and sample WAV were not modified.

A normal-driver fixture exceeding 32 KiB passed in
`drv/out/banked-sgdk-ready/`. The complete SMP was 98,304 bytes; 73,905 DAC
values matched in that run. Earlier runs reported 73,907 values. These are
run-specific measurements, not fixed acceptance counts.

Validation completed: `verify:all`, `banked:gate`, `multibank:gate`, generated
image mirrors, SGDK type checking, normal-driver BlastEm tests, and a VGM
PCM export check. The new A/B baseline entry was reviewed; no existing score's
baseline changed. A later documentation-only pass translated the Markdown.
The test recordings are generated, ignored artifacts, not repository resources.

Reproduction from `drv`:

```sh
npm run banked:gate
npm run multibank:gate
npm run mirrors
npm run verify:all
npm run banked:sgdk -- tests/multibank.mmlisp --seconds 8
node tools/banked-sgdk-gate.mjs out/sin008/two-voice-stress.mmlisp --seconds 45 --out out/sin008/rom-integrated-two-release
```

## Original capacity and runtime-pitch investigation

Study date: 2026-10-06. This design study reviewed the existing code and reran the instruction-placement calculations. It did not implement a new engine or measure real hardware.

Subsequent work produced a two-voice multi-bank prototype on a separate branch. The prototype history below records playback of more than 32 KiB at the existing rate and the integration work that remained at that stage.

## Findings

Improvement is possible. The 32 KiB limit is not a hardware limit on total PCM storage; it comes from keeping the Z80 ROM window mapped to one bank. Removing the exporter check alone would not produce correct playback.

To prioritize existing sound quality, output timing, and FM/PSG throughput, retain note-specific prebaking and expand capacity first.

1. Separate banks by song, or by sections where all PCM voices stop. This can help suitable songs with relatively small changes.
2. If samples from arbitrary different banks must play simultaneously, prototype per-voice read-ahead buffers in Z80 RAM.
3. Investigate arbitrary runtime pitch as a separate optional profile. Begin with one voice, no interpolation, and a limited pitch range; measure its cost before considering a small set of anchor samples.

Arbitrary pitch on every voice while preserving the same sound quality, sample rate, and all existing features cannot yet be guaranteed.

## Existing implementation and constraints

- `live/src/export-mmb.js:createSampleBankBuilder` resamples each used note with linear interpolation and produces signed 8-bit PCM. It already excludes unused sample data and shares identical blobs.
- Legacy `.smp` files contain exactly 32,768 bytes. The top 256 bytes provide silence for parked voices, leaving 32,512 bytes for the table and PCM. The table occupies 4 bytes plus 24 bytes per entry, and each blob is rounded up to 16 bytes. A separate limit allows at most 256 entries, including note-specific entries rather than only instrument definitions.
- Playback advances one byte per output sample. The production settings in `drv/tools/build-engine.mjs` are `loops: true, stepVoices: 0`. Integer-step support remaining in the generator is not an arbitrary-pitch feature available in the current production engine.
- `drv/sgdk/mmlispdrv.c:writeBankRegister` selects the shared ROM window with nine writes. The legacy Z80 mixer never changes banks. Changing the window for one voice also changes the data visible to every other voice.
- The legacy PCM_START in `live/src/slot-builder.js` contains voice, shift, src, end, and wrap. It has no per-voice bank number or pitch increment.
- The browser worklet, VGM exporter, JavaScript reference model, C sequencer, and bundle builder also assumed a single bank.

Rerunning `node drv/tools/light-study.mjs` produced:

| PCM voices | Nominal output rate | Z80 period | Peak scheduled workload | Mean workload |
| --- | ---: | ---: | ---: | ---: |
| 1 | 14,375.7 Hz | 249 cycles | 100% | 59.4% |
| 2 | 10,111.7 Hz | 354 cycles | 100% | 83.4% |
| 3 | 6,653.4 Hz | 538 cycles | 100% | 83.9% |

These are placement and assembly results from the existing generator, not measurements of real-hardware headroom. Average spare time does not mean that additional work on every sample fits into the busiest intervals. Reordering or splitting work may still allow the same output rate.

For example, a 0.5-second sample at its anchor pitch occupies about 7.2 KB in the one-voice engine. Baking 12 semitones upward from that pitch requires roughly 64 KB before tables and padding, because sample length decreases inversely with pitch ratio. It is not simply twelve times the original size, but even one source sample can exceed the limit.

## Alternatives

| Approach | Benefit | Performance and sound quality | Main conditions |
| --- | --- | --- | --- |
| Separate banks per song | Replaces a bundle-wide 32 KiB limit with a per-song limit | Normal playback work can remain unchanged | End old PCM and SE playback between songs; the per-song limit remains |
| Banks per song section | Allows more than 32 KiB across one song | Work within a section can remain unchanged | Requires safe switching points for all PCM; sustained sounds and SE crossing sections are constrained |
| Per-voice read-ahead buffers | Allows simultaneous samples from different banks and segmented reads of long samples | May keep output work light without changing sample quality | Requires redesigning Z80 RAM allocation and instruction placement throughout the schedule |
| Fixed-point runtime pitch | Greatly reduces pitch-specific copies and supports bends | Adds work to every sample; no interpolation changes the sound | Requires measurement of rates, voice counts, and supported pitch ranges |
| Integer steps or a few anchors | Reduces copies between octaves and selected pitch ranges | Easier to make lightweight than arbitrary pitch | Does not solve all semitone transpositions; decimation changes sound quality and loop behavior |
| DPCM or other compression | Reduces capacity use according to compression ratio | Adds decoding cost and quantization error | Pitch-specific copies remain, and access into loop bodies becomes more complex |

### Conditions for inexpensive bank switching

Manual section boundaries, or switching only when all voices stop, are the simplest starting point. If every overlapping sample combination fits into one bank, the existing mixer can remain. Chained overlaps can still exceed 32 KiB. SE behavior cannot be determined from static song analysis alone, so rules may be needed for duplicating resident samples across banks or forbidding switching during certain intervals.

Switching must account for old voice pointers, pending START commands, previously generated output, and RETARGET commands, not just zero volume. Calling the current API during arbitrary playback is not sufficient for safe in-song switching.

### General capacity expansion: per-voice read-ahead

Read blocks of each voice's sample into Z80 RAM, then produce output from RAM. Combining ROM-window switching with refill work avoids repeating all nine bank-latch writes for every voice on every output sample.

One candidate uses two 64- or 128-byte buffers per voice. Three voices would require 384 or 768 bytes for sample buffers alone. The complete 8 KiB allocation must be recalculated, including code, LUTs, output ring, FIFO, state, and stack; these buffer sizes are not a claim that the existing layout has enough space. At the fixed-pitch two-voice rate, 64 bytes cover about 6.3 ms. That is buffer duration, not a measured onset latency.

The estimate must include ROM reads, RAM stores, buffer switching, boundaries and loops, START/RETARGET during read-ahead, and simultaneous refill contention, in addition to the nine bank writes. No other voice can read the ROM window during a partial bank change, so spreading bank writes across free slots alone is insufficient. Faster RAM reads may not offset the added copy cost.

Place sample buffers in Z80 RAM. Do not assume the Z80 can read 68000 RAM directly, because earlier design documents recorded hardware-compatibility problems with that approach. Generating data on the 68000 and transferring it to the Z80 is another option, but adds 68000 work and BUSREQ stalls, so it is not the first candidate here.

### Runtime pitch

The basic approach adds an increment to a fixed-point read position and uses its integer part to address the sample. This lets one sample serve multiple pitches, but costs more than the current integer-pointer advancement.

The existing END/WRAP contract also assumes 16 output samples and a fixed step. Variable steps require definitions for end overshoot, carrying the remainder into a loop, fractional phase, continuity during pitch changes, and the silence range. Adding an arithmetic instruction alone is insufficient.

No interpolation is inexpensive but does not produce the same waveform as existing prebaked linear interpolation. Linear interpolation itself does not replace a suitable low-pass filter; high-pitch aliasing needs separate consideration. A compromise is to prebake a few pitch-range anchors and limit the runtime transposition around each. With both variable pitch and read-ahead, refill deadlines must use the highest supported consumption rate.

## Implementation order and acceptance criteria

1. Report actual capacity by source sample and pitch in the existing diagnostics, without counting shared blobs twice. Remove unused ranges only when it can be shown that dynamic range changes and release playback do not need them.
2. Introduce per-song bank separation, optionally followed by explicit in-song switching points. Treat this separately from the 32 KiB limit on the MMB itself.
3. Prototype read-ahead from different banks for two voices at 10,111.7 Hz. Keep fixed pitch and compare PCM values, DAC periods, FM/PSG write spacing, command throughput, and RAM usage with the legacy engine.
4. Test simultaneous refills, 32 KiB boundaries, short loops, release, immediate retriggers, SE interruptions, and BUSREQ/VDP DMA contention. Existing engine, score, PCM-loop, and SGDK gates also need a reference model that observes actual bank switching.
5. Once viable, extend to three voices and measure one-voice arbitrary pitch in a separate prototype. Retain legacy profiles and report any reduced performance as a property of the new optional profile.

This study reproduced only the existing layout. Determining achievable rates and implementation effort for a new approach requires a prototype containing the actual instruction sequences and boundary handling above.

## Sources

- Existing implementation: `live/src/export-mmb.js`, `live/src/pcm-model.js`, `live/src/slot-builder.js`, `drv/engine/gen-stream.mjs`, `drv/engine/config.mjs`, `drv/tools/build-engine.mjs`, and `drv/sgdk/mmlispdrv.c`.
- Existing specifications: [driver.md §5.4](../../docs/driver.md#54-sample-banking) and [mmb.md](../../docs/mmb.md). Earlier design caveats are in `dac-engine-implementation.md` §11.5. Performance figures from that older design are not used as current production figures.
- Primary comparison source: the [SGDK XGM specification](https://github.com/Stephane-D/SGDK/blob/master/bin/xgm.txt) describes PCM exceeding 32 KiB and multi-voice mixing. It demonstrates that 32 KiB is not an absolute hardware limit on total storage, but does not prove equivalent performance under MMLisp's volume, loop, CSM, and transfer requirements.

## Prototype and listening history

2026-10-06 / `codex/pcm-multibank`

## Results

**Two voices can play more than 32 KiB per song, including simultaneous samples from different ROM banks, at the existing 10,111.709 Hz rate.** Pitch remains prebaked per note. The Z80 code was generated and assembled, then checked with the instruction emulator and BlastEm running an SGDK-built ROM. These are not real-hardware measurements.

The prototype used a separate experimental path to establish feasibility before integration into the normal editor and SGDK C sequencer. The generated legacy one-, two-, and three-voice engine binaries were unchanged.

| Item | Legacy two-voice engine | Latest two-voice prototype |
| --- | ---: | ---: |
| Nominal rate | 10,111.709 Hz | 10,111.709 Hz |
| Z80 period per output sample | 354 cycles | 354 cycles |
| Command consumption | 8 pairs / 80 samples | 15 pairs / 80 samples |
| Scheduled mean workload | 83.4% | 91.7% |
| Peak interval workload | 100% | 100% |
| Code allocation | 2,790 B | 3,898 B / 4,352 B |
| Image including volume and saturation tables | 6,912 B | 6,912 B |
| Output generation lead | 18 samples | 32 samples |
| IDLE fence after generation publication | 1 pair | 2 pairs |
| Total sample capacity | Table and all PCM in one 32 KiB window | Multiple 32 KiB banks |

Test data included 44,016 bytes of synthetic samples and 37,344 bytes baked from an actual `.mmlisp` fixture. The latter occupied two banks, or 65,536 bytes of PCM ROM. The legacy exporter rejected this score for exceeding capacity, while the prototype played it.

An early final-fixture ROM test, including an FM melody, matched all 75,705 samples against the reference model in BlastEm. The running rate excluding bus stops was 10,111.709 Hz; including stops it was 10,096.560 Hz, a loss of about 0.150%. Results from subsequent runs are saved in `drv/out/multibank-rom/report.json`.

## Running the prototype

From the repository root:

```sh
node drv/tools/multibank-gate.mjs
node drv/tools/multibank-render.mjs drv/tests/multibank.mmlisp --seconds 6
node drv/tools/multibank-rom.mjs
```

Alternatively, run `npm run multibank:gate`, `multibank:render`, or `multibank:rom` from `drv`. Pass the score path to the renderer.

- `drv/out/multibank/pcm.wav`: PCM generated by the Z80 instruction emulator, without FM or PSG audio.
- `engine.z80`, `engine.bin`, `samples.rom`, and `manifest.json` in the same directory: generated code, samples, placement information, and measurements.
- `drv/out/multibank-rom/out/rom.bin`: standalone Mega Drive test ROM.
- `drv/out/multibank-rom/audio.wav`: audio recorded in BlastEm.
- `report.json` and `probe.bin` in that directory: validation results and observations.

The ROM test requires SGDK, the m68k toolchain, and the patched BlastEm. Environment configuration follows the existing `sgdk-gate`. Generated artifacts are excluded from Git; the branch contains the source and reproduction commands.

Other scores with one or two PCM voices can also be rendered. Samples are rebaked at 10.1 kHz without modifying the source files. The ROM tool chooses the one- or two-voice engine from the score; the PCM-only renderer uses the two-voice reference path. The ROM tool accepts a positional `.mmlisp` path, `--seconds 8`, and `--out DIR`. It leaves time to drain commands near the end and fails if a backlog exceeds the playback duration.

Adding `--separate-banks` to the renderer or ROM tool places each distinct baked blob in its own bank. This exercises sample-bank changes even for scores that fit in 32 KiB. Identical blobs remain shared. The gate verifies unchanged sample bytes and agreement between each layout's output and its reference model. Omitting redundant PCM settings can change command counts and onset times between layouts.

## Architecture

The mixer was changed from reading alternating voices from ROM on every output sample to **generating 16-sample blocks one voice at a time**.

1. Resolve voice 0's start and loop state.
2. Complete the nine-bit ROM bank selection and write 16 samples from voice 0 into the future output ring.
3. Repeat for voice 1, adding its contribution with saturation to the values already written.
4. Output a different, completed block through the DAC one sample at a time, at a fixed period.

The existing 256-byte output ring serves as the work area, rather than copying samples into a separate large cache. Extra pointers, bank numbers, and block position occupy ten bytes at `$1E00..$1E09`. No voice reads ROM during a partial bank change; the generator preserves the order of bank writes and sample reads. Each bank retains its final 256 bytes of silence.

The first simple placement required a lower rate. Grouped sample routines and a joint search for PCM work and FM-command placement made the work fit into 354 cycles. The calculation includes both branch paths, padding, ROM wait states, actual instructions, and code size, rather than only estimating spare time.

`drv/tools/machine.mjs` gained an optional model of the actual nine-bit serial bank latch. Existing tests can still supply an already selected 32 KiB window. Different sample data at identical window addresses prevents a model that ignores bank switching from passing, and a fault dropping the ninth bit is also detected. The ninth-bit test uses a synthetic ROM in the instruction model; it does not demonstrate cartridge support beyond 4 MiB.

## Prototype boundaries

- The new engine supports NTSC and one or two voices, both at 10.1 kHz. A dedicated one-voice 14.4 kHz layout, three voices, and PAL were not implemented.
- **Each baked blob is limited to 32,512 bytes.** The limit on combined samples is removed, but playback of one blob across a bank boundary is unsupported.
- The existing 256-entry limit remains. Each note-specific copy counts as an entry.
- Loops, release, volume, master attenuation, and retriggers are preserved. Loop boundaries retain the existing 16-sample granularity.
- The prototype appends a two-byte voice bank number to PCM_START. Experimental STORE operations use `$1C..$1F`, space available in the two-voice layout; the same assignment cannot simply extend to three voices.
- START/RETARGET fences are calculated from the generated schedule: two pairs for the latest two-voice layout and ten for one voice. Required IDLEs precede the next staged store or generation change for that voice; intervening FM and other-voice pairs also count toward the fence. Added bank information and fences mean the maximum onset density is not guaranteed to equal the legacy engine's.
- Generation lead increases by 14 samples, or about 1.38 ms. Block order and FIFO waiting also affect onset, so this is not a measurement of total latency.
- MMLisp-to-IR compilation and note-specific baking use existing code. Prototype tools repack samples into multiple banks and explicitly pass banked entries to the JavaScript sequencer.
- The ROM's 68000 replays precomputed commands. It uses the production grab routine, but **does not validate the production C sequencer's per-frame workload or SE priority handling**.
- The ROM test supports PCM, FM, and PSG. It finishes sending initial instrument setup before advancing the song clock. PSG writes follow the video clock on the 68000, with no additional delay in the latest one- or two-voice prototype. The older scheme followed FIFO completion and distorted PSG update intervals; it was removed. Keeping PSG timing independent of FM congestion preserves its beat and envelope updates. All PSG bytes and update intervals are compared with observations. Browser playback, VGM export, normal `.smp`, bundles, and the SGDK installer still used the legacy format at this stage.
- The packer limits samples to the normal 4 MiB ROM aperture. Score code and other resources also occupy ROM; the gate rejects a complete test ROM exceeding 4 MiB. Mapper support is not included.

## Validation

- The new gate checks silence, long one-shots, simultaneous different-bank playback, one-block loops, moving loops, release, volume and master attenuation, retriggers, bank ends, and dense FM commands. It compares all DAC values, output periods, command order, START/RETARGET intent, and YM write spacing.
- The actual fixture exceeds the legacy export capacity and plays 37,344 bytes of samples in the prototype. Tests also cover sample sharing and the per-blob size limit.
- Fault injection is detected for ignored bank selection, a missing ninth bank bit, an added NOP changing timing, and removed protective IDLEs.
- BlastEm tests relocate bank numbers to actual ROM addresses. An independent model driven by observed Z80 STOREs checks every DAC value, all PCM commands, FM streams, YM settling, and rates both including and excluding bus stops.
- Legacy regressions passed: `mirrors`, `selftest`, all 24 one- through three-voice cases in `engine:gate`, and `engine:gate:negatives`.
- The existing `sgdk-gate tests/m4-pcm-2v-master.mmlisp --seconds 8` was also run for comparison. DAC values and the 10,111.70 Hz running rate matched, but the initial FM comparison failed: observed `$2B=0` differed from expected `$B0=7`. Mirrors confirmed unchanged production binaries. This existing failure is not included in claims that all tests passed.

Real hardware, strong VDP DMA contention, game workload, and worst-case SE interruptions were not tested in the prototype. The next integration steps were a banked sample format, C sequencer and pair conversion, SGDK API handling, browser reference playback, and gates covering those paths. The prototype established that the Z80 implementation could expand capacity for at least two voices without lowering the output rate.

## Addressing timing jitter in sin008

In a 30-second test of MUCOM-converted `sin008`, with five FM channels, three PSG channels, and one PCM voice, changing from one bank to seven did not change onset timing. The old PSG path waited for FM/PCM FIFO completion, however, so update intervals varied with command density. During instrument changes, delayed PSG envelope updates could execute together in a burst.

The first timing changes were:

- Remove rounding of FIFO destinations to 16-pair boundaries; wrap only at a page crossing.
- Omit unchanged PCM level, SRC, END, WRAP, and bank settings, while retaining START/RETARGET publication and two protective IDLEs.
- Raise Z80 consumption from eight to ten pairs per 80 samples without changing the PCM rate. The 68000 performs up to two 16-pair transfers when needed and waits if FIFO space is insufficient.
- Start the song clock after initial instrument setup completes, and observe its start with a probe marker.
- Give PSG a fixed two-frame delay. The ROM gate fails if its update intervals deviate by more than one quarter of a frame.

Onset-interval error is the absolute difference from the source's frame intervals. Measurements exclude the first 60 frames, compare FM/PCM per voice and PSG per update frame, and exclude constant latency from interval error.

| Measurement | Previous recording | Timing fix |
| --- | ---: | ---: |
| PSG update-interval error, 95th percentile | 50.68 ms | 0.64 ms |
| PSG update-interval error, maximum | 116.84 ms | 0.77 ms |
| FM onset-interval error, 95th percentile | 23.47 ms | 14.56 ms |
| FM onset-interval error, maximum | 55.87 ms | 55.93 ms |
| PCM start-interval error, 95th percentile | 11.72 ms | 10.10 ms |
| Nominal DAC rate | 10,111.709 Hz | 10,111.709 Hz |

The corrected seven-bank ROM matched 298,030 DAC values, 136 PCM starts, 1,641 FM writes, and 1,773 PSG writes. Bus stops reduced the rate by about 0.178%. PSG-related jitter was resolved, but large FM instrument changes still caused temporary onset delays. Preserving write order at the same DAC rate cannot remove that worst-case delay without additional transfer or instrument-preparation design.

The recording is `drv/out/sin008/rom-timing-fixed/audio.wav`, and the ROM is `out/rom.bin` in the same directory. Detailed measurements are under `timing` in `report.json`. Earlier recordings remain available for comparison.

## Further startup and instrument-change improvements

A dedicated one-voice 10.1 kHz engine removed unused second-voice work and increased command capacity to 55 pairs per 80 samples, or about 6,951 pairs/s. Both expander A and B may occupy one output interval, but each interval reads at most one pair, retaining a DAC period of 354 cycles. Code occupies 2,561 bytes and mean scheduled work is 82.2%. The selected capacity consumes fewer than 128 pairs per video frame, allowing a fresh published FIFO position to be read before each frame's transfers.

The one-voice host performs up to five 16-pair transfers as needed and uses available FIFO cells for instrument-upload bursts. Protective IDLEs are inserted immediately before the next staging update and omitted when intervening FM pairs already satisfy the protection time.

Short writes for independent FM channels are sent before other channels' long instrument uploads. Write order within each channel remains intact, and adjacent F-number upper/lower pairs are never split. LFO-dependent voices, special channel-3 operations, the DAC channel, and frames containing unknown global control are excluded. Instrument data and key-on counts are unchanged.

The new 30-second, seven-bank `sin008` ROM matched 297,864 DAC values, 136 PCM starts, 1,641 FM writes, and 1,773 PSG writes. Its nominal rate was 10,111.709 Hz and its effective rate including stops was 10,088.043 Hz, a loss of about 0.234%.

| Measurement | Previous timing fix | One-voice improvement |
| --- | ---: | ---: |
| FM onset-interval error, 95th percentile | 14.56 ms | 2.63 ms |
| FM onset-interval error, maximum | 55.93 ms | 13.84 ms |
| PCM start-interval error, 95th percentile | 10.10 ms | 2.15 ms |
| PCM start-interval error, maximum | 13.14 ms | 3.73 ms |

The first simultaneous FM onsets spanned 0.58 ms. Separate measurements of the first 60 frames found maximum interval errors of 3.48 ms for FM and 2.06 ms for PCM. Temporary differences below 14 ms remain, so this does not establish perfectly simultaneous playback.

The recording is `drv/out/sin008/rom-start-timbre-final/audio.wav`, with `startup.wav` for the opening and `timbre-change.wav` around the instrument change. Details are in that directory's `report.json`, including startup data under `timing.startup`; comparison data is in `drv/out/sin008/start-timbre-comparison.json`. One- and two-voice instruction gates, fault injection, generation protection, and FM reordering tests were also run.

## Additional two-voice and multi-channel tests

Allowing expander A/B in the same DAC interval increased the two-voice layout to 15 pairs per 80 samples, about 1,896 pairs/s. This is 50% more than the previous ten-pair prototype, at the same 10,111.709 Hz PCM rate. There is at most one FIFO read per interval. Sixteen pairs did not fit within 354 cycles and were not selected. This intermediate layout required three protective pairs, used 94.1% mean workload, and occupied 3,543 code bytes. The 68000 used up to five transfers, a 32-pair FIFO lead, and no additional PSG delay.

A test copy at `drv/out/sin008/two-voice-stress.mmlisp` added a repeating PCM2 part without modifying the user's original song. It is a different arrangement, with two PCM voices, five FM channels, and three PSG channels. Distinct samples were forced into seven ROM banks for 30 seconds of playback. BlastEm matched 297,837 DAC values, 243 PCM starts, 1,569 FM writes, and 1,736 PSG writes. Rate loss including bus stops was 0.243%.

Interval error was 9.44 ms at the 95th percentile and 28.12 ms maximum for FM; 6.55 ms and 9.28 ms for PCM; and 1.03 ms maximum for PSG. Startup FM onset spread was 1.89 ms. Waveforms and writes were correct, but congested FM timing was worse than the one-voice profile, so this did not guarantee jitter-free playback for all songs. Three-voice PCM, real-hardware validation, and normal-path integration remained unsupported at that stage.

The recording is `drv/out/sin008/rom-two-voice-stress/audio.wav`, with `report.json` in the same directory. The fixture exceeding 32 KiB also passed in `drv/out/multibank-rom-two-fast-transport/report.json`, matching 75,657 DAC values, 20 PCM starts, and 316 FM writes. Voice-count gates, generation fences, fault injection, and production-image mirror checks passed.

### Correcting the multi-channel test's tempo

The first two-voice test mistakenly added `:tempo 120` to the PCM2 part. Tempo applies to the entire song, so it played about 6.3% slower than the original 128.08 BPM. That recording's overall speed must not be treated as a measurement of engine slowdown. Removing the added tempo directive restored the source tempo.

The corrected recording is `drv/out/sin008/rom-two-voice-tempo-fixed/audio.wav`. The original and corrected copy had identical PSG write streams and scheduled frames over the 30-second test. The corrected ROM matched 297,828 DAC values, 260 PCM starts, 1,641 FM writes, and 1,773 PSG writes. Local interval errors remained: 27.68 ms maximum for FM and 10.07 ms for PCM. Only the test copy was changed.

### Improving onset intervals near seven seconds

Frames that placed two-voice PCM START staging before short FM notes had varying FM wait times. For the two-voice test, FM updates of at most eight pairs, excluding initialization and chip-wide control frames, were moved before PCM staging in the same frame. Long instrument uploads retained their previous order; moving all FM traffic ahead of PCM was not selected because it substantially delayed PCM. Internal FM write order and PCM command order remain intact.

Inlining the two-voice expander B and the final sample in each block reduced call overhead. Capacity remains 15 pairs, with 91.7% mean workload, 3,898 code bytes, and a two-pair generation fence. The one-voice layout is unchanged. Timing-fault injection now adds a NOP to `slot0`, which always executes.

The 45-second ROM matched 449,330 DAC values, 396 PCM starts, 2,410 FM writes, and 2,879 PSG writes. Near seven seconds, FM3 interval error at frame 417 improved from -13.99 ms to -9.14 ms. Across the full recording, maximum errors remained 27.66 ms for FM and 13.71 ms for PCM. Prioritizing short FM updates increased the PCM maximum from the previous 30-second test's 10.07 ms, so this is not a complete solution.

The recording is `drv/out/sin008/rom-two-voice-note-first/audio.wav`; `around-7s.wav` contains seconds 5–10. Comparisons for frames 395–424 use observed YM key-on times and scheduled frames from both tests at the original 128.08 BPM.


## PAL and three-voice feasibility follow-up (2026-10-06)

The user asked for an outlook, not implementation. Temporary study modules and
assembly files were removed; production code and generated images were unchanged.

PAL requires more than removing the current rejection. A 50 Hz song frame is
longer, so the one-voice 55-pair layout can consume an entire 128-pair FIFO ring
between published-position observations. Counting A sites over a conservative
204-output-slot window, using the current NTSC rate at 50 frames/s plus a slot
of phase margin, found peaks of 142 reads for 55 pairs/lap, 129 for 50, 125 for
48, and 117 for 45. A 48-pair candidate fits the generated schedule and code
allocation. This is a placement study, not PAL playback validation; actual PAL
clocks, bake-rate stamps, 50 Hz conversion, FIFO publication, host timing,
PSG intervals, and ROM tests still need integration and verification.

For three voices, a temporary candidate retained 538 cycles/sample
(6,653.429 Hz under the current NTSC clock), added the third pointer/bank state,
and allowed five-sample grouped routines for the additional voices. An
80-sample lap fit instruction timing but used 5,093 code bytes at ten pairs,
exceeding the 4,352-byte contiguous code allocation. Reducing the lap to
48 samples gave these assembled placement results:

| Pairs per lap | Code bytes | Mean scheduled work | Generation fence |
| --- | ---: | ---: | ---: |
| 8 | 3,287 | 89.2% | 2 |
| 10 | 3,291 | 91.0% | 3 |
| 12 | 3,289 | 92.8% | 3 |

Fifteen pairs did not fit. The twelve-pair candidate would provide about
1,663 pairs/s, below the current two-voice layout's roughly 1,896 pairs/s,
while serving another PCM voice. Dense-command timing is therefore still a
material concern.

The temporary third bank used STORE op 0x21 for its low byte and a zero high
byte, appropriate only to the existing 4 MiB ROM aperture. The first two bank
words stayed at 0x1c/0x1e. This is a possible protocol assignment, not a chosen
public ABI: it requires updating sequencer/host fencing, models, descriptors,
loaders, and format checks. No third-voice waveform, intent, loop, saturation,
SE, or BlastEm gate was run. Assembly and placement establish a promising
starting point, not completed or validated playback support.


## PAL one/two-voice milestone (2026-10-07)

Region-specific samples, generated rate tables, engine selection, 50 Hz export,
installer/bundle flags, live models, and actual PAL ROM validation are implemented.
The PAL clock model follows the patched BlastEm core (53,203,395 master Hz,
313 lines/frame); one voice uses 48 expander pairs/lap to keep published FIFO
observations below one ring wrap. Its PCM rate is 10,019.472 Hz.

PAL two-bank fixture: 73,741 matching DAC values and ten matching sample starts.
PAL sin008 one voice, twelve seconds: 113,804 DAC values, 54 starts, matching
FM/PSG, bus loss 0.591%. Two voices: 113,776 values, 102 starts, matching
FM/PSG, bus loss 0.615%. Reports are in drv/out/banked-pal-two and
drv/out/sin008/pal-one, pal-two. Region options explicitly force BlastEm to E.
C/JS format and command gates, generation/publication safety, and mirrors pass.
NTSC three-voice and PAL three-voice milestones follow next.


## NTSC three-voice milestone (2026-10-07)

The third voice is integrated with the standard sequencer, host, browser
models, and exporter. Its 48-sample lap fits 12 pairs at 538 cycles,
6,653.429 Hz. Code uses 3,289 bytes; the generation fence is three pairs.
The third voice stages bank byte 0x21 within the 4 MiB aperture.

The three-bank fixture bakes 53,616 bytes into a 131,072-byte SMP. BlastEm
matched 48,630 DAC values, twelve starts, FM and PSG. Instruction tests pass
for three-voice shots, loops, levels, retriggers and dense wire traffic.
The real-song three-voice copy initially lost the port switch during setup:
a pending FIFO head at 114 wrapped to zero while the consumer was near zero,
then a rejected transfer discarded the older pending head. Later transfers
overwrote unread FM commands. The planner now refuses a wrap that moves
backward across pending data and restores a still-pending head on abort.
Both paths have regression tests. The corrected twelve-second run matches
75,054 DAC values, 197 starts and all FM/PSG; FM maximum interval error is
28.46 ms. Artifact: drv/out/sin008/ntsc-three-fixed.
PAL three-voice is the next milestone.


## PAL three-voice and final validation (2026-10-07)

PAL three-voice playback is implemented at 6,592.738 Hz with the same
48-sample/12-pair instruction schedule as NTSC. The PAL three-bank fixture
matched 48,520 DAC values and twelve starts; the real-song copy matched
74,857 values and 197 starts, including FM/PSG, over twelve seconds. FM
maximum interval error for that copy was 13.28 ms, bus loss 0.624%.
Artifact paths: drv/out/banked-pal-three and drv/out/sin008/pal-three.

The final normal-driver matrix explicitly validates all six region/voice
profiles, including chip settling and frequency-latch safety, minimum FM/PSG
completion inferred from consumed PCM starts, and full observed command
prefixes. Reports: drv/out/banked-final-{60,50}-{1,2,3}.
Exact duplicate PAL/NTSC binaries are shared in the C header: six profiles
use four images rather than six. Generated descriptors and C stamps remain
region-specific. VGM PCM rendering passes for three voices in both regions.

Remaining items outside these milestones: real hardware and DMA-heavy games,
cross-bank single-sample streaming, and further timing improvements. Keep
residual jitter measurements separate from waveform/command correctness.

All three requested milestones are complete. The full `npm run verify:all`
regression suite and both banked gates pass. After image deduplication,
mirrors, SGDK type checks and the PAL three-voice native fixture pass again
(`drv/out/banked-pal-three-final`). PAL 1–2 was committed as `55e5523`;
NTSC 3 was committed as `7706513`; PAL 3 is the final milestone commit.

## Optimization investigation (2026-10-07)

Requested scope: investigate runtime and memory improvements after `7004739`.
Production sources remain unchanged. Experiments live under ignored
`drv/out/optimization-study/`; this entry preserves their findings.

### Recommended first: avoid the redundant empty transfer poll

`drv/sgdk/mmlispdrv.c:pump` currently performs a fresh FIFO poll before
planning, then another grab even when `mmlp_plan` returns zero. Five pumps
per frame can therefore request the bus ten times even without payload.
A scratch SGDK build changed only the second grab to
`bankedImage && !n ? fifoLo : grab(&blk, dst)`. The first fresh observation,
nonempty transfer deadline check, planner bookkeeping and PSG drain remain.

Controlled twelve-second NTSC three-voice comparison on the sin008 stress
copy, with the current normal SGDK example and forced multi-bank export:

| Measurement | Current | Scratch empty-poll change |
| --- | ---: | ---: |
| Z80 stopped time / observed DAC span | 0.731476% | 0.455570% |
| Matching DAC values | 75,055 | 75,263 |
| PCM starts | 197 | 197 |
| FM writes, ports 0 / 1 | 660 / 90 | 660 / 90 |
| PSG writes | 613 | 613 |
| FM interval error p95 | 24.161 ms | 16.254 ms |
| FM interval error maximum | 28.452 ms | 20.567 ms |

Both native gates pass, including waveform, command intent, FM/PSG prefixes,
chip settling and pitch-latch checks. Running DAC rate remains 6,653.428 Hz.
This removes about 38% of measured bus-stop time, not 38% of CPU load or
song duration. The observed timing improvement is one workload, not a bound.
Reports: `baseline/report.json` and `idle-poll/report.json` beneath the study
directory. All six profiles, lifecycle and FIFO safety still need validation
before integration. Further stopping of empty pump iterations needs a distinct
reason for no progress (empty versus full FIFO) and preserved PSG handling;
blindly reducing the five-transfer cap could worsen dense music.

### ROM: share tables and omit zero padding

All seven emitted images (three single-bank plus four unique banked binaries)
contain byte-identical 2,560-byte clamp/level tables at offset 0x1100. Keeping
one table block saves exactly 15,360 ROM bytes before descriptor/loader costs
when all profiles are linked. The four banked images alone account for 7,680
bytes of this duplicate storage. The previous PAL/NTSC whole-image sharing
has already been applied; this is additional sharing across distinct images.

There is also roughly 10 KiB of zero padding before the tables across the
seven images. Emit separate code spans and the shared tables; after clearing
Z80 RAM, upload code at zero and tables at 0x1100. Use assembler code-end
symbols, not trailing-zero heuristics, for actual span lengths. This preserves
Z80 addresses and steady-state timing while reducing ROM and boot copy work.
It does not reduce Z80 RAM. Check generated mirrors and both initial load and
profile-switch playback. Exact table equality was checked by `memory.mjs`.

### 68k CPU: reduce repeated FM classification

An instrumented twelve-second NTSC three-voice run (`profile.log`) measured
`pump` at 17.7% of elapsed 68k time, including `mmlp_plan` at 9.5%;
`mmlp_render` at 19.1%, including `banked_writes` at 4.3%. Do not add nested
shares. Wrappers add overhead, so these are prioritization measurements.

`banked_writes` scans the same frame once for safety/counts, once per eligible
channel (up to four), and again for remaining writes/port deferral. Keeping
indices for the small eligible groups could remove repeated full-frame
classification while preserving modulation barriers, channel order and
adjacent pitch-latch pairs. A six-channel/eight-index u16 scratch array would
cost 96 bytes; benchmark against the current path before adopting it.

The existing `MMLPairs` instance is 4,256 bytes in the m68k link map. Its
separate single-bank PCM lane uses 768 payload bytes that banked playback does
not use. Removing that lane is only a saving for a banked-only build or a
carefully redesigned representation; the shipped host switches between both
profiles, so this is lower priority than ROM sharing. Do not shrink queues
without measuring occupancy during initialization, dense patches and SE.

### Z80 throughput: promising placement, unresolved latency tradeoff

An in-memory generator variant inlined expander B for three voices, as the
two-voice engine already does, keeping the 538-cycle DAC period:

| Layout | Pairs / 48 samples | Code bytes | Mean scheduled work | Generation fence |
| --- | ---: | ---: | ---: | ---: |
| Current | 12 | 3,289 | 92.8% | 3 |
| Inline B | 12 | 3,403 | 91.5% | 4 |
| Inline B | 13 | 3,421 | 92.3% | 5 |

Thirteen pairs fit the 4,352-byte code allocation and provide 8.3% higher raw
pair throughput; fourteen and fifteen failed placement. The larger required
fence may offset the gain for repeated PCM starts. This is assembly/schedule
feasibility only: no instruction or native playback validation was performed
for these candidate images. Keep the original rate and prioritize measured
end-to-end latency over the raw pair count.

### Sample packing: lower priority for measured scores

`packBankedSamples` uses sequential next-fit placement. Sorting unique blobs
by decreasing length and filling earlier banks can reduce fragmentation
without changing sample IDs or the banked format. A valid size pattern
20,000 / 20,000 / 12,000 / 12,000 bytes takes three data banks today and two
with better packing, saving 32 KiB. Existing one/two/three-voice fixtures and
both real-song three-voice samples gained zero banks in the placement study;
the real song's 9,152 NTSC payload bytes already fit one data bank. The fixed
32 KiB directory bank is format overhead, not removable by packing alone.

Suggested implementation order: redundant empty poll, shared ROM tables/code
spans, measured FM grouping optimization, then optional sample packing.
Leave the Z80 throughput change as a separate timing experiment.

## Optimization implementation: empty transfers (2026-10-07)

The banked host now skips its second grab when the plan is empty. All six
NTSC/PAL voice profiles pass native playback checks under
`drv/out/optimization-study/empty-poll-{ntsc,pal}-{1,2,3}`. SGDK type checks,
the pair corpus and banked C/JS priming/SE/FIFO gates also pass.

## Optimization implementation: ROM spans (2026-10-07)

The C headers now store exact assembler code spans and a single common
2,560-byte table block. The host clears RAM and uploads code at zero and the
common tables at 0x1100. `engine-rom.mjs` rejects nonzero omitted padding or
any mismatch in shared tables, protecting future generator changes.
The seven code spans plus tables use 22,511 bytes rather than 48,384:
25,873 bytes saved before descriptor costs. Banked code alone is 12,281
bytes. Z80 instructions, addresses, rates and state protocol remain unchanged.

Mirrors and SGDK type checks pass. All six normal native banked profiles
pass under `drv/out/optimization-study/rom-{ntsc,pal}-{1,2,3}`; each run also
boots the single-bank pcm1 image before switching. The standalone single-bank
three-voice gate reports all DAC values matching the independent model and
correct runtime rate. Its FM prefix check fails on the existing initial
$2b=$0 write versus expected $b0=$7; an isolated build using the pre-change
headers/host at `1c673cd` reproduces the identical failure. The single-bank
SE diagnostic also reports matching DAC values and this same FM prefix
failure. Logs: `rom-single-three.log`, `rom-single-three-baseline.log`,
`rom-single-se.log`. Do not report those standalone gates as passing.
