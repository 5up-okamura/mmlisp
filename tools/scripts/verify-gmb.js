#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function usage() {
  console.error("Usage: node scripts/verify-gmb.js <file.gmb>");
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
  if (magic !== "GMB0") {
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

  for (let i = 0; i < sectionCount; i += 1) {
    const off = dirStart + i * 12;
    const id = u16le(buf, off);
    const sectionOffset = u32le(buf, off + 4);
    const sectionSize = u32le(buf, off + 8);
    if (sectionOffset + sectionSize > buf.length) {
      fail(`section ${id} out of bounds`);
    }
  }

  console.log(
    `GMB valid: version=${versionMajor}.${versionMinor} sections=${sectionCount} size=${buf.length}`,
  );
}

if (require.main === module) {
  main();
}
