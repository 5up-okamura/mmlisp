# Provisional Opcode Mapping Memo (v0.1)

Status: provisional for local experiments only.
Do not treat this mapping as frozen spec.

## 1. Design Policy

1. Reserve dense range for frequent timeline commands.
2. Keep extension room for v0.2 reserved commands.
3. Preserve compact note/rest encoding opportunities.

## 2. Provisional Groups

1. 0x00-0x3f: timing and note events
2. 0x40-0x5f: control flow (loop/marker/jump)
3. 0x60-0x7f: parameter set/add
4. 0x80-0x9f: tempo and transport
5. 0xa0-0xbf: reserved v0.2 advanced FM commands
6. 0xc0-0xff: extended/experimental

## 3. Candidate Assignments (temporary)

1. NOTE_ON: 0x10
2. REST: 0x11
3. TIE: 0x12
4. TEMPO_SET: 0x80
5. LOOP_BEGIN: 0x40
6. LOOP_END: 0x41
7. MARKER: 0x42
8. JUMP: 0x43
9. PARAM_SET: 0x60
10. PARAM_ADD: 0x61

## 4. Reserved (v0.2)

1. CSM_ON: 0xa0
2. CSM_OFF: 0xa1
3. CSM_RATE: 0xa2
4. FM3_MODE: 0xa3
5. REG_WRITE: 0xa4

## 5. Validation To-Do

1. Verify command frequency from demo IR snapshots.
2. Re-pack NOTE_ON/REST if large gains are found.
3. Confirm no conflicts with planned GMLDRV decode table.
