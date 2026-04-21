#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function u16le(buf, off) {
  return buf.readUInt16LE(off);
}

function u32le(buf, off) {
  return buf.readUInt32LE(off);
}

function writeU16le(buf, off, value) {
  buf.writeUInt16LE(value & 0xffff, off);
}

function writeU32le(buf, off, value) {
  buf.writeUInt32LE(value >>> 0, off);
}

function parseSection(buf, sectionId) {
  const sectionCount = u16le(buf, 8);
  const dirStart = 16;
  for (let i = 0; i < sectionCount; i += 1) {
    const off = dirStart + i * 12;
    const id = u16le(buf, off);
    const sectionOffset = u32le(buf, off + 4);
    const sectionSize = u32le(buf, off + 8);
    if (id === sectionId) {
      return { offset: sectionOffset, size: sectionSize };
    }
  }
  return null;
}

function firstTrackEventHeaderOffset(buf) {
  const track = parseSection(buf, 0x0001);
  const stream = parseSection(buf, 0x0002);
  if (!track || !stream) {
    throw new Error("missing required sections");
  }
  const trackCount = u16le(buf, track.offset);
  if (trackCount < 1) {
    throw new Error("no tracks in gmb");
  }
  const firstEntry = track.offset + 4;
  const eventOffset = u32le(buf, firstEntry + 4);
  return stream.offset + eventOffset;
}

function makeFixtures() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const gmbDir = path.join(repoRoot, "examples", "gmb");
  const fixturesDir = path.join(gmbDir, "fixtures");
  fs.mkdirSync(fixturesDir, { recursive: true });

  const demo1 = fs.readFileSync(path.join(gmbDir, "demo1-stage-loop.mmb"));
  const demo2 = fs.readFileSync(path.join(gmbDir, "demo2-event-recovery.mmb"));

  const valid1 = Buffer.from(demo1);
  const valid2 = Buffer.from(demo2);

  const badMagic = Buffer.from(demo1);
  badMagic.write("BAD0", 0, "ascii");

  const badPayloadLen = Buffer.from(demo1);
  {
    const h = firstTrackEventHeaderOffset(badPayloadLen);
    // Event record format (spec 1.5): [delta:u16][opcode:u8][payload_len:u16]
    // payload_len is at offset +3 (was +5 in old tick:u32 format)
    const payloadLen = u16le(badPayloadLen, h + 3);
    writeU16le(badPayloadLen, h + 3, payloadLen + 1);
  }

  const badTrackRange = Buffer.from(demo1);
  {
    const track = parseSection(badTrackRange, 0x0001);
    if (!track) {
      throw new Error("missing TRACK_TABLE");
    }
    const firstEntry = track.offset + 4;
    writeU32le(badTrackRange, firstEntry + 8, 0x00ffffff);
  }

  const files = [
    {
      name: "valid-demo1.mmb",
      buffer: valid1,
      valid: true,
      reason: "Known-good demo1 artifact",
    },
    {
      name: "valid-demo2.mmb",
      buffer: valid2,
      valid: true,
      reason: "Known-good demo2 artifact",
    },
    {
      name: "invalid-bad-magic.mmb",
      buffer: badMagic,
      valid: false,
      reason: "Magic header is corrupted",
    },
    {
      name: "invalid-bad-payload-len.mmb",
      buffer: badPayloadLen,
      valid: false,
      reason: "First event payload length is intentionally mismatched",
    },
    {
      name: "invalid-track-range.mmb",
      buffer: badTrackRange,
      valid: false,
      reason: "Track event range intentionally exceeds EVENT_STREAM",
    },
  ];

  for (const file of files) {
    fs.writeFileSync(path.join(fixturesDir, file.name), file.buffer);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    cases: files.map((f) => ({
      file: f.name,
      valid: f.valid,
      reason: f.reason,
    })),
  };

  fs.writeFileSync(
    path.join(fixturesDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(fixturesDir, "README.md"),
    "# GMB Compatibility Fixtures\n\nGenerated fixture set for decoder compatibility checks.\n\nRegenerate with:\n\n1. npm run build:gmb-demos\n2. npm run build:gmb-fixtures\n\nRun checks with:\n\n1. npm run check:gmb-fixtures\n",
    "utf8",
  );

  console.log(`Generated ${files.length} fixture files in ${fixturesDir}`);
}

if (require.main === module) {
  try {
    makeFixtures();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}
