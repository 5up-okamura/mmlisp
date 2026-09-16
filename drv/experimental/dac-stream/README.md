# dac-stream — the output-centred DAC engine, P0 / P1 / P2

The research bench of the engine that shipped. `docs/dac-engine-implementation.md`
is the instruction it implemented; this file is what was built, what was
measured, and what is not true yet.

**Since 2026-09-15 the shipped generator is not in this directory.** The
modules the production image is built from live in `drv/engine/` (config,
gen-stream, decode-split, corrector, observer, protocol, pair-host, pcm1-ref …,
and `phase-table.json`), and the engine's gates and instruments in `drv/tools/`
(`engine-1v-gate`, `engine-fifo-gate`, `engine-score-gate`, `machine`,
`probe-analysis`, `cooperative`). What stays here are the experiments that
import them — the two-voice gate, the BlastEm machine probe, the decoder
calibration, the listening tour. File paths quoted below are as they were when
each section was written. The P0 baseline tool went with the ring engine (tag
`archive/ring-engine`).

```
cd drv
npm run dac-stream          # the isolated gate in the JS model, 10 s a case
npm run dac-stream:long     # …and 60 s on the representative case, + JSON

sh blastem/setup.sh         # once — builds the emulator, ~2 min
npm run dac-stream:machine  # the same schedules on BlastEm
npm run dac-stream:probe-test  # the instrument's own negatives, incl. on the core

node experimental/dac-stream/machine-probe.mjs --case NAME --seconds N \
  [--strict]          # every case is required, nothing is informational
  [--fault NAME]      # drop-copy | no-commit | early-commit | late-request
  [--marks]           # build the 68000 side with its own timestamp writes
```

Nothing here is linked by, included in, or reachable from the shipped driver.

## The voice-count study (plan-pcm-spec.md D1 + D4, 2026-09-15)

```
npm run dac-stream:voices                       # highest placing rate for 1/2/3 voices
npm run dac-stream:voices -- --step-voices 1    # …with the octave step on voice 0 only
npm run dac-stream:voices -- --step-voices 0    # …with no octave step at all
npm run dac-stream:voices -- --flat-level       # …and with no level model at all
npm run dac-stream:nv                           # run the 2-voice point: TIME + VALUE
npm run dac-stream:nv -- --voices 3 --period 648 --step-voices 0   # another point
npm run dac-stream:nv -- ... --fault mis-cost | wrap               # the gate's own negatives
```

The generator's N-voice pair profile (`buildConfig({ pairs: true, voices: 1..3 })`):
D4's levels — eight rung pages (silence, then `s >> r` for r = 6..0), signed in
and biased out, the master folded into each voice's rung by the host, so ONE
table read a voice and no master stage — voice 0 through DE', voices 1 and 2
through a self-modified `ld hl,nn`, extra voices summed through the 512 B clamp
(cascaded: sat(sat(a+b)+c)), each voice's edge pieces at its own block phase
(0/8, 0/5/11). Any integer-cycle DAC period, the lap held under today's 8.01 ms
(one grab a lap), the expander at 1.5x the host's wire. The shipped image is
unchanged by any of it.

| voices | octave step | highest rate | mix cyc/sample | limit | code / region |
| --- | --- | --- | --- | --- | --- |
| 1 | — | 10,782 Hz | 104 (shipped: 129) | worst slot (START edge) | 2,474 / 4,864 |
| 1 | none | 12,052 Hz | 78 | worst slot (START edge) | 2,829 / 4,864 |
| 2 | both voices | 7,131 Hz | 235 | mean 79.5% | 2,373 / 4,352 |
| 2 | voice 0 only | 7,765 Hz | 209 | mean 79.5%, expander A beside the mix | 2,328 / 4,352 |
| 2 | none | 8,482 Hz | 183 | worst slot (START edge) | 2,763 / 4,352 |
| 3 | all voices | 4,716 Hz | 366 | mean 79.6% | 2,226 / 4,352 |
| 3 | voice 0 only | 5,264 Hz | 314 | mean 79.6% | 2,156 / 4,352 |
| 3 | none | 5,524 Hz | 288 | mean 79.6% | 2,124 / 4,352 |

Every point above runs clean in the JS machine (`gate-nv`, six cases: idle,
shots, full-scale clipping, level walks, stops, a roll): every interval is the
slot's length and every DAC byte is the reference's.

### Where the slot goes (2 voices, 8,482 Hz, 422 cycles a sample)

    mix 185 · the four note edges 51 · the pair expander 40 ·
    DAC write + fetch 18 · CSM/YM/corrector 32 · margin 96 (23%)

`--worst`/`--mean` price that margin and nothing else: 2 voices reach 9,085 Hz
at 90/86 and 9,597 Hz at 95/92. `--wire-margin` is not a lever (1.5x to 1.0x
moves no rate). The ONE-voice ceiling is not the total work — its mean is
58.2% — but the single slot that must hold the mix and the 130-cycle START
edge: relax only the worst-slot rule and it goes 12,648 Hz at 88%, 13,715 at
96%. Splitting START across two slots would be worth ~16.5 kHz at one voice
(where the mean would bind), 8,731 Hz at two, and nothing at three. Unbuilt.

### What expression costs, per voice per sample

The rung read — the level, and the signed → biased conversion with it — is 18
cycles; the 2^k octave step is 26 (24 on voice 0, whose step-free advance is
`inc de`); the saturating add and clamp of each EXTRA voice is 37. Changing a
level is nearly free: a self-modified page at that voice's block edge, 26
cycles per 16 samples. `--flat-level` drops the level model entirely, which is
what a driver that trades volume for rate runs:

| max rate | with levels | level-free |
| --- | --- | --- |
| 2 voices, no step | 8,482 Hz | 9,420 Hz |
| 2 voices, step on voice 0 | 7,765 Hz | 8,646 Hz |
| 3 voices, step on voice 0 | 5,264 Hz | 5,926 Hz |

Give up both and two voices reach the shipped one-voice rate. Past that the
binding rule is no longer the mean (74.6%) but the worst slot, and that slot is
a voice's START edge — the note machinery, not the mixing. `--flat-level` is a
placement and TIME result only: `gate-nv`'s reference mixes rungs, so it does
not check a level-free image's values.

## What it achieves

P1 (output only) and P2 up to **two voices with independent levels, a master,
and CSM alongside** pass the §6 gate. What is NOT built is at the bottom of
this file, and it is a real list: no loops, no ROM bank crossing, no note
starts and stops, no command protocol, no host transfer, and nothing has run
anywhere but the JS instruction model.

## The one-voice integration profile (R28 §63) — steps 1 and 2 DONE, on BlastEm

§62 stopped with no transport candidate: the pop-based writer had 10 sites a
lap against the 22–24 the corpus needs, and with the two-voice mixer in the
image neither the bytes (11 B a site) nor the cycles (~25 spare a slot) exist
to add more. R28 changes the plan rather than the limits (§63): the FIRST
integration profile is **one PCM voice** — the target song is FM5 + DAC1 +
PSG3 — and the mailbox, the pop-based writer and the entry window are replaced
by one ring of 2-byte `{op,val}` pairs consumed by expander sites (§63.3 D3/D4,
not built yet).

```
cd drv
npm run engine:1v                # the profile's JS gate, plain image
npm run engine:1v:split          # …with the decode, corrector and protocol placed
npm run dac-stream:split         # …its four limits are the last profile printed
npm run dac-stream:machine -- --case "one voice"   # BlastEm, five required cases
```

What step 1 built (`voices: 1, complete: true`, config.mjs `RAM_1V`):

| | |
| --- | --- |
| mixer | one source, a **16-bit pointer** in the window advanced by a **2^k step** in a self-modified `add` (the bank bakes one blob a note and reaches the octaves above with 2, 4, 8 — mmb.md §10.1); voice level then master, no clamp. 122 cycles a sample with the call |
| the edge | four constant-time pieces around a block boundary: STOP (b13, `END := 0`), COMPARE (b14, `park := DE' >= END`), PARK (b15, `DE' := $FF00` — the bank's silence page), START (b0, before the mix: `DE'`, END and the step from the staged bytes). 104 / 65 / 61 / 156 cycles |
| how a piece stays constant-time | a `jr` with **arms of one length**: the working arm is followed by a `jr` over a pad that costs exactly arm + 7, so both paths leave at the same cycle. The byte-mask form of the same pieces cost 92/129/170/179 and put three slots past the ceiling |
| start / stop | **generations, not flags**: the 68000 bumps `startGen` after the three staged bytes (or `stopGen`), the Z80 acts when it differs from the value it last acted on and latches what it READ — a bump between the read and the latch is still different at the next edge. A set-and-clear flag has a window a bus grab can land in |
| the END the host sends | `sampleEnd − 16·step`: the compare runs after the block's fifteenth sample, so the voice parks at the last edge before it would read past the end, never reads beyond it, and loses at most sixteen samples of tail. No padding after a blob is needed |
| lead | **18**, not 17: with 17 the START piece landed on the lap's last slot with the loop-back `jp`, at 85.2% |
| RAM | code `$0000..$0C00` (the clamp's 512 B absorbed), lut 15 pages, phase, ring, **fifo `$1D00`**, **state `$1E00`** (PCM1 in config.mjs), pub `$1E60`, glob, stack |
| four limits | worst 83.8%, mean **72.1%**, finished estimate **2,719 B of 3,072** (353 B spare, the expander's 260 B owed), RAM 8,192 |
| JS gate | 10 cases × 2 images: idle, a shot, steps 1/2/4/8, stop and restart, restart over a running voice, forty-byte samples, a drum roll every third block (622 starts), levels and master opposed, and two with CSM — every DAC byte against `pcm1-ref.mjs`, a block-level state machine written from §63.3 D2 that reads the host's events and the DAC's timestamps and nothing of the engine |
| BlastEm | 5 required cases (idle, shot, step 4, a 40-byte sample at step 2, no-CSM): 9,987.57 Hz, 5,370..5,385 master, every value matching; the start is staged by the 68000 before it releases the bus |

Three things the gate found before the machine did, and one the machine found:
the stop arm latched its generation after `ld hl,0` had taken L (so the stop
fired at every edge and re-zeroed END one edge after every restart); the
reference compared generations with `>` and the byte wraps at 256 (the Z80's
`cp` was right); the JS machine's constant H made the corrector chase a
phantom, so the machine now answers with a synthetic H that follows the line
clock (`syntheticH`); and the Z80's boot zeroed the whole state block, erasing
the start the 68000 had staged — it now touches only its own bytes.

### Step 2 — the pair transport, DONE on BlastEm

```
npm run engine:fifo               # the transport's JS gate (8 streams)
npm run engine:fifo:split         # …on the image with the decode/corrector/protocol
node experimental/dac-stream/machine-probe.mjs --case pairs --seconds 4   # BlastEm, 6 streams
```

| | |
| --- | --- |
| the wire | a 128-pair page at `$1D00`; a pair is `{op, val}`: `$22..$B6` a YM register for the current port (RAW), `$20` PORT, `$00..$09` a byte into the PCM state block (`(PCM_STATE + op) := val` — IDLE lands in a bucket, the levels are absolute pages, a start is five staged bytes then a new `startGen`, a stop a new `stopGen`) |
| the expander | sixteen steps a lap at fixed slots, each a `call xp_a` (151 cycles: fetch the op, then RAW / PORT / STORE as three arms padded to one length) and a `call xp_b` (82: idle the consumed pair, advance IX by an 8-bit add so the page wraps free, publish the index). IX is the FIFO pointer for the life of the run and IY's high byte the globals page; neither is used anywhere else |
| the host | twice a frame: **everything before the bus** — the groups whose time has come into a 68k RAM buffer, the destination, the copy's entry point — and inside the grab only the request, the grant poll, ONE read of the published index and a straight run of `move.b (a0)+,(a1)+`. Head = the index read LAST grab + 24, past what the consumer takes between grabs; ≤ 5 pairs a grab; a pitch pair whole or not at all (pair-host.mjs `makeProducer`, mirrored instruction for instruction in rom.mjs) |
| four limits | worst 83.8%, mean **69.2%**, **2,880 B** of 3,072 with the 275 B CSM test patch still inside, RAM 8,192; chain done by slot 26 |
| JS gate | 8 streams × 2 images: raw both ports, pitch pairs + key, dense (every grab full, 1,795 pairs), PCM start/level/master/stop/restart/steps, a drum roll with pitch + key (143 starts), two with CSM — every FM write the chip saw is the stream's per port and in order, every DAC byte matches the reference driven by the ENGINE's own state writes, clock unmoved |
| BlastEm | 6 streams, 4 s: **9,987.55..9,987.62 Hz**, every FM write in order on both ports (up to 1,072+1,072), DAC all matching, every runtime stop ≤ 1,500 master (280..1,500), request→release p50 42..92 Z80 cycles, ~480 grabs a case. The interval rows are informational while the bus is taken, as for every transfer case |

What the first BlastEm run taught, in order: parsing the table with the bus held
stopped the Z80 for 5,800 master a grab (now ~1,200 — plan first, copy inside);
a grab taken before the Z80 had finished booting had its five pairs erased by
the boot's own page clear (the wait comes first now); and **the frequency-latch
model was wrong**. Nuked-OPN2 keeps `reg_a4` (for `$A4-$A6`, committed by
`$A0-$A2`) and `reg_ac` (`$AC-$AE` / `$A8-$AA`) as two registers, each shared
by both parts; BlastEm latches per channel. The analyzer had one latch per
port covering both groups, which is what made R26 §60.7 read the CSM pair as a
threat to a `$A4` pair and what the first version of this producer inserted
IDLEs to dodge. `checkWriteStream` now models the chip; the producer's one
rule is that a pitch pair is written in one grab.

**Not built**: `VSET` from ROM voice bodies (step 3 — a patch is 30 raw pairs =
six grabs ≈ 50 ms until then); the production integration (step 4).

## What P1 achieves

At **9,987.57 Hz**, in the JS instruction model, over 10 s a case:

| | |
| --- | --- |
| mean effective rate | 9,987.570 Hz — **+0.0000%** of nominal |
| adjacent intervals | 358 or 359 cycles; **100%** inside 0.95T–1.05T |
| worst phase error | **0.8 cycles = 0.22%** of one period |
| drift over 10 s | **−0.6 cycles** (one group's Bresenham residue, and it never grows) |
| holes past 1.5T | **0** |
| what the clock adds to a 39 Hz tone | **−0.1 dB** at the worst non-tone bin, i.e. nothing above the measurement floor |
| code | **567 B** |

…and it holds with Timer B observed and its flag reset every group, with CSM
programmed and issuing two register writes a group, and with five FM register
writes crowded into one slot (69.1% of that interval spent, against the §4
ceiling of 80%). The 3,329 Hz and 13,317 Hz profiles come out at +0.0000% from
the same generator with no constant changed.

## What P2 achieves

Two voices, each with its own 16-step level, composed with a master, mixed into
16-sample blocks a page-sized ring holds, at the same clock:

| | |
| --- | --- |
| the clock | **unchanged**: +0.0000%, intervals 358 or 359, phase 0.8 cycles, zero holes, at one voice and at two, with and without CSM |
| every sample | matches an **independent** JS reference (`lut.mjs`) — all 16 levels walked, a master fade to silence and back, voice-against-master and voice-against-voice opposed fades, and both voices at full scale into the clamp |
| the normal slot | **57.8%** of its interval at two voices; worst slot 79.6% (the block edge), against §4's 80% |
| code | **1,784 B**, plus a 4 KB level family and a 512 B clamp table |

Three things carry it:

**Production is locked to consumption, and the gate checks it rather than
asserting it.** Slot *i* plays sample *i* and builds sample *i + 17*, one of
each, for ever — verified per slot over the whole run: exactly one play fetch
and exactly one finished store, a build-to-play distance that never moves
(16 = the 17-sample lead less the one-sample fetch-ahead, which is where the
measurement points are), across 77 page wraps, with nothing reading a sample
still under construction. Removing one `call mix_one` from the image makes it
fail, which is how the check is known to bite. The ring cannot drain and cannot
overrun; there is no fill counter, no low-water mark and no regulator. The
property the shipped engine spent four measurement rounds trying to obtain is
here a consequence of the schedule, and the 17-sample lead is what buys the
block — a level change lands on a block edge and is whole (§3.4).

**Every slot's work is constant time, and that is a hard constraint.** A
cycle-placed schedule has no clock to wait on: work that can finish early
*does*, and then the next DAC write moves. So the mixer carries no
data-dependent branch. The saturating add of two voices is where that bites,
and the answer is a 512-byte table indexed by the carry out of `add a,(hl)` —
five instructions, no jump. The branch-and-fix form is 10 cycles on the common
path and 35 on the rare one, and in this structure the difference has to be
padded away on *every* sample anyway, so the branch buys nothing.

**Everything is biased-unsigned, end to end**, with the conversions baked into
the tables — source byte, both level lookups, the clamp, the ring, the DAC.
That is 21 cycles a sample against the same code with `xor $80` where it would
otherwise be needed, which is 6% of the period.

The generator **refuses to emit a slot that overruns**, and it named a real
one: two voices, plus CSM's two frequency writes in a single slot, plus the
Timer B reset is 396 cycles of a 358-cycle interval. The fix is the one §3.5
asks for — the FM transaction is split across two slots, each re-latching
`$2A` behind it — not a smaller estimate.

## What the COMPLETE 2ch engine's budget looks like

§10.3 step 2 (R1) asks for the finished 2ch version's whole placement before
any more of it is written, with nothing left at zero because it does not exist
yet. So the reservations are **executed**: a `complete` build runs every
unwritten feature's cycles as padding and claims its RAM, and the same §6 gate
runs against it. A table of intentions cannot fail; this can.

| | |
| --- | --- |
| cycles | **1,033 reserved per 16-sample block** (64.6 a slot) on top of the mixer's 207. Worst slot **79.6%**, mean 77.2% — the worst slot is unchanged from the prototype, which is what R1 asks for |
| RAM | **8,096 B of 8,192 claimed, 96 B unclaimed** — and 96 B is not a margin |
| code | **2,384 B of the 2,560 B region**: 1,776 built plus 608 estimated from instruction sketches. 176 B spare |

What the reservations buy, and the rate each one is sized for:

| per block | cycles | what it buys |
| --- | --- | --- |
| output index + snapshot | 300 | ~~the §3.7 publication~~ — **spent on the bounded corrector instead** (R10 §29.5), and the publication that replaced it is real code costing 87 cycles a block: a 5-byte snapshot through main BC and the logical position's own advance |
| voice run state | 260 | two voices' blocks-left countdown and loop-or-advance, selected branch-free and **staged**, not applied |
| command dispatch | 145 | one command a block = **624 commands/s**, against roughly 10 PCM events a frame. **The mailbox consumer measures 578 a lap against the 725 reserved** — see below, and note that 124.84 bundles/s is not the same number as 600 scalar commands/s |
| YM / PSG writes | 280 | four a block = **2,497 writes/s = 41.6 a frame**, which is the shipped driver's typical |
| block edge B | 48 | the two staged source pointers into `DE'`/`IX` |

**What the command reservation actually costs (R15, R16, R17).** The reservation
is 145 cycles a block — b9 and b10, ten positions, 725 cycles a lap. Three
consumers have been written against it and measured:

| | shape | cycles a lap | positions |
| --- | --- | ---: | ---: |
| R15 | one SCALAR record a block: `{slot, value}` | 3,095 | 30 |
| R16 | one desired-state BUNDLE a lap, over a FIFO | 867 | 10 |
| **R17** | **the same bundle, through a one-slot MAILBOX** | **578** | **10** |
| reserved | | **725** | **10** |

The bundle was the right shape — three simultaneous level changes are one record
and one decision — and the mailbox is what finally made it affordable. R16's
consumer still ran a general FIFO on the Z80 (head against tail, a size byte, a
type byte, a record pointer rebuilt every lap), and that machinery, not the
arithmetic, was where its 867 cycles went. A waiting list belongs to the CPU that
can afford one, so the Z80 now holds ONE outstanding desired state at a fixed
address with a two-byte handshake — and because nothing is dereferenced, **main
BC is not used anywhere in the chain**, which is checked by decoding the emitted
bytes rather than by reading the source.

Time is counted in observations rather than samples: a bundle can only land on a
lap boundary, so `applyAtLow` was carrying a multiple of eighty in sixteen bits.
`decisionObservation:u16` runs against the decoder's own counter — same width,
same wrap, 1..32767 laps of look-ahead instead of samples — and the engine's
`outputSampleLow` is gone with the arithmetic that needed it.

| | worst slot | mean | consumer | code (finished) | RAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| decode + corrector, publication replaced | 83.8% | 78.0% | — | 2,407 B | ok |
| + the runtime protocol | 83.8% | 79.5% | — | 2,551 B | ok |
| + the R16 bundle over a FIFO | 96.6% | 79.7% | 867 | 2,540 B | ok |
| **+ the R17 mailbox** | **83.8%** | **78.7%** | **578** | **2,466 B** | **ok** |
| limits | 83.9% | 79.6% | 725 | 2,560 B | 8,192 B |

The YM/PSG slot writer's b11..b14 reservation is untouched throughout: R17 §43.1
holds it until the host-YM safe window of §33.6 step 5 answers.

**Two things the integration test found (R19 §46.3), and nothing else could.**
Running the complete 2ch image and a real 68000 mailbox host together for the
first time broke two accepted results:

* **The 68000 cannot read Z80 RAM with word or long moves.** The Z80 bus is
  eight bits: a word or long access to `$A00000..$A0FFFF` returns the byte at the
  EVEN address duplicated into both halves. The "one straight run of long moves"
  that replaced nine `move.b` had only ever been TIMED — the first test to read
  the host's copy back saw an observation number of `$0202` where the engine's
  counter said 2, which is exactly `[b0, b0, b2, b2]`. The read is now the
  selector plus the one face it names, byte by byte, in one grab. **The
  890..1,144 master that run was quoted at is withdrawn** — it is not the cost of
  a transfer that can be executed. The byte read is 819..987 master.

  Since R20 §48.3 this is a rule in three places rather than a fixed bug: the
  68000 emitter refuses to encode an absolute access to that window wider than a
  byte, a `z80Xfer` scope refuses one through an address register, and the
  selftest checks the access ledger of every rom the suite builds. The negative
  is `--fault wide-read`, which rebuilds the withdrawn word-move read; the
  required machine case `proto P1, snapshot byte width` publishes three different
  constants behind the observation number and stamps every reading, and that
  fault turns 489 good readings into 490 bad ones.
* **Piece costs measured on the P1 rig are a lower bound, not a value.** P1's
  instructions are short; the 2ch mixer's `ld a,(ix+0)` and its `call`/`ret` make
  the bus grant land later. The whole handshake in one grab is 1,354 master on
  P1 and **1,541 inside the complete engine** — past the 1,500 the live contract
  allows. So the host splits it into a snapshot read and an atomic publish
  attempt, one grab an observation interval each. R20 §48.4 then moved every
  fixed address, the payload and the next commit value out of the critical
  section, which left the request, the grant poll, the ack read and its compare,
  the five payload bytes, the commit and the release: **1,085..1,225 master when
  a bundle goes out**, 553..679 when the box is busy, 819..987 for a read, and
  the worst total between two H observations 1,160 with none over.

  R21 §50.2 then took the LEAD out of it. The engine publishes its snapshot 62.8%
  into the lap — publication is the last link of H read → decode → corrector →
  publish — so a host reading before that point holds the previous lap's number
  and one reading after it holds the current one, and it cannot tell which. No
  fixed lead survives that: lead 2 was late in every phase below 0.628 and lead 3
  was never late but held the one mailbox slot long enough to lose 14 attempts in
  121. The host now builds BOTH candidate payloads before taking the bus, reads
  the decoder's own live counter in the same stopped Z80 as the ack, and
  publishes the one whose boundary is that counter's next — refusing, counting
  and letting go if the counter is neither. That is 1,085..1,418 master on the
  publish, 61.2 acknowledged updates a second, and every one of 3,675
  publications in a 60-second run named the live counter's next boundary.

  R21 left one window under a slot wide: `mb pending` read the commit at slot 8
  and the decode stored the counter's low byte at slot 8.99, so a commit landing
  between them was seen a lap after the counter the host had read, and applied
  one observation late — 44 of 3,675 in 60 seconds, all published between slot
  8.2 and slot 9.1.

  **R22 §52.2 closed it by moving the counter, not the box.** Its five pieces go
  immediately after the H read: they advance once per read and take nothing from
  the phase decode, and `read` has already left the lookup index in the operand
  it self-modified, so nothing is lost by putting them there. `count hi store`
  lands at slot 1 against `mb pending` at slot 8, and the generator now REFUSES
  an image where the counter finishes after the box is read — checked in cycles
  from the finished image, not in slot numbers, because those two were one slot
  apart on paper and the wrong way round in fact. `--fault counter-late` rebuilds
  the old arrangement and must be refused.

  Moving `mb pending` after the counter instead — the R18 §48.2 option — was
  measured and does not fit: it lands on `mb diff lo` and puts the image 101 B
  past 2,560 with a worst slot of 96.6%.

  The re-placement cost 13 bytes, which came back with interest from a fourth
  pad counter: `ld a,k` / `dec a` / `jr nz` is FIVE bytes for any wait where the
  IYL form is seven, because `dec a` is one byte and `dec iyl` is two with its IY
  prefix. Both destroy the flags and both are offered only where the caller has
  said the register is dead. The engine went from 2,495 B to 2,384 B and the
  finished estimate from 2,466 B to 2,382 B — 178 B spare — without one cycle
  moving.

  The period between transfers is GENERATED from what those paths cost (R20
  §48.5) rather than being a fixed DBRA count: at least one observation interval,
  so two transfers never share one and their stops never add; at most
  masterHz/120, so a pair of them still makes 60 desired-state updates a second.
  The measured interval is 438,543..438,935 master against the 438,762 it was
  solved for.

**Host-YM: withdrawn (R25 §57.1-2).** `ym-window.mjs` enumerates every YM access
the Z80 makes in a lap, twice — from the image's own instruction times and from
BlastEm's record, which R24 added to the probe — and refuses to answer if they
disagree. It began as a search for a "safe window" a 68000 FM transaction could
be slipped into; that premise is withdrawn. **The YM2612 is on the Z80's bus**,
so a 68000 access to `$A04000..$A04003` is answered with open bus unless the
68000 holds the bus (`host-YM P1, no bus` lands 0 of 28 attempts). There is
nothing to time between the Z80's accesses, because with the bus held the
transaction is atomic by construction.

And it is not enough anyway. The transaction works — 51.3 writes a second — but
`m3-macro-multi` asks the FM for **340 writes a second** (227 steady, and one
frame carrying a 186-write patch), which is 6.7× more. So **the Z80 owns the
YM2612**: the DAC, CSM and normal FM address/data and the `$2A` latch stay with
one owner, the 68000's BUSREQ windows touch Z80 RAM only, and the CSM guard that
would close the last rare race is not built, because it would not add a single
write a second. The tool and the negatives stay as the measurement and the
refusals a future proposal has to answer.

What there IS to get right: the address write steals the DAC's `$2A` latch, so
the Z80's next samples go to the FM register the 68000 selected. Left to the
engine's own CSM re-latch to fix, that is a 75,270 master hole in the DAC —
fourteen samples (`host-YM P1, no re-latch`). Putting `$2A` back inside the same
grab removes it exactly: the DAC interval is 5,130..5,385 master, the same as
with no transaction at all.

A transaction in its own grab costs 263..1,417 master and cannot share an
observation interval with a mailbox transfer (worst 1,589, four over 1,500 in 30
seconds). Riding the snapshot READ's grab costs nothing extra — worst 1,430,
none over — and sustains **51.3 transactions a second** with the mailbox
untouched at 61.2 updates a second. 16.1% of attempts are deferred because the
chip answered BUSY, and none of the 4,620 writes went out while it was.

**What a real score asks the chips for.** `corpus.mjs` reads it off the reference
driver itself — the same `DrvPlayer` and `SlotBuilder` the c-gate compares the C
port against — so the figures are the port's own behaviour, not an estimate.
Over the 41 c-gate scores: 14,627 FM writes, of which 7,095 are a voice patch,
3,019 TL, 3,808 pitch (half low byte, half high) and 542 key. `m3-macro-multi`
is 337 FM writes a second with patches and 226 steady, `m3-macro-pitchadd` 293
and 246. A patch frame carries up to 194 writes on its own. The PSG side is far
smaller — 170 a second at its heaviest.

**PSG: free (R25 §57.3).** The SN76489 is in the VDP's address space, not the
Z80's, so `$C00011` is reachable from the 68000 with **no BUSREQ at all** — none
of host-YM's BUSY, address latch or CSM race applies. Replaying what
`m3-macro-multi` really emits (276 bytes over 97 frames, from `corpus.mjs`) the
68000 delivered **5,232 of 5,232 bytes in the reference's own order** over 30
seconds, at 174.3 a second against the score's 169, with the stop count (3,674
against 3,673), the worst per-observation hold (1,429 against 1,418) and the DAC
interval (5,130..5,385 master) all as they are with no PSG at all.

One thing the replay had to be taught: its work is **data-dependent** — a frame
carries between none and six bytes — and the transfer period is generated from
what the host's loop costs. Left unpriced it made the interval 668 master long,
and the phase sweep reached only 63 of the lap's 80 slots, which R22's coverage
rule refused. Priced at the average, the interval is 436,723..441,637 against
the 438,762 it was solved for and the sweep reaches all 80.

The two bytes of a tone period are **not** atomic — the chip applies the low
four bits on the first byte and the high six on the second — so anything between
them is audible. Written back to back they are 294..364 master apart (~6 µs);
`PSG P1, split pairs` pulls them to 15,000 and is the negative that shows it
matters. These ROMs take no interrupt, so nothing can get between them here; a
driver with a VBlank handler would mask across the pair, which is 24 cycles.

## The Z80 YM writer, and what its reservation really buys (R26 §59)

b11..b14 of every block have been reserved for the slot writer since R16 §41.1:
**280 cycles a block and 120 bytes of code**, for four FM writes a block —
2,496.9 a second. R26 replaced the pad with real instructions. The rate is not
there, and the reason is bytes.

**One write is 11 bytes and 89 cycles, and it cannot be shared.** The loop is
eighty slots of straight-line code, so an opportunity that carries code carries
it twenty times a lap. A subroutine would fix that and is not available:

* `call`/`ret` is 27 cycles and `rst`/`ret` 21, against a 70-cycle position that
  also has to fetch an entry and make three chip writes.
* The queue cursor has nowhere to live but **SP**. Main BC carries a value
  across 47 of the 80 slots for the decode, HL is the ring's play cursor and DE
  is the DAC's data port — both read in every slot — IX is voice 1's source and
  IYL is where the mixer parks voice 0's contribution.
* SP and a call frame are mutually exclusive: `rst` pushes the return address at
  SP-2, so the first `pop` inside the routine reads it instead of the queue.

So the site is inline, and eleven bytes each is what decides everything:

| candidate | B | cyc | entry | producer | four a block | sites in 120 B | rate |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| **single stream, port in the entry** | **11** | **89** | 12 B | **4 B** | 356 cyc, 226 B | **10** | **1,248/s** |
| port runs, the port in a RAM byte | 15 | 93 | 8 B | 2 B | 372 cyc, 306 B | 7 | 874/s |
| port fixed by placement, port 0 | 11 | 77 | 8 B | 2 B | 308 cyc, 226 B | 10 | 1,248/s |
| port fixed by placement, port 1 | 9 | 60 | 6 B | 2 B | 240 cyc, **186 B** | 12 | 1,498/s |
| absolute stores, port self-modified | 14 | 76 | 6 B | 2 B | 304 cyc, 286 B | 8 | 999/s |

"producer" is the bytes a producer writes for each FM write — the number the
transport question needs, and four for the built form.

`node drv/experimental/dac-stream/ym-writer.mjs` prints it, assembled for the
bytes and summed from the documented cycle counts. **No candidate reaches four
writes a block inside both reservations** — twenty sites of the built form are
226 B against 120 and 356 cycles a block against 280 — and the port-1-only row,
which is the only one whose cycles fit, can reach channels 4-6 and nothing else:
`$28`, `$22`, `$27`, `$2A` and channels 1-3 are all port 0.

§59.3's first candidate is the **port run**, and it comes out worst: with twenty
independent inline sites "the current port" has no register to live in, so every
site re-reads it from RAM (4 bytes, 17 cycles) — and the run-length countdown is
not even in that figure. The single stream carries the port in each entry and
gets run switching for nothing, which is why it is the one that was built.

**What was built**, and what it measures:

| | |
| --- | --- |
| sites | **10 of the 20 opportunities**, 11 B each + 3 B of cursor reload + 3 B of boot set-up = **116 B of the 120 reserved** |
| cycles | **188 of the 280** a block, and 89 in a slot that has 93 at the ceiling |
| rate | **10 writes a lap = 1,248.4/s**, against 2,496.9 for four a block |
| four limits | worst slot 83.8%, mean 76.9%, finished estimate **2,366 B** of 2,560 (194 B spare), RAM 8,192 |
| chip | 37,156 register writes in 30 s, **37,156 in the window's order**, settling and both frequency latches clean, 0 YM accesses from the 68000, 0 PSG writes from the Z80 |
| mailbox, in the same image | 61.2 updates/s, worst stop 1,432 master of 1,500, 80 of 80 slots swept |

The site is eleven instructions and one idea: `pop` is one byte and carries its
address in SP, where an absolutely-addressed form is three.

```
pop  de        DE = the port to address ($4000, $4002 — or the bucket)
pop  af        A = the register number        (F takes the odd byte)
ld   (de),a
inc  e         → the matching data port
pop  af        A = the value
ld   (de),a
pop  de        DE = $4000, from the queue
pop  af        A = $2a
ld   (de),a    the DAC's address latch, put back inside the opportunity
inc  e         DE = $4001 again, where every slot's DAC write expects it
pop  af        …and past the word the mixer's `call` is about to use
```

**The target pointer is what makes an entry live or idle** — and that is a
property of this static fixture, not a commit (R27 §61.2). An entry whose
pointer names a two-byte bucket in the chip region makes no FM write at all: the
register and the value go to RAM, and the only chip access left is the
idempotent `$2A` re-latch. So an empty queue is not a path, it is the same path
with a different pointer: the four cases §59.4 asks to be the same length are
the same **instructions**, and `empty` and `dense` produce DAC streams that
agree sample for sample.

What it is **not** is something a producer could commit with. The 68000 reaches
Z80 RAM one byte at a time, so a 16-bit pointer's two halves never change
together — a reader can see `$1E00` or `$4060` between them. A real transport
publishes a window by releasing the bus, or by a separate one-byte generation
written last. `--fault port-first` shows only that a live entry read before its
payload is wrong; the 16-bit tear, window ownership and once-only consumption
are **not** tested by it.

**An entry is 12 bytes and the producer owns four of them** — the two of the
target pointer, the register and the value. R26 §60.8 said three, counting the
three *fields* as three bytes; that is withdrawn. The pointer's halves differ in
the high byte as well (`$1E60` idle against `$4000`/`$4002` live), so no
pre-initialisation shrinks it to one, and **four bytes a write is this form's
floor**.

**Two things the instructions do not say, both found by running it.**

*The stack and the queue are the same page, and one word an entry is the
engine's.* `call mix_one` runs in every slot and pushes at SP-2, which — once
the cursor has moved — is the last word the writer popped. For a queue consumed
once that is free space; this window is static and re-read every lap, so the
push was quietly rewriting the entry it had just read. The second lap re-latched
`$02` instead of `$2a` and every DAC sample after it went into an FM register:
3,373 Hz, 1,076 holes. The entry is now six words and the site pops six, using
five.

*A port-0 frequency pair may not straddle a block.* The engine's own CSM traffic
writes `$AC` at b6 of every block and commits it with `$A8` at b8, and the chip
has **one** holding register per part. The first `control` fixture put `$A4` at
the last opportunity of one block and `$A0` at the first of the next; the
analyzer said `$ac overwrote the frequency latch $a4 was holding`. It is a
constraint on the producer, not on the writer, and `pairsWithinBlocks()` now
refuses a window that breaks it.

**BUSY, on both clocks.** The slot's own DAC write raises BUSY for 1,386 master;
the writer's address write lands 3,555 master after it and its data write clears
1,815 master before the next slot's DAC write. Both are checked from the
instrument's own times, and the register-range settling, `$28`, `$30..$9E`,
`$A0..$B6`, the address latch and **both** frequency latches are checked by the
same `analyze.mjs` walk the JS gate uses.

**The negatives** (`--fault`, on `Z80 YM writer P1, control`): `no-relatch`
takes the DAC to 3,122 Hz and 11,192 of 11,193 writes out of the window;
`slow-empty` — the idle path one byte the same and three cycles short — breaks
the interval to 152,154 master; `port-bit` moves one entry to port 1 and is
caught at the eighth write; `pitch-split` puts another upper write between a
pair's halves and raises 432 frequency-latch problems; `port-first` commits an
entry before its register and value are there.

**What this does NOT settle.** The window is a **test fixture, not a transport**:
one lap's worth of entries laid down by the 68000 before the Z80 starts, never
refilled, so the same lap of writes repeats. Nothing here says how a producer
would fill it, and the numbers that a transport design has to start from are
these — **1,248.4 writes/s**, 12 queue bytes an entry of which a producer writes
**four**, and a 194-write patch frame taking 19.4 laps (~155 ms) to drain against
the corpus's 246 steady writes a second and 337 with patches.

## What the 41 scores MEAN, and what a transport would have to carry (R27 §61)

R25 counted the reference driver's FM traffic and R26 priced the writer that has
to emit it. Neither says what a transport carries, because a transport does not
carry writes — it carries intentions, and a voice patch is one intention worth
thirty of them. `semantic.mjs` folds the raw stream into five commands and
checks the fold by **unfolding it again**:

```
VOICE_SET(port, channel, voice)   a patch, folded to an IDENTITY — the
                                  register/value list with the channel taken out
                                  of the register numbers
PITCH(port, channel, hi, lo)      the $A4/$A0 pair, in that order
TL(port, channel, operator, v)    a level that moves at runtime
KEY(value)                        $28, the only write that starts a note
RAW_GLOBAL(port, reg, value)      everything else, kept rather than dropped
```

`classify()` and `expand()` are two functions and neither calls the other; the
reference the comparison uses is the driver's own output. Over the 41 scores
`c-gate` names — read out of `package.json`, so a score added to the gate is a
score this measures — **14,627 raw FM writes fold to 4,450 commands and expand
back to 14,627, byte for byte on every score**.

| | |
| --- | --- |
| voice identities | **32** in the whole corpus, 291 loads; at most **4** live on the six channels at once |
| patches never keyed | **201 of 291** — every score loads all six channels in its first frame and keys one |
| patches onto a sounding channel | **20**, which is the number a prefetch may not move |
| lead, patch to its key-on | median **1 frame**, max 241, and **12 of 90 have none at all** |
| the heaviest frame | 252 raw writes (`m2-motion`, frame 0): **230 inside 8 patches, 22 of delta** |

**The bus is what a transport has to fit in, and it is 0.28% of the machine.**
One byte into Z80 RAM is `move.b (a0)+,(a1)+` — 12 cycles, **87.2 master** at the
measured 7.265 master a cycle — and the contract is 1,500 master between two H
observations. The mailbox already takes one grab a lap, alternating a snapshot
read (440..926 master) and a publication (830..1,432), so what is left is:

| arrangement | a read lap | a publish lap | a lap | |
| --- | ---: | ---: | ---: | ---: |
| as-is, worst-case grabs | 6 B | 0 B | 3 B | **375 B/s** |
| as-is, best-case grabs | 12 B | 7 B | 9.5 B | 1,186 B/s |
| **merged handshake** (R25 §57, already measured at 373..1,354 master) | 1 B riding it | **12 B in a grab of its own** | 6.5 B | **811 B/s** |

Merging the mailbox's read and publication into one grab an observation is worth
**2.2×** on the wire and costs the mailbox nothing: it still makes 124.8 updates
a second where 60 are asked for.

**Two candidates, and a hybrid, against that** (`transport.mjs`, over all 41
scores, worst score in each column):

| | steady wire | over 375 B/s | steady lat p95 | worst key-on | late commands | expander |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw, as-is | 976 B/s | 5/41 | 8,447 ms | 8,571 ms | 1,445 | 0 |
| raw, merged | 976 B/s | 5/41 | 1,776 ms | 1,795 ms | 2,130 | 0 |
| hybrid (raw entries, cached patches) | 976 B/s | 5/41 | 930 ms | 955 ms | 2,258 | 54 cyc/lap |
| semantic, as-is | 369 B/s | 0/41 | 885 ms | 784 ms | 2,067 | 242 cyc/lap |
| **semantic, merged** | **369 B/s** | **0/41** | **239 ms** | **106 ms** | **621** | 242 cyc/lap |

**The wire is not what is short.** Raw needs four bytes a write and 976 B/s
steady, which is over the worst-case budget on five scores; semantic needs 369
of the 811 the merged handshake leaves, on every score. But raising the wire
to 256 bytes a lap — forty times what exists — still leaves commands late, so
the search was pointed at the other pipeline:

> **The writer needs 22 sites a lap for every key-on on time and 24 for every
> command, against the 10 it has.** At 24 sites the code is 270 B against the
> 120 B reserved and 2,136 cycles a lap against 1,400.

That is the same wall R26 §60 hit from the other side: eleven bytes a site is
what caps the writer at ten, and ten is what caps on-time delivery. Four writes
a block — twenty sites — would still be short of twenty-two.

**What the Z80 owes for a semantic wire.** Somebody has to turn a command into
the writer's entries, and every producer-owned byte the 68000 does not write the
Z80 must: a fetch and a store, 26 cycles, and neither register file has anything
spare. Measured against the corpus that is **242 cycles a lap**, which fits in
the ten b11..b14 opportunities the writer left empty (930 cycles at the ceiling)
— and spends them, so those opportunities can never also become write sites.
Reserved and EXECUTED as padding, the four limits still hold: worst slot 83.8%,
mean 78%, finished estimate **2,507 B** of 2,560 with the expander's 150 B in
it. The image with the CSM test patch is 45 B past the region and will not
assemble, which is the same refusal the mailbox profile already carries.

**Prefetch changed nothing in this corpus.** Moving a patch earlier is only
allowed over a stretch where its channel is silent (§61.4), and every patch in
these 41 scores is either in the cold start — where there is nothing to move it
past — or one of the 20 written onto a sounding channel, where it may not move.

**The cold start is a floor no transport can beat**: six voices is 180 chip
writes, and 180 at ten a lap is 18 laps = **144 ms**. A product loads them
before it starts, or waits.

**The listening tour.** `node drv/experimental/dac-stream/listen.mjs` builds two
ROMs — one with the CSM test tone and one without — that play the SAME image the
gates measure on a fixed 44-second timeline: each voice alone, an ordinary sum,
the clamp on purpose, the fifteen levels up and down, the same fade on the
master, a new desired state every publication, and then one piece of material
three times over with no transfer at all, at the representative density, and at
twice it. It writes a DAC-ONLY reference WAV from the instrument's own record of
every `$2A` write, and a manifest with each section's start second, intent,
expected levels, what was actually staged, and the RMS of the reference over
that window. The staged byte is a Z80 PAGE, not a level: the family starts at
page 12, and a host staging 0..14 is staging the code region as a volume table —
which showed up as a −4,000 DC offset in the reference WAV before it was fixed.

**How fast desired state can move**, measured with the 68000 really holding the
bus: the whole handshake in ONE grab — read the ack, publish if the box is free
— is 373..1,354 master, inside the 1,500 the live contract allows with 146 to
spare. One transfer an observation and one observation a lap is **124.8
desired-state updates a second**; publishing and acknowledging in separate grabs
gives 62.4, and payload/commit/ack separately gives 41.6.

Two things this settles, and one it does not:

**The block edge splits into two slots, and it has to.** All five activations —
three level pages and two source pointers — must land between the last mix of
one block and the first mix of the next. That window is not one slot: it spans
the tail of the slot that builds a block's last sample and the head of the next
one, because each slot's mix sits in the middle of it. Part A (the levels) is
implemented at the tail; part B (the pointers) is reserved at the head. Putting
all of it in one slot is 333 cycles = 93% of the interval, which passes the
deadline and blows the design margin.

**The 4 KB level family is what makes the schedule affordable, not what
threatens it.** §3.4 asks for a second candidate only if the integrated
reservation does not hold — it holds, with 96 B. And the obvious alternative
is worse where it matters: halving the tables by symmetry (16 levels × 128
entries) saves 2,048 B and costs sign handling on all three lookups, ~+45
cycles a sample. That takes the mixer to 252 and leaves 555 cycles a block
under the 80% line against the 1,033 reserved — it fits the 100% *deadline* and
not the design margin. The trade is bytes for exactly the headroom the
remaining work needs.

**It does not settle the ROM window.** The mixer reads both voices every
sample, so both sources must be inside the same 32 KB bank at once — the Z80's
bank register is nine serial writes to `$6000`, ~120 cycles, which cannot
happen twice a sample. Either all PCM in play lives in one bank (cost 0, and
the exporter's problem), or the mixer goes voice-outer over half a block and
switches twice a block (~240 cycles, and the fixed-lead invariant changes
shape). This is a design decision, not an implementation detail, and it is
listed with the other open items below.

## It runs on BlastEm, and the machine corrected the model

`npm run dac-stream:machine` builds a minimal cartridge — vectors, a header, a
twenty-instruction 68000 bootstrap that holds the Z80, copies the image, sets
the bank register and lets go — and runs it on BlastEm as a libretro core with
the probe patch's `$2A` log. There is no m68k toolchain here, so the bootstrap
is emitted directly by `rom.mjs`; that is the whole 68000 side of this test.

Every schedule the JS model passes also passes there:

| case | rate | intervals (master) | holes past 1.5T |
| --- | --- | --- | --- |
| output only | 9,987.57 Hz, **−0.0000%** | 5,334–5,418 (T = 5,376) | 0 |
| one voice | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |
| two voices (+ CSM) | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |
| 2ch complete budget (+ CSM) | 9,987.57 Hz, **−0.0000%** | 5,376–5,376 | 0 |

…and every sample matches the same reference the JS gate uses. The interval
spread in the first row is the **probe's own resolution**, not jitter: BlastEm
stamps a `$2A` write with the YM's cycle counter, which advances in 42-master
steps, so a 358-cycle slot (5,370 master) reads as 5,334 or 5,376. The five
values sum to 26,880 = exactly five nominal periods, which is the group closing
on itself.

**What the machine found that the model could not.** The first two-voice run
came back at 9,823.12 Hz — **−1.65%** — with every sample still correct. The
cause is the 68k bank window: a Z80 read at `$8000+` is not a RAM read.
Measured by running the same schedule with zero, one and two window reads a
sample:

| window reads a sample | 0 | 1 | 2 |
| --- | --- | --- | --- |
| measured rate | 9,987.57 | 9,904.66 | 9,823.12 Hz |
| error | −0.0000% | −0.8301% | −1.6465% |

Perfectly linear: **45 master clocks = 3 Z80 cycles per window read**, constant
to within the probe's resolution. That number replaces a guess — the shipped
engine's `PACE_WINDOW` is 14 and `gen-mixer.mjs` says in its own comment that
it has never been measured. It is a *floor*: the 68000 was spinning in a
two-instruction ROM loop while this was taken, and a 68000 doing VDP DMA
contends harder (R1 step 3 stage 4).

A constant, predictable wait is not the unpredictable external stall §3.1 says
padding cannot absorb — it is charged like any other cycle. So `config.mjs`
carries it, the generator bills it, the JS machine models it, and the rate came
back to −0.0000% on BlastEm at every voice count.

**Paying it cost six cycles a sample, and the machine's own measurement said
where to find them.** Voice 0's contribution used to be parked in the ring slot
and read back with `ld h,b`/`ld l,c`/`add a,(hl)` — 15 cycles. It now waits in
`IYL` (`ld iyl,a`, `add a,iyl`, 16 total against 22), which is exactly the six
back, and it makes the ownership argument trivial as a side effect: a partial
sum never enters the ring at all, so the "nothing reads a sample under
construction" check has nothing left to catch.

## §3.6, priced — and a BUSREQ transfer does not fit

R1 makes this the thing to settle before any more of P2 is written, so the ROM
does a real transfer: request the bus, wait for the grant, copy N bytes into
Z80 RAM, release. Measured on BlastEm, as the time the Z80 is stopped:

| bytes a grab | 1 | 16 | 64 | 256 |
| --- | --- | --- | --- | --- |
| the Z80 stops for (Z80 cycles) | **54.6** | 218.4 | 741.1 | 2,826 |
| rate at 10 kHz, one grab a frame | −0.083% | −0.724% | −2.461% | −8.839% |
| intervals past 1.10T | all the grabs | all | all | all |
| holes past 1.5T (3 s) | 0 | 333 | 327 | 306 |

The fit is **44 + 10.9N Z80 cycles**, and both halves of it matter:

- **The fixed cost alone is 44 cycles**, against §3.6's allowance of 0.10 T =
  **35.8 cycles** inside one output interval at 10 kHz. *No* BUSREQ transfer
  fits, not even a single byte — the smallest possible one already pushes its
  interval to 1.16 T.
- **Splitting a transfer makes it strictly worse.** N one-byte grabs cost 55 N
  where one N-byte grab costs 44 + 10.9 N. §3.6's second option — "短い分割転送"
  — is the wrong direction, and this is the measurement that says so.
- **The per-frame budget binds even harder than the per-interval one.** §3.6
  allows ~60 Z80 cycles a frame; that is 1.5 bytes. The shipped driver moves a
  write list of up to ~190 bytes a frame, which is 2,115 cycles — **35× the
  allowance**.

The allowance scales with the period, so the same experiment at the clock the
driver ships at today:

| 3,329 Hz, allowance 107.5 | 4 bytes | 16 bytes |
| --- | --- | --- |
| the Z80 stops for | 87.7 | 218.4 |
| every interval inside 0.90–1.10 T | **yes** | no |
| mean rate error | −0.138% | −0.366% |

So a four-byte grab at 3.3 kHz is the first thing measured that fits the
*interval* bound — and it still fails the ±0.1% mean, because 91.5 cycles a
frame is over the frame budget. **There is no clock in this family at which a
BUSREQ transfer carries a driver's command traffic inside §6.2.**

What that leaves, with the numbers this prototype can already put on them:

- **The Z80 reads 68k RAM through the window instead.** A window read measures
  3 Z80 cycles and stops nothing at all. The obstacle is that the window is one
  32 KB bank and the samples are in it: a mailbox in 68k work RAM needs the
  bank moved and put back, which is nine serial writes to `$6000` each way,
  ~126–180 cycles a switch from the instruction costs measured here. Once a
  block that is ~250–360 cycles against the 145 the command reservation holds —
  affordable, but it is a re-plan, not a tweak.
- **A cooperative window**: the 68000 grabs at an instant the Z80's schedule
  expects, and that slot's pad is generated short by the stall. It needs the
  68000 to know the Z80's phase to about ±10 cycles, which the published output
  index does not currently give it.
- **Widening the interval bound for one interval a frame**, which is a change
  to §6.2 and therefore the designer's call, not this prototype's.

## R2 — the transfer measured properly, and a cooperative window that holds

R2 (`docs/dac-engine-implementation.md` §11) sent the transfer question back
with three corrections: the 44-cycle "fixed cost" was this ROM's `LEA`s and
loop setup executed *inside* the grab; the log measured request→release, not
the Z80's stop→resume; and "a frame" was a `DBRA` count. All three are fixed.
The instrument now records the Z80-side DAC access (before the YM's 42-master
quantisation), the modelled stop and resume, the notification, every copied
byte with its offset, the commit byte, and the first unrequested BUSACK poll —
and a value mismatch is a fatal error whatever the case's label says
(`probe-analysis.mjs`, pinned by `probe-selftest.mjs` including a CLI negative
that corrupts one sample and expects exit 1).

**The minimal uncompensated transfer**, setup moved before BUSREQ, copy
unrolled, addresses held in registers — measured as the Z80's stop→resume:

| bytes a grab, ~63 grabs/s | 1 | 2 | 4 |
| --- | --- | --- | --- |
| Z80 stopped (Z80 cycles) | 4.3–17.3, p50 7.3 | 10.4–23.4, p50 13.3 | 23.5–35.5, p50 25.5 |
| mean rate | −0.0143% | −0.0251% | −0.0468% |
| §6.2 | **pass** | **pass** | fails the 99.9% band |

So one or two bytes a frame fit uncompensated, and the earlier "no BUSREQ
transfer of any size fits" is withdrawn as a statement about the hardware —
it was a statement about a routine.

**The cooperative window** (`cooperative.mjs`): the Z80 raises a notification
(one write into 68k work RAM through the bank window), keeps a window of
`nop`s, lowers it, then looks at a local commit byte the 68000 wrote last
before releasing. Commit present → that slot's pad is generated
`compensation` cycles short, so the planned stop is repaid where it happened.
Commit absent → the full pad runs; the Z80 never waits for the host. The
68000 polls for the low→high edge with interrupts masked and skips a window
it arrives late for.

| | 4 B, ≤125 grabs/s | 8 B every 5 slots (**16 KB/s**) |
| --- | --- | --- |
| compensation | 41 | 65 |
| host phases walked | 21 (`every` 11,000–13,000) | 31 (`every` 0–600) |
| mean-rate error | −0.0000%…+0.0013% | −0.0004%…+0.0001% |
| worst interval | 1.004 T | 1.008 T |
| Z80 stopped, all phases | 38.3–42.5 | 62.8–68.3 |
| 60 s at the phase that used to fail | — | 597,275 samples, −0.0000%, gaps 0.993–1.004 T |

**What the phase-dependent failure was.** The window was a `djnz` loop.
BUSACK is granted at an M-cycle boundary, so on a 13-cycle `djnz` iteration
the stop begins up to 13 cycles after the request, and *where* depends on the
68000's phase: measured 53–65 cycles, averaging the compensation in seven
phases and missing it by 4.3 in the eighth — the +0.2387% that stopped the
work. A window of `nop`s bounds that to 4 cycles, and the stop is 62.8–68.3 in
every phase. The compensation is then a property of the transfer routine (its
fixed hold plus grant and resume latency), set from the same routine's
measured stop and *proved* across the host's phase, not fitted to a rate.

**The hardware-facing rule this leaves.** In the model the residual averages
to zero because grants land on the emulator's sync points; on silicon the
residual is the M-cycle grant jitter, ≤ 4 cycles on `nop`s, of unknown mean.
At 2,000 grabs/s a mean residual of 1 cycle is 0.056% of the rate, so the
±0.1% budget allows a mean residual of about 1.8 cycles at that density, or
proportionally more at lower density. That is the number a hardware round has
to return.

**What this does not settle.** All of it is the P1 output-only engine with a
340-cycle pad. The 2ch mixer leaves 151 cycles in a plain slot and ~76 in a
reserved one; the window (64) plus the notification traffic (~40) plus the
compensation (41–65) does not fit either without re-planning the reservations
— R2 §11.4 step 4 and §11.5 (ROM bank) are still open, and Z80 reads of 68k
work RAM are withdrawn by R2 as a mechanism. Nothing has run on hardware.

## Can the window enter the 2ch schedule, and can a game's 68000 reach it?

Two questions R2 §11.4 step 4 leaves, with numbers.

> **R3 supersedes the second half of this section.** The computed-timing
> conclusions below — "±5 Z80 cycles", "the Z80 side is unchanged", the reading
> of `djnz` as 13 cycles of blindness, and the I/O-only grant as a rule of the
> core — did not survive review or re-measurement. What replaced them is the
> next section; the budget table here still stands.

**The window budget in a mixer slot.** A plain 2ch slot has 151 cycles of pad
and a reserved one 76–87. The cooperative slot's fixed traffic — notify up
(23), notify down (20), commit check (46) — is 89. What is left for the window
itself, after the compensation:

| bytes a grab | 1 | 2 | 4 | 8 |
| --- | --- | --- | --- | --- |
| compensation | ~10 | ~17 | 41 | 65 |
| window in a plain slot | 52 | 45 | 21 | **−3** |
| window in a reserved slot | none | none | none | none |

…and that is before the bank: the notification is a write into 68k work RAM
through the bank window, the mixer needs the window on the sample ROM, and a
bank switch is nine serial writes (~126 cycles) each way. **The window as
prototyped does not enter the 2ch schedule.** What could is a window with no
steady-state notification — the 68000 computing when the window is — which
also removes the bank conflict, since the one notification it needs is at boot.

**Computed timing, measured.** `rom.mjs` gained a 68000 program that reads the
first window opening once at boot, then keeps `rem` — master clocks from the
current HBlank tick to the next opening — from the VDP's V counter (elapsed
lines, so a tick lost while the handler is busy costs nothing), skips and
counts a window already passed, and when one is due before the next tick
busy-waits the remainder and grabs. No polling, no notification. The
instrument measures where the 68000's *request* lands (that it controls
exactly) apart from where the emulator *grants* it.

- **In steady state it tracks to ±5 Z80 cycles**: 85 consecutive windows a
  frame land within 1,665–1,675 of the opening with `rem` varying 374–3,374
  across them — the busy-wait cancels the tick phase exactly. A 64-cycle
  window holds that.
- **Once a frame, at the vblank crossing, the belief is knocked ~228 cycles
  (one line) and recovers over ~10 windows.** Using the VDP's line counter as
  the time base across the vblank reload is where the emulator and the
  arithmetic disagree; the 38-line hypothesis was tested and falsified. The
  real protocol does not depend on it: R2 §3.7 has the 68000 read the Z80's
  published output index at every transfer, so error never accumulates past
  one window.
- **The landing phase is an attractor, and that is a property of fixed
  compensation.** The boot calibration cannot move the steady-state landing
  (1,331 → 1,676 → 1,670 for three very different offsets) because the Z80's
  clock is pulled by (stall − compensation) at every grab until the grab
  phase settles where the two are equal. On hardware the stall varies ±4
  cycles with the M-cycle the request lands on, so the pull is weak; in the
  model it is strong, because —
- **BlastEm grants a pending BUSREQ at the Z80's next I/O access**, which in
  this engine is the next DAC write: the modelled grant phase inside a slot is
  the emulator's scheduling, not an M-cycle boundary. Requests landed 1,670
  after the opening while grants clustered at 256 + k·358. With four YM
  status reads inside the window (`windowSync`, harmless, emulator-only) the
  grant follows the request (14.2% of grants inside vs 1.0% for identical
  requests).

So: a 68000 can reach a 64-cycle window from HBlank without polling, in the
model, to ±5 cycles; a computed-timing run that *passes §6* has not been
produced, because the attractor sits outside the window and the vblank
crossing needs the §3.7 re-anchor. Those are the next two pieces of 68000
work, and they are 68000 work — the Z80 side is unchanged.

**BlastEm is still a model.** It is the reference implementation we are arguing
with while a hardware round is expensive, and it has already found what the
instruction model could not. Nothing here has run on a Mega Drive.

## R3 — the instrument was scoring the wrong thing

R3 §12.2 named four defects and each one turned out to change a result.

**The foreground load never ran.** The 68000's idle load divided `$12345678`
by 7, whose quotient does not fit in 16 bits: DIVU detects the overflow, leaves
the operands alone and exits early, so every iteration took the short path and
the operands never changed. The `load calibration` case now measures it, with
interrupts masked and the Z80 untouched, against a mark pair whose empty body
gives the mark instruction's own cost:

| | mark | `nop` | `divu` /7 | `divu` /7, overflowing | `divu` /$7FFF |
| --- | --- | --- | --- | --- | --- |
| 68000 cycles | 20.0 | 4.0 | **140.4** | **22.3** | 148.3 |

The load was 22 cycles, not 140. With a dividend that divides, the
interrupt-to-entry delay measured from the VDP's own raise (a new probe event)
to the handler's first bus write is:

| load | entry delay, 68000 cycles | ticks lost |
| --- | --- | --- |
| short (`nop`) | 65..86, p50 70 | 0 of 3,304 |
| `divu` that divides | 65..**215**, p50 136 | 0 of 3,304 |
| level 4 masked ~12 lines | 60..**6,027**, p50 1,582 | **1,218 of 3,304** |

So the earlier "±5 cycles under load" was measured under a load of 22-cycle
instructions. (The masked row's minimum is the instrument's pairing floor, not
a latency the machine reached — a tick raised while the previous handler is
still being entered cannot be attributed.)

**The HBlank cases were never checked as transfers.** `analyzeTransfers()` ran
for the notified cases only, so for every HBlank and computed-timing case the
payload, its order, its byte count and the commit went unexamined; the PCM
matched because the PCM does not depend on them. All modes now run the same
checks, and the four ways to break the protocol are injected deliberately
(`--fault`) against a case that passes without them:

| injected fault | what the gate says | exit |
| --- | --- | --- |
| none | 45/45 stops strictly inside the window, 0 carried | 0 |
| `drop-copy` | transferred byte count | 1 |
| `no-commit` | missing or premature transfer commit | 1 |
| `early-commit` | missing or premature transfer commit (PCM still 9,987.56 Hz) | 1 |
| `late-request` | commit adopted by a window it was not written in, 0/45 inside | 1 |

`early-commit` is the one to read twice: the clock is perfect and every sample
is right, and the protocol is broken. A fault that the emitted path would not
reach is refused at build time rather than passing quietly.

**The window is not the notification's lifetime.** The notification brackets
the window by
`(13 − λ) + bankWait + 64 + 4 + λ`, where λ is where inside `ld (nn),a` the
write is timestamped — so the span is 81 + bankWait whatever λ is. Measured, it
is 84, which yields **bankWait = 3** independently of the earlier
`windowWait` measurement, and leaves λ unknown and bounded by 13 cycles. Every
boundary is therefore a band, and the analyzer reports a stop as strictly
inside (inside for every λ) or only loosely inside. A window with a grab in it
is longer by exactly the stall, which is subtracted before the geometry is
taken — taking the median of all of them would have priced the stall into the
window and put every stop outside its own window.

**With those in place, the notification-free cases fail on protocol, not on
timing.** `computed timing 8B, unloaded 68k` at 2 s: mean rate −0.0010%, and
8 stops strictly inside their window, 72 loosely, **2,881 outside**, with
**2,798 commits adopted by a window they were not written in**. That last
number is the failure a fixed compensation cannot survive: a slot repays a
stall that happened somewhere else. Every HBlank and computed case is now a
fatal failure rather than an informational timing miss — 11 of them.

The cooperative regression is unaffected: `cooperative density 8B/5 slots
delay 300` holds 3,449 of 3,449 stops strictly inside, 0 carried, 15,977 B/s,
−0.0000%.

**And the M-cycle explanation was wrong.** BUSREQ is sampled at the end of the
machine cycle in flight, not at the end of the instruction (Zilog Z80 CPU User
Manual, bus request/acknowledge), and a branch-taken `djnz` is 5/4/4, not 13
cycles of blindness. What a nop run buys is a uniform 4-cycle boundary lattice.
The measurement stands on its own — 53..65 cycles of stop under a `djnz`
window against 62.8..68.3 under nops — and the hardware's stop width and mean
residual remain **unmeasured**. `windowSync` is a different ROM with different
bus activity, and its results are not evidence about the plain one.

## The phase contract, and where the notification-free window fails

R3 §12.2 C asks for this table before any more 68000 code. It is filled in with
what was measured. R4 then corrected two of the claims that were made from it,
and this section is the corrected version.

| the contract asks | what there is |
| --- | --- |
| **identifying the target window** | Nothing identifies it. The Z80 publishes no output-boundary number, and R3 already withdrew the idea that one would resolve sub-slot phase anyway. The 68000 can only count windows forward from a single boot notification. |
| **what the Z80 publishes** | Nothing, in the steady state. The one mechanism that costs no bus grab is a write into 68k work RAM through the bank window: 23 Z80 cycles, and in P2 it needs the bank pointed away from the sample ROM — nine serial writes each way, which have to be split across slots. |
| **what the 68000 observes** | The VDP's HV counter, `$C00008`, is the only clock it can read without taking the Z80 bus. Stamped at handler entry, **the widest observed spread of times within one H value was 69–74 master clocks** — over 3,304 entries whose raw latency spans 1,050 master under a divide load, and over 2,059 entries spanning 43,000 master under a masked load with 210 distinct H values. That is evidence the H value carried line-position information in those conditions. **It is not a decoder's error bound**: no decoder exists, and the figure contains nothing about each group's centre, the read-to-mark delay, unobserved H values, or how a line or frame would be identified. |
| **the phase uncertainty** | 68000 entry, uncorrected: 65..215 cycles (divide load), 60..6,027 (masked). Busy-wait granularity: 70 master an iteration. Request→grant in the model: 3..6 Z80 cycles; on hardware, unmeasured. The Z80's own phase moves by `hold − compensation` at every served transfer — see below for what that was measured to do, and for what it was wrongly claimed to do. |
| **what happens when the deadline cannot be met** | Implemented: the handler counts the window and skips rather than requesting late. |
| **the cost on both CPUs** | Opening notification 23, closing notification 20, commit check 46, window 64, and the planned stop itself — **218 Z80 cycles at compensation 65**, against 151 of pad in a plain 2ch slot, before any bank switch. (The same arithmetic as the `151 − 89 − compensation` table above, which leaves −3 for an 8 B window; an earlier draft of this row said "133", which had dropped the closing notification and the stop.) |

**What the residual actually does.** A served slot runs long by
`r = hold − compensation`. Over 5,449 notified transfers in one 3-second run:

| | |
| --- | --- |
| mean | +0.0002 Z80 cycles |
| sd | 1.137 |
| cumulative excursion | **−3.53 .. +2.80**, ending +1.13 |
| block-sum sd at L = 10 / 100 / 1000 | 0.24 / 0.22 / 0.00 — a random walk would give 3.60 / 11.37 / 35.96 |
| autocorrelation | lag 1 +0.139, lag 2 −0.236, lag 10 **+0.867** |

So in the notified engine the residual is **bounded and periodic, not a random
walk**: the block sums do not grow with the block length at all. An earlier
draft of this section took the standard deviation of 1.136 and computed a
790-grab drift out of a ±32-cycle window; that calculation assumed independence
that the autocorrelation refutes, and it is withdrawn. So is the recurrence
`φ_{n+1} = φ_n − r(φ_n)` with gain 1.044 and a repelling fixed point near 54:
its table was indexed by the STOP position while `φ` was the REQUEST position,
and it did not separate the request-to-grant delay, skips, or a compensation
adopted in a different window. The underlying observation — that `r` fell from
+2.40 to −2.37 across stop offsets 0 to 100 over 874 grabs — is kept as an
observation, with no model on top of it.

**Why the notification-free window is suspended anyway.** The suspension does
not rest on any of that. It rests on what the notification-free cases measure:
in `computed timing 8B, unloaded 68k`, 2,881 of 2,961 stops land outside the
window they were computed for; 2,798 commits are read by a window they were not
written in; and, measured independently from the slot's own length, **2,257
windows shortened their pad without having been stalled at all**. Each of those
is also a DAC interval violation — the minimum interval of 4,395 master is
5,376 less one compensation — so the protocol failure and the §6 failure are
the same event seen twice. The notified engine has none of them: 5,449 of
5,449 stops strictly inside, 0 carried, 0 windows repaid without a stall.

Per R4, the next unit is §3.2's **bounded phase correction** as its own P1
prototype, and its first deliverable is a phase OBSERVER with no correction at
all, judged on what it can see. The first candidate to observe is a real Z80
read of the VDP HV counter — which is not assumed to be free, non-stalling, or
even coherent until it has been read.

## The phase observer, step one: the Z80 can read the VDP

R4 §13.3 orders §3.2's bounded phase correction as its own P1 prototype, and
its first deliverable is an OBSERVER with no correction, judged on what it can
see. `observer.mjs` generates one, as extra work inside `gen-stream.mjs`'s own
slots — so it rides the real mixer, the real CSM traffic and the real pad
arithmetic, and a reading that does not fit is a slot overrun at generation
time rather than a second loop that happens to have room.

**It is affordable.** `ld a,($7F09)` costs 13 cycles plus the 3 this core
charges for reaching the 68k bus — the same penalty the bank window pays. Every
observer case passes §6 at 9,987.57 Hz, −0.0000%, intervals 5,370..5,385
master, with the 68000 idle and with it running the corrected divide load:

| schedule | worst slot without | with H + store (29 cyc) | with V+H + store (45 cyc) |
| --- | --- | --- | --- |
| complete 2ch budget, CSM on | 79.6% | **87.7%** | **92.2%** |

That is the comparison that matters: the notified transfer window needs 218
cycles into 151 of pad and does not fit, and an observer that reads the VDP
does.

**H carries the line position; V identifies the line.** In the 2ch schedule,
which reads sixteen times a loop and so samples many phases, **210 distinct H
values were observed and the widest observed spread of times within one value
was 15 master clocks** — one Z80 cycle. V gave 232 distinct values with a
spread of a whole line, which is what a line number is. Both are observations
about these runs and neither is a decoder's error bound; there is no decoder
yet.

**The read positions are a lattice, not a sample of the line.** Both clocks are
exact rational multiples of the master clock, so a fixed schedule reads HV at a
finite set of phases forever — 57 of them in the 5-slot P1 loop, where the
spread within a value is therefore 0. That is a property of the sampling, not a
resolution. It is also good news for a decoder, which only ever has to decode
the phases its own schedule produces.

**A V+H pair is not a snapshot.** The two reads are two bus accesses exactly 16
Z80 cycles apart. Reading H twice moves it by a median of 15 units, with
extremes of +61 and −242 — the counter's jump inside the line and its wrap at
the end of it.

**What this is not.** In the core in use, each read also charges the 68000 8 of
its own cycles, and that core's comment says the 68000-side delay is an
estimate wanting a fresh logic-analyzer capture. Nothing here has run on
hardware, where Z80 access to the VDP is a documented hazard area rather than a
free clock. The decoder itself — value to time, line and frame identification,
the counter's discontinuities, missing readings, restart — is step 3 and does
not exist.

## The phase decoder: what H settles, and what it cannot

R4 §13.3 step 3 asks whether the observer can decide the phase from what it can
see. `decoder.mjs` is that decoder and `npm run dac-stream:decoder` is the
harness. **Step 3 is not finished**, and the earlier summary of it — "H alone is
enough", "missed shifts 0" — was withdrawn under R5 §15.2 B: it scored a
displacement of a whole line as a true negative, because the truth was wrapped
into a line before the comparison.

**What it is allowed to use.** The byte the Z80 read, the read's index, and its
own state. The instrument's clock appears in `scoreDecode()` and nowhere else.
The read spacing comes from `generateObserver()`'s laid-out slots — a spacing
learned from the log being scored could normalise a wrong nominal away — and the
run's medians are then required to agree with it. Three chip constants are
calibrated (line origin, H → phase, V → line) **from three runs used for nothing
else**; the nine verification runs are logs those tables have never seen, and a
log is only used when its rom hash, core and duration match the case that
produced it. That last check is not a formality: it caught three stale logs in
the output directory being read as fresh results.

**Three claims, scored apart.**

| | what it means | measured |
| --- | --- | --- |
| in-line displacement | how well the displacement between two adjacent reads is measured, **modulo one line** | worst error 9–18 master (0.6–1.2 Z80 cycles) across nine verification runs; every estimate inside tolerance |
| visible at all | how many real displacements the decoder could see, counted **before** the modulus | verification set: every displacement seen, none past half a line. 64 B stall run: 712 displacements, **all past half a line**, all reported the short way round |
| offset claim | the running phase error, which is also only known modulo a line | agrees on every read where sync was claimed valid — in the verification set, where nothing passed half a line |

**H cannot invalidate its own claim.** In the 64 B stall run the decoder called
sync valid on all 3,793 reads while the real un-wrapped offset reached
**4,222,388 master clocks**. Nothing in the reading says so: a displacement of
exactly one line leaves H unchanged, and one past half a line comes back the
short way round. So an H-only contract needs two things it does not have yet —
an external guarantee that the displacement between adjacent reads stays under
half a line, and a re-synchronisation route for when that guarantee lapses.
Until both exist, no transfer window can be published from this.

**V is not the answer as it stands.** It would extend the range to a frame, but
33 of the 256 V values answer to two lines six apart, so 575 of a clean run's
3,951 reads are undecidable — reported as a candidate pair, never chosen — and
the first reading of a run may be one of them, in which case no origin is fixed
at all. The V+H decode is also not scored against the instrument here: while a
reading is ambiguous the decode carries its prediction forward, so its residual
and the instrument's difference are measured from different points. Fixing that
comparison is open work.

The reference decoder's own table is `Int16Array(256)` — **512 bytes**, not the
256 an earlier note claimed — and holds 0..3,419 with −1 for the 46 values never
observed. The Z80 carries a quantised one-byte copy instead (20 master a unit,
171 units a line, `$ff` for a value the calibration never saw), and its worst
in-line error against the reference is **40 master (2.7 Z80 cycles)** — the
earlier "precision unchanged" is withdrawn. Nothing has run on hardware, where
the H → phase table would have to be calibrated again.

## The decoder on the Z80: what it costs and where it does not fit

`observer.mjs` emits the decode as costed ops and `decode-split.mjs` emits the
same decode cut into pieces. Both are checked by assembling them and running
every input through the emulator, not by counting cycles by hand.

**The state is three positions, not two.** `KNOWN` and `VALID` are published as
masks: `$00/$00` means the reading was not in the table and the chain is broken;
`$ff/$00` means a base to measure the *next* reading from; `$ff/$ff` means the
displacement is a real difference between two consecutive known readings.
`VALID` is one AND of two masks, `DELTA` is masked by it, and `EXPECT` is masked
by `KNOWN`, so an invalid number is never left where a valid one is read. An
earlier version had no acquisition state at all: it published a difference from
the very first reading, and ran an unknown reading through the same arithmetic,
so the next good reading differed from a number made out of `$ff`.

**One slot: 283 cycles, 69 B.** With the VDP read (16) and P1's own output (18)
that is 317 of a 358-cycle slot — **88.5%**, not the 79.1% the 249-cycle version
without the acquisition gate reported. Every path costs the same; the three
reductions are branch-free masks (`add a,256-n` then `sbc a,a`), which is also
what makes them divisible.

**The diagnostic build is a different rom.** It publishes the five-field record
— `KNOWN, VALID, DELTA, COUNTLO, COUNTHI` — to five *separate* addresses in the
bank window, spread across the group's later slots so the record closes before
the next read. The instrument requires exactly that: fields in order, after
their own read and before the next one, with one unfinished record allowed at
the end of a run and nowhere else. Three generated faults (`drop-field`,
`double-field`, `carry-publish`) exist to show the check refusing, and the
classification itself is driven by synthetic logs in the selftest.

**In the complete 2ch engine it does not fit, and the reason is granularity.**
A slot boundary destroys `A` and the flags — `mix_one` runs in every slot and it
is the sample path — so the split version keeps everything in memory and in
`BC`, and costs **501 cycles in 21 pieces**. The complete 2ch+CSM loop has
687.9 cycles of headroom to the 79.6% target, which is more than 501; but 19 of
the 21 pieces need a slot with ≥17 cycles free and only **5 slots** have that.
The placement fails at the fourth piece. Thinning the observation rate does not
help: the loop is statically unrolled, so a piece placed in a slot runs every
lap whatever uses its result. The whole sequence first places at a **83.9%**
per-slot ceiling, in one lap, 7.51 ms from the reading to the finished record.

The phase table has no home either: the complete map's free space is 176 B
inside the code reservation, 96 B unreserved and 122 B inside the globals — no
page-aligned 256 B block anywhere, and the largest contiguous run obtainable is
217 B.

## The three structural decisions

**1. The slot boundary IS the DAC write.** Each output interval begins with
`ld (de),a`, so the interval between two writes is the slot's length by
construction. Work placed after it delays only the pad, never the next sample.
That is what makes "does CSM change the PCM period?" answerable by reading the
generated code rather than by measuring and hoping.

**2. There is no interrupt, and there is no phase reference either.** The Z80
runs with interrupts disabled from boot and never takes a vblank (§3.1 adopts
this in R1). The DAC's clock is the instruction stream: five slots are 1,792
cycles *exactly*, so the average carries no error to accumulate.

An earlier version of this file called Timer B the phase reference. **That is
withdrawn** (§3.2, R1). Reading the overflow flag answers "did *any* overflow
happen since the reset", so the reset→read window has to be shorter than one
timer period for the answer to constrain anything — and it never was, at any
cadence tried. The gate now measures the window and says so:

    Timer B traffic (NOT a phase reference, §3.2 R1): 9988 reads, flag seen 100%
      · reset→read window 1739 cyc vs a 1075.2 cyc period — CANNOT carry information

Timer B's traffic remains available as a **YM load case** and is off in the
normal profile. The engine has no wall-clock phase information at all; only the
instrument does, and the numbers it reports (time from a real overflow to the
engine's read) are not the DAC's phase error and not any estimator's error.
The 68000 gets the time from the published output index instead (§3.7).

The alternative was measured on paper and rejected: a vblank ISR is ~90 cycles
landing anywhere inside a 358-cycle slot, a quarter of the period against a 5%
tolerance. Reserving room for it in *every* slot costs 25% of the budget for an
event that happens once per 167 samples.

**3. The pad is arithmetic, not a coefficient.** `schedule.mjs` solves for an
instruction sequence costing *exactly* the cycles the slot has left — a `djnz`
loop for the bulk and a short exact tail — and throws if it cannot. There is no
`PAD_FRACTION` and no per-song tuning. A slot that overruns is an error at
generation time.

## The files

| file | what it is |
| --- | --- |
| `lut.mjs` | the level family, the clamp table, and the arithmetic that DEFINES both. The gate's reference computes from that arithmetic and **never indexes the generated tables** (§3.4, R1) — a reference that read them could not fail on a table that is wrong. `tablesAgree()` checks the tables against the same arithmetic as a separate assertion |
| `config.mjs` | **the one configuration object.** Clocks, profile, RAM map, YM registers, the settling table. Nothing reads an environment variable; a config is passed in, hashed, and its stamp goes into every artifact it produced. |
| `schedule.mjs` | the placement engine: exact-cost ops, the pad solver, the placement table |
| `gen-stream.mjs` | generates the Z80 source and the per-path cycle table |
| `observer.mjs` | the phase observer: the VDP read, the Z80 decode as costed ops, its RAM ownership, its boot initialisation, the published record and the faults that break it |
| `decode-split.mjs` | the same decode cut into pieces a complete 2ch slot could hold, and the walk that tries to place them |
| `corrector.mjs` | the bounded phase corrector: its arithmetic, the nine-bit debt and its ±112 limit, the seven `jr` ladders and the five ways to break it |
| `protocol.mjs` | **the 68k/Z80 runtime protocol's one layout.** The 5-byte snapshot, the host's control block, the ordered writes each side makes, the wrap rule of every counter, the queue's records — and the Z80 equates, C header and JS model all emitted from it, so no offset is written down twice |
| `proto-blocks.mjs` | the protocol as Z80 code: the host-control check, the snapshot publication and the logical position's advance, in one-slot pieces and in P1's single-block form |
| `semantic.mjs` | **what the 41 scores mean**: the corpus read out of `c-gate`'s own argument list, the fold into five commands, the unfold that checks it byte for byte, and the per-score voice, density and lead figures |
| `transport.mjs` | **two transports priced against the writer and the bus**: what a byte of Z80 RAM costs inside a grab, what the mailbox leaves, the wire each candidate needs, and the search that says which pipeline is short and by how much |
| `ym-writer.mjs` | **the Z80 YM writer**: the inline site and why it cannot be a subroutine, the six-word entry, the sequences §59.5 runs, the fixture negatives, the rule that a frequency pair may not straddle a block, and the priced comparison of every candidate against the 280-cycle / 120-byte reservation |
| `command.mjs` | the PCM state MAILBOX: the host-side encoder that holds the waiting list on extended observation numbers and coalesces three level changes at one boundary into one bundle, the JS reference consumer, the branch-free Z80 pieces that make one decision a lap without touching main BC, and the packer that lays them into the b9/b10 positions the reservation owns |
| `split-report.mjs` | what the distributed image costs, printed from the image itself: pieces, worst slot, mean, ladders, DAC interval, the code ledger and the four limits judged independently |
| `decoder-eval.mjs` | the BlastEm harness for the observer, the corrector and the runtime protocol on both CPUs |
| `machine.mjs` | the emulated machine and the instrument: RAM, the YM's four ports with a real timer model, the 68000's bus grab as injectable stopped time, and a 64-bit-safe trace |
| `analyze.mjs` | VALUE, TIME and BUS, kept apart; plus the chip's settling table, checked |
| `spectrum.mjs` | the §6.3 comparison: the same bytes on a uniform grid vs at their real write times |
| `gate.mjs` | the §6 acceptance thresholds, fixed before the first measurement |
| `cooperative.mjs` | the P1 notified-window engine, and the window geometry every analysis reads |
| `case-config.mjs` | **one resolved case.** The CLI's overrides are applied once, and the object that is generated, run, analyzed and written to JSON is the same object (§12.3) |
| `rom.mjs` | the 68000 side: bootstrap, the transfer paths, the foreground loads, the instruction-time calibration, and the deliberate protocol faults |
| `machine-probe.mjs` | runs a case on BlastEm and reports it. `--strict` makes every case required; `--fault`, `--marks`, `--compensation`, `--capture-offset` |
| `probe-analysis.mjs` | the probe log: DAC timing, window generations, transfers in every mode, and the 68000's own timeline |
| `probe-selftest.mjs` | proves each of those can fail — including, with `--machine`, that every injected fault leaves the CLI non-zero |

Generated sources and the JSON report land in `drv/out/dac-stream/`.

## Three bugs this found, all outside the prototype

They are listed because each was invisible to every gate in the repository, and
two of them change numbers that other work rests on.

**1. `$` meant the address of the NEXT instruction** (`tools/z80asm.mjs`). So
`djnz $` assembled as a jump *past* itself: a 26-iteration pad loop that ran
once, a sample clock 4.5× too fast, and no error anywhere. The header of that
file promises sjasmplus syntax, where `$` is the current instruction's address.
Fixed, with `db`/`dw` keeping the older item-by-item meaning that `selftest`
pins, and a new selftest case for the three forms a pad uses.

**2. Every `(HL)` operand was charged 3 cycles too few** (`tools/z80cpu.mjs`).
`ld r,(hl)`, `ld (hl),r` and `alu a,(hl)` are 7 T-states, not 4; `ld (hl),n` is
10, not 7. The emulator returned the register-to-register figures. **The PCM
mixer's hot loop is `ld a,(hl)` and `add a,(hl)`**, so every cycle budget in
this repository — `mixer-bench`, `frame-budget`, `PAD_TARGET`, `EMIT_CYCLES`,
and the measurements quoted in `.claude/memory/plan-68k-split.md` — was computed
against an under-charged model. Fixed, with a selftest that pins the documented
counts. Re-running the P0 baseline across the fix moves the modelled DAC
delivery on `m3-pcm-softmix` from 98.3% to 99.1% and on `m2-pcm` from 63.2% to
75.9%: the engine's own numbers move, which is the point.

**3. A pad filler destroyed the sample in flight.** `ld a,0` is the pad
solver's only odd-cost filler, and the sample fetch used to sit *before* the
pad. At 9,987.6 Hz the pads happened to be a bare `djnz` and nothing showed; at
3,329 Hz the tail took an `ld a,0` and every other sample went out as zero. The
fetch now runs after the pad, which is also what makes an odd residual paddable
at all. It is in this list because the gate caught it only because a *second*
profile was in the case list — one clock would have passed.

## What is NOT done

- **No notification-free transfer works.** Every HBlank and computed-timing
  case fails, and after R3 they fail on protocol: the request lands outside
  the window it was computed for and the commit is adopted by a window it was
  not written in. The notified P1 window is the only transfer that holds, and
  it does not fit a 2ch slot (the budget table above). The phase contract
  R3 §12.2 C asks for — which window is being aimed at, what the Z80 publishes,
  what the 68000 can observe, the uncertainty, what happens when the deadline
  cannot be met, and the cost on both CPUs — is **not written**, and no further
  68000 work should start before it is.
- **The hardware stop width is unmeasured.** Every stop figure here is
  BlastEm's arbitration model. The nop window narrowed it in that model; what
  silicon does, and what the mean residual is at 2,000 grabs a second, is the
  number a hardware round has to return.
- **P2 is not finished.** §5's order is 1ch → 2ch → independent volume →
  master → loop → ROM bank boundary, and it stops after the master. There is
  **no loop, no ROM bank crossing, and no note start or stop**: the source is
  one 256-byte page per voice and `inc e` / `inc ixl` wraps it, which is why
  nothing here needs a `left` counter or a bank register yet. Those are the
  next three cases, and each of them is boundary work that has to be split
  into constant-time pieces before it can go in a slot.
- **The ROM bank question above is unanswered**, and it decides whether the
  interleaved per-sample mixer survives contact with real sample data.
- **A third voice has not been tried.** §5/P5 says one dimension at a time,
  and the two-voice normal slot is at 57.8% — a third adds ~90 cycles, which
  is 25 more points, and the block edge slot is already at 79.6%.
- **No command protocol, no host transfer** (P3). Level changes arrive as the
  harness poking Z80 RAM at a chosen cycle, which is the 68000's write
  *without* the bus grab it would really cost. The bus-grab case exists to
  prove the instrument can see a grab, not to claim anything about §3.6. It is
  reported as informational and is excluded from the pass: a 700-cycle grab
  makes a hole of up to 2.95 sample periods, which is exactly the problem §3.6
  says to measure rather than assume away.
- **Nothing has run on hardware.** §6.4's third column is empty; the BlastEm
  column is now filled for the schedules above, at a light 68000 load only.
- **The 68000's bus grab is measured but not solved.** The informational case
  takes the bus on a schedule and the DAC loses 2.06% of its rate with holes to
  1.61T. That is §3.6's question and it has not been answered.
- The 60-second representative case runs; the 10-minute one in §6.2 does not
  (the trace is held in memory, and that is the thing to change first if it is
  wanted — the cycle stamps themselves are already 64-bit-safe doubles).
