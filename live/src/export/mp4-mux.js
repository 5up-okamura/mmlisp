// A minimal MP4 writer for the video export: one H.264 track and one AAC
// track, as WebCodecs' encoders hand them out, into a plain (unfragmented)
// file with the index (moov) ahead of the data — what X, QuickTime and the
// browsers' <video> all take. Timestamps are the encoders' chunk timestamps
// in microseconds, each track made relative to its first sample; a sample
// lasts until the next one, so a frame the page could not draw in time is
// held rather than squeezed out.
//
//   const mux = new Mp4Muxer();
//   mux.addVideo(chunk, meta);   // VideoEncoder output (avc format 'avc')
//   mux.addAudio(chunk, meta);   // AudioEncoder output (aac format 'aac')
//   const blob = mux.finish();   // after both encoders flushed
//
// Boxes follow ISO/IEC 14496-12 (file format), 14496-15 (avcC) and 14496-1
// (the esds descriptors); every field a reader checks is written, nothing
// optional is.

const VIDEO_TIMESCALE = 90000; // divides 1 s evenly for 24, 25, 30 and 60 fps

export class Mp4Muxer {
  constructor() {
    this.video = { samples: [], config: null, width: 0, height: 0, timescale: VIDEO_TIMESCALE };
    this.audio = { samples: [], config: null, rate: 0, channels: 0, timescale: 0 };
  }

  addVideo(chunk, meta) {
    const t = this.video;
    if (meta?.decoderConfig) {
      t.config = meta.decoderConfig;
      t.width = meta.decoderConfig.codedWidth || t.width;
      t.height = meta.decoderConfig.codedHeight || t.height;
    }
    t.samples.push(sampleOf(chunk, chunk.type === 'key'));
  }

  addAudio(chunk, meta) {
    const t = this.audio;
    if (meta?.decoderConfig) {
      t.config = meta.decoderConfig;
      t.rate = meta.decoderConfig.sampleRate;
      t.channels = meta.decoderConfig.numberOfChannels;
      t.timescale = t.rate;
    }
    t.samples.push(sampleOf(chunk, true));
  }

  // The file as a Blob; the sample data is referenced, not copied again.
  finish() {
    const tracks = [];
    if (this.video.samples.length && this.video.config) tracks.push(videoTrack(this.video));
    if (this.audio.samples.length && this.audio.config) tracks.push(audioTrack(this.audio));
    if (!tracks.length) throw new Error('nothing recorded');
    tracks.forEach((t, i) => { t.id = i + 1; });
    // Samples go into mdat in time order across the tracks, each its own
    // chunk; stco needs their offsets, which need moov's size, which does
    // not depend on the offsets' values — so build moov twice.
    const order = [];
    for (const t of tracks) t.samples.forEach((s, i) => order.push({ t, s, i, at: s.time / t.timescale }));
    order.sort((a, b) => a.at - b.at || a.t.id - b.t.id);
    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    let mdatSize = 8;
    for (const o of order) mdatSize += o.s.data.byteLength;
    const layout = (dataStart) => {
      let off = dataStart;
      for (const o of order) { o.t.offsets[o.i] = off; off += o.s.data.byteLength; }
      return moovBox(tracks);
    };
    const probe = layout(0);
    const moov = layout(ftyp.byteLength + probe.byteLength + 8);
    const mdatHeader = concat(u32(mdatSize), str('mdat'));
    return new Blob([ftyp, moov, mdatHeader, ...order.map((o) => o.s.data)], { type: 'video/mp4' });
  }
}

function sampleOf(chunk, sync) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { data, us: chunk.timestamp, sync, time: 0 };
}

// Per-track sample times (in the track's timescale) and durations, from the
// chunks' microsecond timestamps made relative to the first.
function timeSamples(t, lastDuration) {
  const s = t.samples;
  const t0 = s[0].us;
  for (const x of s) x.time = Math.max(0, Math.round(((x.us - t0) * t.timescale) / 1e6));
  for (let i = 0; i < s.length; i++) {
    s[i].dur = i + 1 < s.length ? Math.max(1, s[i + 1].time - s[i].time) : lastDuration;
  }
  t.duration = s[s.length - 1].time + lastDuration;
  t.offsets = new Array(s.length).fill(0);
}

function videoTrack(v) {
  // The last frame lasts as long as the typical one.
  const durs = v.samples.slice(1).map((s, i) => s.us - v.samples[i].us);
  const typical = durs.length ? Math.round((median(durs) * v.timescale) / 1e6) : v.timescale / 30;
  timeSamples(v, Math.max(1, typical));
  const avcC = box('avcC', new Uint8Array(v.config.description));
  const entry = box('avc1',
    new Uint8Array(6), u16(1), // reserved, data_reference_index
    u16(0), u16(0), new Uint8Array(12), // pre_defined, reserved, pre_defined
    u16(v.width), u16(v.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), // 72 dpi, reserved, frame_count
    new Uint8Array(32), // compressorname (empty)
    u16(0x18), u16(0xffff), // depth, pre_defined
    avcC);
  return { ...v, kind: 'vide', name: 'VideoHandler', entry, mediaHeader: fullBox('vmhd', 1, u16(0), u16(0), u16(0), u16(0)) };
}

function audioTrack(a) {
  const asc = new Uint8Array(a.config.description);
  const frameLen = (asc.length >= 2 && (asc[1] & 0x04)) ? 960 : 1024; // AAC frame, per the ASC's frameLengthFlag
  timeSamples(a, frameLen);
  const bitrate = a.config.bitrate || 0;
  const dsi = descriptor(0x05, asc);
  const dcd = descriptor(0x04, concat(
    new Uint8Array([0x40, 0x15]), new Uint8Array([0, 0, 0]), // AAC, audio stream; bufferSizeDB
    u32(bitrate), u32(bitrate), dsi));
  const esd = descriptor(0x03, concat(u16(0), new Uint8Array([0]), dcd, descriptor(0x06, new Uint8Array([0x02]))));
  const esds = fullBox('esds', 0, esd);
  const entry = box('mp4a',
    new Uint8Array(6), u16(1), // reserved, data_reference_index
    u16(0), u16(0), u32(0), // version, revision, vendor
    u16(a.channels), u16(16), u16(0), u16(0), // channels, sample size, compression id, packet size
    u32(a.rate << 16),
    esds);
  return { ...a, kind: 'soun', name: 'SoundHandler', entry, mediaHeader: fullBox('smhd', 0, u16(0), u16(0)) };
}

function moovBox(tracks) {
  const movieScale = 1000;
  const movieDuration = Math.max(...tracks.map((t) => Math.round((t.duration * movieScale) / t.timescale)));
  const mvhd = fullBox('mvhd', 0,
    u32(0), u32(0), u32(movieScale), u32(movieDuration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), // rate, volume, reserved
    matrix(), new Uint8Array(24), u32(tracks.length + 1));
  return box('moov', mvhd, ...tracks.map((t) => trakBox(t, movieScale, movieDuration)));
}

function trakBox(t, movieScale, movieDuration) {
  const isVideo = t.kind === 'vide';
  const tkhd = fullBox('tkhd', 3, // enabled, in movie
    u32(0), u32(0), u32(t.id), u32(0),
    u32(Math.round((t.duration * movieScale) / t.timescale)),
    u32(0), u32(0), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
    matrix(),
    u32(isVideo ? t.width << 16 : 0), u32(isVideo ? t.height << 16 : 0));
  const mdhd = fullBox('mdhd', 0, u32(0), u32(0), u32(t.timescale), u32(t.duration), u16(0x55c4), u16(0)); // 'und'
  const hdlr = fullBox('hdlr', 0, u32(0), str(t.kind), new Uint8Array(12), str(t.name), new Uint8Array(1));
  const dinf = box('dinf', fullBox('dref', 0, u32(1), fullBox('url ', 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, u32(1), t.entry),
    sttsBox(t.samples),
    ...(isVideo ? [stssBox(t.samples)] : []),
    fullBox('stsc', 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.data.byteLength))),
    fullBox('stco', 0, u32(t.offsets.length), ...t.offsets.map((o) => u32(o))));
  const minf = box('minf', t.mediaHeader, dinf, stbl);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

function sttsBox(samples) {
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.dur) last[0]++;
    else runs.push([1, s.dur]);
  }
  return fullBox('stts', 0, u32(runs.length), ...runs.map(([n, d]) => concat(u32(n), u32(d))));
}

function stssBox(samples) {
  const keys = [];
  samples.forEach((s, i) => { if (s.sync) keys.push(i + 1); });
  return fullBox('stss', 0, u32(keys.length), ...keys.map((k) => u32(k)));
}

// ---- bytes ----
function u16(v) { return new Uint8Array([(v >> 8) & 0xff, v & 0xff]); }
function u32(v) { return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]); }
function str(s) { return new TextEncoder().encode(s); }
function matrix() { return concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)); }
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
function box(type, ...parts) {
  const body = concat(...parts);
  return concat(u32(8 + body.byteLength), str(type), body);
}
function fullBox(type, flags, ...parts) {
  return box(type, u32(flags & 0xffffff), ...parts); // version 0 in the top byte
}
// An MPEG-4 descriptor: tag, then the length in the 4-byte expandable form.
function descriptor(tag, body) {
  const n = body.byteLength;
  return concat(new Uint8Array([tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]), body);
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
