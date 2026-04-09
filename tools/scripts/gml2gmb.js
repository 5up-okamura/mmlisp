#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SECTION, OPCODE, u16le, u32le, alignBuffer } = require("./gmb_common");

function usage() {
  console.error(
    "Usage: node scripts/gml2gmb.js <input.ir.json> [--out <file.gmb>] [--meta <file.txt>]",
  );
}

function encodeString(str) {
  return Buffer.from(String(str), "utf8");
}

function encodeEvent(event) {
  const op = OPCODE[event.cmd];
  if (op === undefined) {
    throw new Error(`Unsupported IR command for GMB writer: ${event.cmd}`);
  }
  const argsJson = JSON.stringify(event.args || {});
  const argsBuf = encodeString(argsJson);

  const out = Buffer.concat([
    u32le(event.tick >>> 0),
    Buffer.from([op]),
    u16le(argsBuf.length),
    argsBuf,
  ]);
  return out;
}

function encodeTrackEvents(track) {
  const chunks = [];
  for (const event of track.events || []) {
    chunks.push(encodeEvent(event));
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

function channelToId(channel) {
  const map = {
    fm1: 0,
    fm2: 1,
    fm3: 2,
    fm4: 3,
    fm5: 4,
    fm6: 5,
    psg1: 6,
    psg2: 7,
    psg3: 8,
    noise: 9,
    pcm1: 10,
    pcm2: 11,
  };
  return map[String(channel || "").toLowerCase()] ?? 0xffff;
}

function buildGmb(ir) {
  const tracks = ir.tracks || [];

  const eventBlocks = [];
  const trackEntries = [];
  let eventOffset = 0;
  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    const block = encodeTrackEvents(t);
    eventBlocks.push(block);
    trackEntries.push({
      trackId: t.id ?? i,
      channelId: channelToId(t.channel),
      eventOffset,
      eventLength: block.length,
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
  };

  return { gmb, meta };
}

function parseArgs(argv) {
  if (argv.length < 1) {
    usage();
    process.exit(1);
  }
  const parsed = { input: argv[0], out: null, meta: null };
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
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ir = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const { gmb, meta } = buildGmb(ir);

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
