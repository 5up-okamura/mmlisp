#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const SECTION = {
  TRACK_TABLE: 0x0001,
  EVENT_STREAM: 0x0002,
  METADATA: 0x0003,
};

const OPCODE_PAYLOAD_SIZE = {
  0x10: 3, // NOTE_ON: pitch:u8, length:u16
  0x11: 2, // REST: length:u16
  0x12: 2, // TIE: length:u16
  0x40: 1, // LOOP_BEGIN: loop_id:u8
  0x41: 2, // LOOP_END: loop_id:u8, repeat:u8
  0x42: 1, // MARKER: marker_id:u8
  0x43: 2, // JUMP: rel_offset:i16 (spec 1.6)
  0x60: 3, // PARAM_SET: target_id:u8, value:i16
  0x61: 3, // PARAM_ADD: target_id:u8, delta:i16
  0x80: 2, // TEMPO_SET: bpm:u16
};

function usage() {
  console.error("Usage: node scripts/verify-mmb.js <file.mmb>");
}

function u16le(buf, off) {
  return buf.readUInt16LE(off);
}

function u32le(buf, off) {
  return buf.readUInt32LE(off);
}

function fail(msg) {
  console.error(`GMB invalid: ${msg}`);
  process.exit(1);
}

function parseSections(buf, sectionCount) {
  const sections = new Map();
  const dirStart = 16;
  for (let i = 0; i < sectionCount; i += 1) {
    const off = dirStart + i * 12;
    const id = u16le(buf, off);
    const flags = u16le(buf, off + 2);
    const sectionOffset = u32le(buf, off + 4);
    const sectionSize = u32le(buf, off + 8);
    if (sectionOffset + sectionSize > buf.length) {
      fail(`section ${id} out of bounds`);
    }
    sections.set(id, {
      id,
      flags,
      offset: sectionOffset,
      size: sectionSize,
    });
  }
  return sections;
}

function parseTrackEntries(buf, section) {
  if (!section) {
    fail("missing TRACK_TABLE section");
  }
  if (section.size < 4) {
    fail("TRACK_TABLE section too small");
  }
  const base = section.offset;
  const end = section.offset + section.size;
  const trackCount = u16le(buf, base);
  const expectedSize = 4 + trackCount * 12;
  if (expectedSize > section.size) {
    fail("TRACK_TABLE size mismatch");
  }

  const entries = [];
  let pos = base + 4;
  for (let i = 0; i < trackCount; i += 1) {
    if (pos + 12 > end) {
      fail("TRACK_TABLE entry out of bounds");
    }
    entries.push({
      trackId: u16le(buf, pos),
      channelId: u16le(buf, pos + 2),
      eventOffset: u32le(buf, pos + 4),
      eventLength: u32le(buf, pos + 8),
    });
    pos += 12;
  }
  return entries;
}

function verifyTrackEvents(buf, eventSection, trackEntries) {
  if (!eventSection) {
    fail("missing EVENT_STREAM section");
  }

  let totalEvents = 0;
  for (const t of trackEntries) {
    const start = eventSection.offset + t.eventOffset;
    const end = start + t.eventLength;
    const sectionEnd = eventSection.offset + eventSection.size;
    if (start > sectionEnd || end > sectionEnd) {
      fail(`track ${t.trackId} event range out of EVENT_STREAM bounds`);
    }

    let pos = start;
    while (pos < end) {
      // Event record format (spec 1.5): [delta:u16][opcode:u8][payload_len:u16]
      if (pos + 5 > end) {
        fail(`track ${t.trackId} truncated event header`);
      }
      const opcode = buf[pos + 2];
      const payloadLen = u16le(buf, pos + 3);
      pos += 5;
      if (pos + payloadLen > end) {
        fail(`track ${t.trackId} event payload exceeds track range`);
      }

      const expected = OPCODE_PAYLOAD_SIZE[opcode];
      if (expected === undefined) {
        fail(`track ${t.trackId} unknown opcode 0x${opcode.toString(16)}`);
      }
      if (payloadLen !== expected) {
        fail(
          `track ${t.trackId} opcode 0x${opcode.toString(16)} payload mismatch (${payloadLen} != ${expected})`,
        );
      }

      pos += payloadLen;
      totalEvents += 1;
    }
  }
  return totalEvents;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    usage();
    process.exit(1);
  }

  const file = args[0];
  const buf = fs.readFileSync(file);
  if (buf.length < 16) {
    fail("file too small");
  }

  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== "MMB0") {
    fail("bad magic");
  }

  const versionMajor = buf[4];
  const versionMinor = buf[5];
  const sectionCount = u16le(buf, 8);
  const headerSize = u16le(buf, 10);

  if (headerSize !== 16) {
    fail(`unexpected header size ${headerSize}`);
  }

  const dirStart = 16;
  const dirSize = sectionCount * 12;
  if (dirStart + dirSize > buf.length) {
    fail("section directory out of bounds");
  }

  const sections = parseSections(buf, sectionCount);
  const trackEntries = parseTrackEntries(
    buf,
    sections.get(SECTION.TRACK_TABLE),
  );
  const totalEvents = verifyTrackEvents(
    buf,
    sections.get(SECTION.EVENT_STREAM),
    trackEntries,
  );
  if (!sections.has(SECTION.METADATA)) {
    fail("missing METADATA section");
  }

  console.log(
    `GMB valid: version=${versionMajor}.${versionMinor} sections=${sectionCount} tracks=${trackEntries.length} events=${totalEvents} size=${buf.length}`,
  );
}

if (require.main === module) {
  main();
}
