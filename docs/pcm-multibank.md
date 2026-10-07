# Multi-bank PCM

A song can use more than 32 KiB of PCM sample data, with up to three voices playing samples from different banks simultaneously. Pitch remains baked into a separate sample for each note; runtime pitch changes are not supported.

## Exporting a song

For NTSC and PAL songs with up to three PCM voices, MMB export automatically selects the multi-bank format when the samples exceed the single-bank capacity. Smaller songs retain their normal format and sample rate. Browser preview and WAV/VGM export also support multi-bank samples.

```sh
cd drv
node tools/mmb-build.mjs path/to/song.mmlisp out/song.mmb
```

Export produces an `.mmb` score and a `.smp` sample file. Keep them together and use files from the same export. The MMB score itself still has a separate 32 KiB limit.

To choose the multi-bank engine even when the samples fit in one bank:

```sh
node tools/mmb-build.mjs path/to/song.mmlisp out/song.mmb --multibank
```

One and two voices run at about 10.1 kHz on NTSC and 10.0 kHz on PAL. Three voices run at about 6.65 kHz on NTSC or 6.59 kHz on PAL. Switching from the default one-voice engine at 14,375.683 Hz rebakes the samples at the lower rate, so do not reuse its old SMP file.

## Using the SGDK driver

Install or update the driver and compile the song:

```sh
node tools/install-sgdk.mjs /path/to/project --song path/to/song.mmlisp
```

Add `--multibank` to select the new engine explicitly. The installer copies the additional engine header, `mmlispdrv_banked_bin.h`, into the project.

Declare the resources with an uncompressed sample file aligned to 32 KiB:

```text
BIN song_mmb "song.mmb" 2
BIN song_smp "song.smp" 32768
```

The loading API is unchanged:

```c
MMLisp_init();
MMLisp_setSampleBank(song_smp);
if (!MMLisp_loadScore(song_mmb)) {
    /* Handle score-loading failure. */
}
```

Use the usual frame, interrupt, and song-start calls described in the [SGDK guide](../drv/sgdk/README.md). Loading the matching MMB selects the required engine. The loader rejects a sample file whose format or rate does not match the score.

## PAL export

Add `--pal` to the build or installer command for a PAL target:

```sh
node tools/mmb-build.mjs path/to/song.mmlisp out/song.mmb --pal
node tools/install-sgdk.mjs /path/to/project --song path/to/song.mmlisp --pal
```

The exporter converts song timing to 50 Hz and bakes PCM for the PAL engine.
The driver selects the PAL image from the MMB header. PAL and NTSC sample files
have different rate stamps and cannot be mixed. For programmatic builds, pass
`frameHz: 50`; for bundles, use `node tools/bundle.mjs manifest.json out --pal`.

## Bundles and programmatic export

Bundles automatically expand when their combined samples exceed the single-bank limit. To select the format explicitly, set `"multibank": true` in the bundle manifest. Set it to `false` to require a single bank and report an error if the samples do not fit.

The `encodeMmb` and `buildMmb` APIs accept the equivalent `multibank: true/false` option. Omitting the option allows automatic expansion.

## Capacity and playback limits

- Multi-bank playback supports one, two, or three voices on both NTSC and PAL.
- At most 256 sample entries are available. Each note-specific baked copy counts as an entry; identical blobs can share storage.
- Each individual baked blob must fit within 32,512 bytes. A long sample cannot span banks, even when the combined library has room.
- Samples retain 16-byte loop granularity. Loops, release, volume, master attenuation, and retriggers remain available.
- The sample directory occupies one 32 KiB bank. Sample banks also reserve their final 256 bytes for silence. The complete SMP file therefore includes padding beyond the actual sample bytes.
- All resources must fit in the driver's 4 MiB ROM aperture, including score data, code, and the sample directory.
- The four distinct banked code spans occupy 12,281 ROM bytes and share a 2,560-byte table block with the single-bank profiles. Identical PAL/NTSC code shares storage. Only the selected code and the shared tables are uploaded to the Z80.

Dense FM instrument changes can still delay note onsets. Multi-bank playback does not guarantee perfectly simultaneous onsets; check timing in the target application. Real hardware and heavy DMA workloads have not yet been validated.

For binary layouts and command payloads, see the [MMB format](mmb.md#103-multi-bank-sample-resources) and [driver specification](driver.md#54-sample-banking).
