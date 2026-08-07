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
  // Code stops below the PUBLISHED HEADER, which is the one address the 68k
  // compiles in (§6.4) and therefore the one that cannot move. Growing past it
  // overwrites the header and the slot ring with code — which presents as the
  // mixer executing data, so it is worth an assertion rather than a debug
  // session. (It used to be checked against MIXLO, the mix planes' base; the
  // planes are gone and the header is the real ceiling.)
  const hdr = sym("HDR");
  // The HOT code stops below the published header, which is the one address the
  // 68k compiles in (§6.4) and cannot move: growing past it would overwrite
  // H_HEAD/H_TAIL and the slot ring with code. The COLD code lives above the
  // sample ring instead (§5.2), so the blob spans the gap — which is why the
  // check is on CODE_END and not on the blob's length.
  const codeEnd = sym("CODE_END");
  if (codeEnd > hdr) {
    throw new Error(
      `engine hot code ends at 0x${codeEnd.toString(16)}, past the published ` +
        `header (0x${hdr.toString(16)}) — it would overwrite H_HEAD/H_TAIL and the ring`,
    );
  }
  const stackRoom = sym("STACK_TOP") - 64;
  if (built.bytes.length > stackRoom) {
    throw new Error(
      `engine cold code ends at 0x${built.bytes.length.toString(16)}, into the ` +
        `stack's 64 B (top 0x${sym("STACK_TOP").toString(16)})`,
    );
  }
  // `mvf_ringcap` converts SAMPLES to TICKS with a baked `add a,a` — the one
  // place the pass count lives in hand-written asm instead of in the equ the
  // generator emits. Getting it wrong lets a segment overrun the ring's top and
  // the DAC diverges at the wrap, ~500 samples in, which reads as a mixer bug.
  if (sym("PCM_PASSES") !== 2) {
    throw new Error(
      `PCM_PASSES is ${sym("PCM_PASSES")}, but mvf_ringcap (engine.z80) bakes ` +
        `x2 into its samples->ticks conversion. Update that site — x3 is ` +
        `\`add a,a / add a,l\`, x4 is \`add a,a / add a,a\` — and this check.`,
    );
  }
  // `pcm_pad` takes a shortcut: any voice sounding at all and it stores the
  // minimum pad without computing anything, because the cheapest sounding pass
  // plus the silent ones it runs beside already exceed PCM_BUDGET. That is a
  // property of the generated cost table and of one constant, so it is checked
  // here rather than trusted — if the mixer ever gets cheap enough (or the
  // budget generous enough) for a sounding frame to afford a real pad, the
  // shortcut would silently keep handing out the floor.
  // The routine's own arithmetic, run over the frame with the MOST slack that
  // still has a voice in it — one sounding pass (at its cheapest shift) beside
  // two silent ones. If even that comes out at the floor, no sounding frame can
  // do better and the shortcut is exact.
  const tab = sym("pass_cost_tab");
  const passCost = (s) => built.bytes[tab + 2 * s] | (built.bytes[tab + 2 * s + 1] << 8);
  const silent = sym("PCM_PASSES") - 1;
  const left = sym("PCM_BUDGET")
    - Math.min(...[...Array(8)].map((_, s) => passCost(s)))
    - silent * passCost(sym("PCM_IDLE_SH"));
  const pad = left < 0 ? 1
    : Math.max(1, Math.min(sym("PCM_IDLE_PAD"), left >> (9 + silent)));
  if (pad > 1) {
    throw new Error(
      `pcm_pad's "any voice ⇒ minimum pad" shortcut no longer holds: the ` +
        `roomiest sounding frame has ${left} cycles spare against PCM_BUDGET ` +
        `${sym("PCM_BUDGET")}, which is a pad of ${pad}, not the floor. Remove ` +
        `the G_ACTM early-out in pcm_pad (engine.z80), or re-tune PCM_BUDGET.`,
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
    headroom: hdr - codeEnd,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes, header, headroom } = buildEngine();
  console.log(
    `engine ${bytes.length} B blob (${headroom} B free below the header) · ` +
      `proto ${header.PROTO_VER} · ring ${header.RING_DEPTH} × ${header.SLOT_SIZE} B`,
  );
}
