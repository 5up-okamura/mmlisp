// Build the POST-SPLIT Z80 image: the engine (src/engine.z80) with the
// generated mixer core inlined (driver.md §5).
//
// This is what a 68k project links against now. `build-driver.mjs` still builds
// the superseded all-Z80 driver — kept because its measurements are the reason
// this architecture exists (drv/README.md) — but nothing ships from it.
//
// One resident image, no overlays: the engine evaluates nothing, so it holds no
// shadow file, no LUTs, no channel state and no TCB, and the 8 KB that ruled the
// old build stopped being a design input.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./z80asm.mjs";
import { writeMixer } from "./gen-mixer.mjs";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

export function buildEngine() {
  writeMixer(); // regenerate src/mixer.z80, which engine.z80 includes
  const built = assemble(join(srcDir, "engine.z80"));
  const sym = (n) => {
    const v = built.symbols.get(n);
    if (v === undefined) throw new Error(`engine.z80 defines no ${n}`);
    return v;
  };
  // The engine's RAM starts at MIXLO; code growing into the mix plane would
  // corrupt audio rather than crash, so it is worth an assertion.
  const mixlo = sym("MIXLO");
  if (built.bytes.length > mixlo) {
    throw new Error(
      `engine image ${built.bytes.length} B overruns MIXLO (0x${mixlo.toString(16)})`,
    );
  }
  return {
    bytes: built.bytes,
    symbols: built.symbols,
    // The interface constants the 68k side needs. Only HDR is a compile-time
    // constant on that side — ring depth, slot shift and the ring base are read
    // out of the published header at runtime (§6.4), so one side owns them.
    header: {
      HDR: sym("HDR"),
      PROTO_VER: sym("PROTO_VER"),
      READY_MARK: sym("READY_MARK"),
      RING_DEPTH: sym("RING_DEPTH"),
      SLOT_SIZE: sym("SLOT_SIZE"),
      RING: sym("RING"),
    },
    headroom: mixlo - built.bytes.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes, header, headroom } = buildEngine();
  console.log(
    `engine ${bytes.length} B (${headroom} B free below MIXLO) · ` +
      `proto ${header.PROTO_VER} · ring ${header.RING_DEPTH} × ${header.SLOT_SIZE} B`,
  );
}
