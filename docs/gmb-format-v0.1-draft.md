# GMB Format v0.1 Draft

This document defines the draft binary format for GMLisp export artifacts.

## 1. Goals

1. Compact and deterministic song binary format
2. Clear version and feature negotiation with future GMLDRV
3. Forward-compatible section-based layout

## 2. Endianness and Alignment

1. Endianness: little-endian
2. Section offsets: uint32
3. Section payload alignment: 2-byte minimum

## 3. High-Level Layout

1. File header
2. Section directory
3. Track table section
4. Event stream section
5. Metadata section
6. Reserved extension section (optional)

## 4. File Header (fixed size)

Header fields:

1. magic[4]: "GMB0"
2. version_major: uint8
3. version_minor: uint8
4. flags: uint16
5. section_count: uint16
6. header_size: uint16
7. crc32: uint32 (optional in v0.1, zero allowed)

## 5. Feature Flags (draft)

1. bit0: extended tempo encoding present
2. bit1: marker table present
3. bit2: reserved CSM extension used
4. bit3: reserved FM3 extension used
5. bit4..bit15: reserved

v0.1 strict export must not set reserved-extension bits unless explicitly
enabled for experimental builds.

## 6. Section Directory Entry

Each entry:

1. id: uint16
2. flags: uint16
3. offset: uint32
4. size: uint32

Section ids (draft):

1. 0x0001 TRACK_TABLE
2. 0x0002 EVENT_STREAM
3. 0x0003 METADATA
4. 0x00F0 RESERVED_EXTENSION

## 7. Track Table Section

Track table header:

1. track_count: uint16
2. reserved: uint16

Track entry:

1. track_id: uint16
2. channel_id: uint16
3. event_offset: uint32 (relative to EVENT_STREAM section)
4. event_length: uint32

## 8. Event Stream Section

v0.1 stores command stream per track in compact form.

Command opcode assignment is intentionally not frozen in this document.
The section contract for v0.1 focuses on structure:

1. per-track event blocks are contiguous
2. each block is self-terminating or length-bounded by track table
3. unknown opcode handling must fail safely in loaders

Current draft writer record format (implementation note):

1. tick: uint32
2. opcode: uint8
3. payload_len: uint16
4. payload: UTF-8 JSON bytes (event args)

This record format is provisional and expected to be replaced with a tighter
packed format before v0.1 freeze.

## 9. Metadata Section

Metadata is a UTF-8 key-value table.

Entry format:

1. key_len: uint8
2. key bytes
3. value_len: uint16
4. value bytes

Required keys in v0.1:

1. title
2. author
3. compiler_version

## 10. Compatibility Policy

1. Loader must reject newer major versions
2. Loader may accept newer minor versions if unknown flags are not set
3. Unknown required feature flags must cause load failure

## 11. Validation Rules

1. All section offsets and sizes must be in bounds
2. Track event ranges must not overlap illegally
3. Metadata entries must be valid UTF-8
4. section_count must match directory entries

## 12. Freeze Notes

Before v0.1 freeze:

1. finalize section ids and required keys
2. finalize opcode map in command table follow-up document
3. add at least two golden GMB samples to regression fixtures
