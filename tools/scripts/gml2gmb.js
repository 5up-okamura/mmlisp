#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  SECTION,
  OPCODE,
  TARGET_ID,
  u16le,
  u32le,
  i16le,
  alignBuffer,
  parsePitchToByte,
} = require("./gmb_common");

function usage() {
  console.error(
    "Usage: node scripts/gml2gmb.js <input.ir.json> [--out <file.gmb>] [--meta <file.txt>] [--target-profile <name>]",
  );
}

const VALID_ROLES = new Set(["bgm", "se", "modulator", "chaos"]);

function encodeString(str) {
  return Buffer.from(String(str), "utf8");
}

function ensureU8(value, label) {
  if (value < 0 || value > 255) {
    throw new Error(`${label} is out of u8 range: ${value}`);
  }
  return value & 0xff;
}

function ensureU16(value, label) {
  if (value < 0 || value > 65535) {
    throw new Error(`${label} is out of u16 range: ${value}`);
  }
  return value & 0xffff;
}

function buildTrackMaps(track) {
  const markerMap = new Map();
  const loopMap = new Map();
  let nextMarkerId = 1;
  let nextLoopId = 1;

  for (const event of track.events || []) {
    if (event.cmd === "MARKER") {
      const id = event.args?.id;
      if (id && !markerMap.has(id)) {
        markerMap.set(id, ensureU8(nextMarkerId, "marker id"));
        nextMarkerId += 1;
      }
    }
    if (event.cmd === "LOOP_BEGIN") {
      const id = event.args?.id;
      if (id && !loopMap.has(id)) {
        loopMap.set(id, ensureU8(nextLoopId, "loop id"));
        nextLoopId += 1;
      }
    }
  }

  return { markerMap, loopMap };
}

function encodePayload(event, trackMaps) {
  const args = event.args || {};
  switch (event.cmd) {
    case "NOTE_ON": {
      const pitch = parsePitchToByte(args.pitch || "c4");
      const length = ensureU16(args.length ?? 0, "NOTE_ON length");
      return Buffer.concat([Buffer.from([pitch]), u16le(length)]);
    }
    case "REST": {
      const length = ensureU16(args.length ?? 0, "REST length");
      return u16le(length);
    }
    case "TIE": {
      const length = ensureU16(args.length ?? 0, "TIE length");
      return u16le(length);
    }
    case "TEMPO_SET": {
      const bpm = ensureU16(args.bpm ?? 0, "TEMPO_SET bpm");
      return u16le(bpm);
    }
    case "MARKER": {
      const id = args.id;
      if (!trackMaps.markerMap.has(id)) {
        throw new Error(`MARKER id not mapped: ${id}`);
      }
      return Buffer.from([trackMaps.markerMap.get(id)]);
    }
    case "JUMP": {
      const to = args.to;
      if (!trackMaps.markerMap.has(to)) {
        throw new Error(`JUMP target marker not mapped: ${to}`);
      }
      return Buffer.from([trackMaps.markerMap.get(to)]);
    }
    case "LOOP_BEGIN": {
      const id = args.id;
      if (!trackMaps.loopMap.has(id)) {
        throw new Error(`LOOP_BEGIN id not mapped: ${id}`);
      }
      return Buffer.from([trackMaps.loopMap.get(id)]);
    }
    case "LOOP_END": {
      const id = args.id;
      if (!trackMaps.loopMap.has(id)) {
        throw new Error(`LOOP_END id not mapped: ${id}`);
      }
      const repeat = ensureU8(args.repeat ?? 1, "LOOP_END repeat");
      return Buffer.from([trackMaps.loopMap.get(id), repeat]);
    }
    case "PARAM_SET": {
      const target = TARGET_ID[args.target];
      if (target === undefined) {
        throw new Error(`PARAM_SET target not supported: ${args.target}`);
      }
      const value = i16le(args.value ?? 0);
      return Buffer.concat([Buffer.from([target]), value]);
    }
    case "PARAM_ADD": {
      const target = TARGET_ID[args.target];
      if (target === undefined) {
        throw new Error(`PARAM_ADD target not supported: ${args.target}`);
      }
      const delta = i16le(args.delta ?? 0);
      return Buffer.concat([Buffer.from([target]), delta]);
    }
    default:
      throw new Error(`Unsupported IR command for GMB writer: ${event.cmd}`);
  }
}

function encodeEvent(event, trackMaps) {
  const op = OPCODE[event.cmd];
  if (op === undefined) {
    throw new Error(`Unsupported IR command for GMB writer: ${event.cmd}`);
  }
  const argsBuf = encodePayload(event, trackMaps);

  const out = Buffer.concat([
    u32le(event.tick >>> 0),
    Buffer.from([op]),
    u16le(argsBuf.length),
    argsBuf,
  ]);
  return out;
}

function encodeTrackEvents(track) {
  const trackMaps = buildTrackMaps(track);
  const chunks = [];
  for (const event of track.events || []) {
    chunks.push(encodeEvent(event, trackMaps));
  }
  return Buffer.concat(chunks);
}

function encodeTrackTable(trackEntries) {
  const chunks = [u16le(trackEntries.length), u16le(0)];
  for (const t of trackEntries) {
    chunks.push(u16le(t.trackId));
    chunks.push(u16le(t.channelId));
    chunks.push(u32le(t.eventOffset));
    chunks.push(u32le(t.eventLength));
  }
  return Buffer.concat(chunks);
}

function encodeMetadata(metadata) {
  const entries = [
    ["title", metadata.title || ""],
    ["author", metadata.author || ""],
    ["compiler_version", metadata.compiler_version || "gmlisp-tools-0.1.0"],
  ];

  const chunks = [];
  for (const [k, v] of entries) {
    const kb = encodeString(k);
    const vb = encodeString(v);
    if (kb.length > 255) {
      throw new Error(`Metadata key too long: ${k}`);
    }
    if (vb.length > 65535) {
      throw new Error(`Metadata value too long for key: ${k}`);
    }
    chunks.push(Buffer.from([kb.length]));
    chunks.push(kb);
    chunks.push(u16le(vb.length));
    chunks.push(vb);
  }
  return Buffer.concat(chunks);
}

// Channel ID conventions:
//   FM1-FM6: 0-5 (YM2612 physical channels)
//   FM3op1-op4: 2, 16-18 (FM3 independent-frequency mode; driver enables FM3_MODE)
//   DAC shares ID 5 with FM6; FM6 is unavailable while DAC is active
//   PSG1-PSG3: 6-8, Noise: 9 (SN76489 via YM7101)
const TARGET_PROFILES = {
  "md-full": {
    channelIds: {
      fm1: 0,
      fm2: 1,
      fm3: 2,
      fm4: 3,
      fm5: 4,
      fm6: 5,
      dac: 5,
      fm3op1: 2,
      fm3op2: 16,
      fm3op3: 17,
      fm3op4: 18,
      psg1: 6,
      psg2: 7,
      psg3: 8,
      noise: 9,
    },
    fallbackOrder: [
      "fm1",
      "fm2",
      "fm3",
      "fm4",
      "fm5",
      "fm6",
      "psg1",
      "psg2",
      "psg3",
      "noise",
    ],
  },
  ym2612: {
    channelIds: {
      fm1: 0,
      fm2: 1,
      fm3: 2,
      fm4: 3,
      fm5: 4,
      fm6: 5,
      dac: 5,
      fm3op1: 2,
      fm3op2: 16,
      fm3op3: 17,
      fm3op4: 18,
    },
    fallbackOrder: ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6"],
  },
  psg: {
    channelIds: {
      psg1: 0,
      psg2: 1,
      psg3: 2,
      noise: 3,
    },
    fallbackOrder: ["psg1", "psg2", "psg3", "noise"],
  },
};

function normalizeChannelName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function trackChannelCandidates(track) {
  const candidates = [];
  const hintCandidates = track?.route_hint?.channel_candidates;
  if (Array.isArray(hintCandidates)) {
    for (const c of hintCandidates) {
      const name = normalizeChannelName(c);
      if (name) {
        candidates.push(name);
      }
    }
  }

  const legacy = normalizeChannelName(track?.channel);
  if (legacy) {
    candidates.push(legacy);
  }

  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) {
      continue;
    }
    unique.push(c);
    seen.add(c);
  }
  return unique;
}

function trackRole(track) {
  const role = track?.route_hint?.role;
  return VALID_ROLES.has(role) ? role : "bgm";
}

function createAllocator(targetProfile) {
  const profile = TARGET_PROFILES[targetProfile] || TARGET_PROFILES["md-full"];
  const usage = new Map();
  for (const name of profile.fallbackOrder) {
    usage.set(name, 0);
  }

  function pickFallback() {
    if (profile.fallbackOrder.length === 0) {
      return null;
    }
    let best = profile.fallbackOrder[0];
    let bestCount = usage.get(best) ?? 0;
    for (let i = 1; i < profile.fallbackOrder.length; i += 1) {
      const name = profile.fallbackOrder[i];
      const count = usage.get(name) ?? 0;
      if (count < bestCount) {
        best = name;
        bestCount = count;
      }
    }
    usage.set(best, bestCount + 1);
    return best;
  }

  return {
    profileName: TARGET_PROFILES[targetProfile] ? targetProfile : "md-full",
    allocate(track) {
      const candidates = trackChannelCandidates(track);
      for (const c of candidates) {
        if (profile.channelIds[c] !== undefined) {
          usage.set(c, (usage.get(c) ?? 0) + 1);
          return {
            channelName: c,
            channelId: profile.channelIds[c],
            strategy: "candidate",
          };
        }
      }

      const fallback = pickFallback();
      if (fallback && profile.channelIds[fallback] !== undefined) {
        return {
          channelName: fallback,
          channelId: profile.channelIds[fallback],
          strategy: "fallback",
        };
      }

      return {
        channelName: "unsupported",
        channelId: 0xffff,
        strategy: "unsupported",
      };
    },
  };
}

function buildGmb(ir, options = {}) {
  const tracks = ir.tracks || [];
  const allocator = createAllocator(options.targetProfile || "md-full");

  const eventBlocks = [];
  const trackEntries = [];
  const trackAssignments = [];
  let eventOffset = 0;
  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    const allocation = allocator.allocate(t);
    const role = trackRole(t);
    const writeScope = t?.route_hint?.write_scope ?? ["any"];
    const block = encodeTrackEvents(t);
    eventBlocks.push(block);
    trackEntries.push({
      trackId: t.id ?? i,
      channelId: allocation.channelId,
      eventOffset,
      eventLength: block.length,
    });
    trackAssignments.push({
      trackId: t.id ?? i,
      trackName: t.name || `track-${i}`,
      role,
      writeScope,
      assignedChannel: allocation.channelName,
      assignedChannelId: allocation.channelId,
      strategy: allocation.strategy,
      candidates: trackChannelCandidates(t),
    });
    eventOffset += block.length;
  }

  const trackTable = alignBuffer(encodeTrackTable(trackEntries), 2);
  const eventStream = alignBuffer(Buffer.concat(eventBlocks), 2);
  const metadata = alignBuffer(
    encodeMetadata({
      title: ir.metadata?.title,
      author: ir.metadata?.author,
      compiler_version: "gmlisp-tools-0.1.0",
    }),
    2,
  );

  const sectionEntries = [
    { id: SECTION.TRACK_TABLE, flags: 0, data: trackTable },
    { id: SECTION.EVENT_STREAM, flags: 0, data: eventStream },
    { id: SECTION.METADATA, flags: 0, data: metadata },
  ];

  const headerSize = 16;
  const dirEntrySize = 12;
  const sectionCount = sectionEntries.length;
  let payloadOffset = headerSize + dirEntrySize * sectionCount;

  const directory = [];
  for (const s of sectionEntries) {
    directory.push({
      id: s.id,
      flags: s.flags,
      offset: payloadOffset,
      size: s.data.length,
    });
    payloadOffset += s.data.length;
  }

  const header = Buffer.concat([
    Buffer.from("GMB0", "ascii"),
    Buffer.from([0x00, 0x01]),
    u16le(0),
    u16le(sectionCount),
    u16le(headerSize),
    u32le(0),
  ]);

  const dirChunks = [];
  for (const d of directory) {
    dirChunks.push(u16le(d.id));
    dirChunks.push(u16le(d.flags));
    dirChunks.push(u32le(d.offset));
    dirChunks.push(u32le(d.size));
  }

  const body = Buffer.concat(sectionEntries.map((s) => s.data));
  const gmb = Buffer.concat([header, Buffer.concat(dirChunks), body]);

  const meta = {
    sections: directory,
    totalSize: gmb.length,
    trackCount: tracks.length,
    targetProfile: allocator.profileName,
    trackAssignments,
  };

  return { gmb, meta };
}

function parseArgs(argv) {
  if (argv.length < 1) {
    usage();
    process.exit(1);
  }
  const parsed = {
    input: argv[0],
    out: null,
    meta: null,
    targetProfile: "md-full",
  };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") {
      parsed.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--meta") {
      parsed.meta = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--target-profile") {
      parsed.targetProfile = argv[i + 1] || "md-full";
      i += 1;
      continue;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ir = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const { gmb, meta } = buildGmb(ir, { targetProfile: args.targetProfile });

  const out = args.out || args.input.replace(/\.json$/i, ".gmb");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, gmb);

  if (args.meta) {
    fs.mkdirSync(path.dirname(args.meta), { recursive: true });
    fs.writeFileSync(args.meta, JSON.stringify(meta, null, 2) + "\n", "utf8");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = {
  buildGmb,
};
