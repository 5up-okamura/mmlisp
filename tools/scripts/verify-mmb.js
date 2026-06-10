#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { SECTION, OPCODE } = require("./mmb-common");

const OPCODE_PAYLOAD_SIZE = {
  [OPCODE.NOTE_ON]: 3, // NOTE_ON: pitch:u8, length:u16
  [OPCODE.REST]: 2, // REST: length:u16
  [OPCODE.TIE]: 2, // TIE: length:u16
  [OPCODE.LOOP_BEGIN]: 1, // LOOP_BEGIN: loop_id:u8
  [OPCODE.LOOP_END]: 2, // LOOP_END: loop_id:u8, repeat:u8
  [OPCODE.MARKER]: 1, // MARKER: marker_id:u8
  [OPCODE.JUMP]: 2, // JUMP: rel_offset:i16 (spec 1.6)
  [OPCODE.PARAM_SET]: 3, // PARAM_SET: target_id:u8, value:i16
  [OPCODE.PARAM_SWEEP]: null, // PARAM_SWEEP: variable-length payload
  [OPCODE.TEMPO_SET]: 2, // TEMPO_SET: bpm:u16
  [OPCODE.PCM_NOTE_ON]: 9, // PCM_NOTE_ON: sample_id:u8, rate:q8.8, length:u16, vel:u8, mode:u8, base_rate:u16
  [OPCODE.PCM_NOTE_OFF]: 2, // PCM_NOTE_OFF: sample_id:u8, mode:u8
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
  console.error(`MMB invalid: ${msg}`);
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
      if (expected !== null && payloadLen !== expected) {
        fail(
          `track ${t.trackId} opcode 0x${opcode.toString(16)} payload mismatch (${payloadLen} != ${expected})`,
        );
      }

      if (opcode === 0x61) {
        if (payloadLen < 9) {
          fail(`track ${t.trackId} PARAM_SWEEP payload too small`);
        }
        const targetId = buf[pos];
        const flags = buf[pos + 1];
        let sweepPos = pos + 2;
        if (targetId === 0) {
          fail(`track ${t.trackId} PARAM_SWEEP has invalid target id 0`);
        }
        if (flags & 0x02) {
          sweepPos += 2;
        }
        sweepPos += 2; // to
        sweepPos += 2; // frames
        if (sweepPos + 1 > pos + payloadLen) {
          fail(`track ${t.trackId} PARAM_SWEEP truncated curve header`);
        }
        const curveLen = buf[sweepPos];
        sweepPos += 1;
        if (sweepPos + curveLen + 1 > pos + payloadLen) {
          fail(`track ${t.trackId} PARAM_SWEEP truncated curve body`);
        }
        sweepPos += curveLen;
        const paramsCount = buf[sweepPos];
        sweepPos += 1;
        for (let i = 0; i < paramsCount; i += 1) {
          if (sweepPos + 1 > pos + payloadLen) {
            fail(`track ${t.trackId} PARAM_SWEEP truncated param key length`);
          }
          const keyLen = buf[sweepPos];
          sweepPos += 1;
          if (sweepPos + keyLen + 8 > pos + payloadLen) {
            fail(`track ${t.trackId} PARAM_SWEEP truncated param entry`);
          }
          sweepPos += keyLen + 8;
        }
        if (sweepPos !== pos + payloadLen) {
          fail(`track ${t.trackId} PARAM_SWEEP payload size mismatch`);
        }
      }

      pos += payloadLen;
      totalEvents += 1;
    }
  }
  return totalEvents;
}

function verifySampleBank(buf, section) {
  if (!section) {
    return 0;
  }
  if (section.size < 2) {
    fail("SAMPLE_BANK section too small");
  }

  const base = section.offset;
  const end = section.offset + section.size;
  const sampleCount = u16le(buf, base);
  let pos = base + 2;

  for (let i = 0; i < sampleCount; i += 1) {
    if (pos + 2 > end) {
      fail(`SAMPLE_BANK sample ${i} truncated header`);
    }
    const sampleId = buf[pos];
    const nameLen = buf[pos + 1];
    pos += 2;

    if (sampleId === 0) {
      fail(`SAMPLE_BANK sample ${i} has invalid sample id 0`);
    }
    if (pos + nameLen + 20 > end) {
      fail(`SAMPLE_BANK sample ${i} truncated record`);
    }

    const name = buf.subarray(pos, pos + nameLen).toString("utf8");
    if (!name) {
      fail(`SAMPLE_BANK sample ${i} missing name`);
    }
    pos += nameLen;

    const sampleRate = u32le(buf, pos);
    const frameCount = u32le(buf, pos + 4);
    const loopStart = u32le(buf, pos + 8);
    const loopEnd = u32le(buf, pos + 12);
    const dataLen = u32le(buf, pos + 16);
    pos += 20;

    if (sampleRate === 0) {
      fail(`SAMPLE_BANK sample ${i} has invalid sample rate`);
    }
    if (loopEnd < loopStart || loopEnd > frameCount) {
      fail(`SAMPLE_BANK sample ${i} has invalid loop range`);
    }
    if (pos + dataLen > end) {
      fail(`SAMPLE_BANK sample ${i} truncated PCM data`);
    }
    if (dataLen !== frameCount) {
      fail(`SAMPLE_BANK sample ${i} frame count mismatch`);
    }

    pos += dataLen;
  }

  for (; pos < end; pos += 1) {
    if (buf[pos] !== 0) {
      fail("SAMPLE_BANK trailing bytes must be zero padding");
    }
  }

  return sampleCount;
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
  verifySampleBank(buf, sections.get(SECTION.SAMPLE_BANK));
  if (!sections.has(SECTION.METADATA)) {
    fail("missing METADATA section");
  }

  console.log(
    `MMB valid: version=${versionMajor}.${versionMinor} sections=${sectionCount} tracks=${trackEntries.length} events=${totalEvents} size=${buf.length}`,
  );
}

if (require.main === module) {
  main();
}
