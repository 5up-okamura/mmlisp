# Multi-bank PCM

A song can use more than 32 KiB of PCM sample data, with one or two voices playing samples from different banks simultaneously. Pitch remains baked into a separate sample for each note; runtime pitch changes are not supported.

## Exporting a song

For NTSC songs with one or two PCM voices, MMB export automatically selects the multi-bank format when the samples exceed the single-bank capacity. Smaller songs retain their normal format and sample rate. Browser preview and WAV/VGM export also support multi-bank samples.

```sh
cd drv
node tools/mmb-build.mjs path/to/song.mmlisp out/song.mmb
```

Export produces an `.mmb` score and a `.smp` sample file. Keep them together and use files from the same export. The MMB score itself still has a separate 32 KiB limit.

To choose the multi-bank engine even when the samples fit in one bank:

```sh
node tools/mmb-build.mjs path/to/song.mmlisp out/song.mmb --multibank
```

Both multi-bank engines run at 10,111.709 Hz. Switching from the default one-voice engine at 14,375.683 Hz rebakes the samples at the lower rate, so do not reuse its old SMP file.

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

## Bundles and programmatic export

Bundles automatically expand when their combined samples exceed the single-bank limit. To select the format explicitly, set `"multibank": true` in the bundle manifest. Set it to `false` to require a single bank and report an error if the samples do not fit.

The `encodeMmb` and `buildMmb` APIs accept the equivalent `multibank: true/false` option. Omitting the option allows automatic expansion.

## Capacity and playback limits

- Multi-bank playback supports NTSC and one or two PCM voices. Three-voice and PAL songs continue to use the single-bank format.
- At most 256 sample entries are available. Each note-specific baked copy counts as an entry; identical blobs can share storage.
- Each individual baked blob must fit within 32,512 bytes. A long sample cannot span banks, even when the combined library has room.
- Samples retain 16-byte loop granularity. Loops, release, volume, master attenuation, and retriggers remain available.
- The sample directory occupies one 32 KiB bank. Sample banks also reserve their final 256 bytes for silence. The complete SMP file therefore includes padding beyond the actual sample bytes.
- All resources must fit in the driver's 4 MiB ROM aperture, including score data, code, and the sample directory.
- The additional engine images occupy 13,824 bytes of ROM in total. Only the selected image is uploaded to the Z80.

Dense FM instrument changes can still delay note onsets. Multi-bank playback does not guarantee perfectly simultaneous onsets; check timing in the target application. Real hardware and heavy DMA workloads have not yet been validated.

For binary layouts and command payloads, see the [MMB format](mmb.md#103-multi-bank-sample-resources) and [driver specification](driver.md#54-sample-banking).
