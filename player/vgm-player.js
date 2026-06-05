const VGM_SAMPLE_RATE = 44100;
const DEFAULT_DATA_OFFSET = 0x40;
const LOOKAHEAD_SECS = 0.25;
const SCHEDULER_MS = 25;

const fileInput = document.getElementById("fileInput");
const btnPlay = document.getElementById("btnPlay");
const btnStop = document.getElementById("btnStop");
const loopToggle = document.getElementById("loopToggle");
const metaGrid = document.getElementById("metaGrid");
const logEl = document.getElementById("log");

let audioCtx = null;
let workletNode = null;
let workletReady = false;
let initAudioPromise = null;
let loadedVgm = null;
let playback = null;

function log(message, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setMeta(items) {
  metaGrid.innerHTML = "";
  for (const [label, value] of items) {
    const item = document.createElement("div");
    item.className = "meta-item";
    item.innerHTML = `<div class="meta-label">${label}</div><div class="meta-value">${value}</div>`;
    metaGrid.appendChild(item);
  }
}

function readU32LE(view, offset) {
  return view.getUint32(offset, true);
}

function hex(value, width = 2) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function parseVgm(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== "Vgm ") {
    throw new Error("Invalid VGM header");
  }

  const version = readU32LE(view, 0x08);
  const eofOffset = readU32LE(view, 0x04);
  const eof = eofOffset
    ? Math.min(bytes.length, 0x04 + eofOffset)
    : bytes.length;
  const ym2612Clock = readU32LE(view, 0x2c);
  const totalSamplesHeader = readU32LE(view, 0x18);
  const loopOffsetRaw = readU32LE(view, 0x1c);
  const loopOffset = loopOffsetRaw ? 0x1c + loopOffsetRaw : null;
  const dataOffsetRaw = version >= 0x150 ? readU32LE(view, 0x34) : 0;
  const dataStart =
    version >= 0x150
      ? dataOffsetRaw
        ? 0x34 + dataOffsetRaw
        : DEFAULT_DATA_OFFSET
      : DEFAULT_DATA_OFFSET;

  const events = [];
  const warnings = [];
  let cursor = dataStart;
  let sample = 0;
  let loopSample = null;
  let loopEventIndex = null;
  let dacIgnored = false;
  let unsupportedChipWrites = 0;

  while (cursor < eof) {
    if (loopOffset != null && cursor === loopOffset && loopEventIndex == null) {
      loopSample = sample;
      loopEventIndex = events.length;
    }

    const cmd = bytes[cursor++];
    if (cmd === 0x66) break;

    if (cmd === 0x52 || cmd === 0x53) {
      const addr = bytes[cursor++];
      const data = bytes[cursor++];
      if (cmd === 0x52 && (addr === 0x2a || addr === 0x2b)) {
        dacIgnored = true;
        continue;
      }
      events.push({ sample, port: cmd === 0x52 ? 0 : 1, addr, data });
      continue;
    }

    if (cmd === 0x61) {
      sample += view.getUint16(cursor, true);
      cursor += 2;
      continue;
    }
    if (cmd === 0x62) {
      sample += 735;
      continue;
    }
    if (cmd === 0x63) {
      sample += 882;
      continue;
    }
    if (cmd >= 0x70 && cmd <= 0x7f) {
      sample += (cmd & 0x0f) + 1;
      continue;
    }
    if (cmd === 0x67) {
      const compat = bytes[cursor++];
      if (compat !== 0x66) {
        throw new Error(`Malformed VGM data block at 0x${hex(cursor - 2, 6)}`);
      }
      const type = bytes[cursor++];
      const size = readU32LE(view, cursor);
      cursor += 4 + size;
      if (type === 0x00) dacIgnored = true;
      continue;
    }
    if (cmd >= 0x51 && cmd <= 0x5f) {
      cursor += 2;
      unsupportedChipWrites += 1;
      continue;
    }
    if (cmd === 0x4f || cmd === 0x50) {
      cursor += 1;
      unsupportedChipWrites += 1;
      continue;
    }
    if (cmd >= 0x80 && cmd <= 0x8f) {
      sample += cmd & 0x0f;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0x90 || cmd === 0x91) {
      cursor += 4;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0x92) {
      cursor += 5;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0x93) {
      cursor += 10;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0x94) {
      cursor += 1;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0x95) {
      cursor += 4;
      dacIgnored = true;
      continue;
    }
    if (cmd === 0xe0) {
      cursor += 4;
      dacIgnored = true;
      continue;
    }

    throw new Error(
      `Unsupported VGM command 0x${hex(cmd)} at 0x${hex(cursor - 1, 6)}`,
    );
  }

  if (!ym2612Clock) {
    throw new Error("This VGM does not declare a YM2612 clock");
  }
  if (dacIgnored) {
    warnings.push("DAC/PCM-related commands were ignored");
  }
  if (unsupportedChipWrites > 0) {
    warnings.push(`Ignored ${unsupportedChipWrites} non-YM2612 chip write(s)`);
  }

  return {
    version,
    ym2612Clock,
    dataStart,
    totalSamples: sample,
    totalSamplesHeader,
    loopSample,
    loopEventIndex,
    events,
    warnings,
  };
}

class VgmSequencer {
  constructor(writeFn, onEnd) {
    this.writeFn = writeFn;
    this.onEnd = onEnd;
    this.timer = null;
    this.audioCtx = null;
    this.vgm = null;
    this.loop = false;
    this.startedAt = 0;
    this.baseTime = 0;
    this.baseSample = 0;
    this.nextIndex = 0;
    this.endTime = 0;
  }

  start(audioCtx, vgm, loop) {
    this.stop(false);
    this.audioCtx = audioCtx;
    this.vgm = vgm;
    this.loop = Boolean(
      loop && vgm.loopSample != null && vgm.loopEventIndex != null,
    );
    this.startedAt = audioCtx.currentTime + 0.05;
    this.baseTime = this.startedAt;
    this.baseSample = 0;
    this.nextIndex = 0;
    this.endTime = this.startedAt + vgm.totalSamples / VGM_SAMPLE_RATE;
    this.timer = window.setInterval(() => this.pump(), SCHEDULER_MS);
    this.pump();
  }

  stop(flush = true) {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (flush) {
      this.writeFn({ type: "flush" });
      this.writeFn({ type: "reset" });
    }
  }

  pump() {
    if (!this.audioCtx || !this.vgm) return;

    const scheduleUntil = this.audioCtx.currentTime + LOOKAHEAD_SECS;
    while (true) {
      if (this.nextIndex >= this.vgm.events.length) {
        if (!this.loop) break;
        this.baseTime +=
          (this.vgm.totalSamples - this.baseSample) / VGM_SAMPLE_RATE;
        this.baseSample = this.vgm.loopSample;
        this.nextIndex = this.vgm.loopEventIndex;
        this.endTime =
          this.baseTime +
          (this.vgm.totalSamples - this.baseSample) / VGM_SAMPLE_RATE;
        continue;
      }

      const ev = this.vgm.events[this.nextIndex];
      const when =
        this.baseTime + (ev.sample - this.baseSample) / VGM_SAMPLE_RATE;
      if (when > scheduleUntil) break;
      this.writeFn(ev.port, ev.addr, ev.data, when);
      this.nextIndex += 1;
    }

    if (
      !this.loop &&
      this.nextIndex >= this.vgm.events.length &&
      this.audioCtx.currentTime >= this.endTime
    ) {
      this.stop(false);
      this.onEnd?.();
    }
  }
}

function writeToWorklet(portOrMsg, addr, data, when) {
  if (!workletNode) return;
  if (portOrMsg && typeof portOrMsg === "object" && !Array.isArray(portOrMsg)) {
    workletNode.port.postMessage(portOrMsg);
    return;
  }
  workletNode.port.postMessage({
    type: "write",
    port: portOrMsg,
    addr,
    data,
    when,
  });
}

async function initAudio() {
  if (initAudioPromise) return initAudioPromise;
  initAudioPromise = (async () => {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: 48000 });
    }
    if (!workletReady) {
      await audioCtx.audioWorklet.addModule("./nuked-worklet.js");
      workletNode = new AudioWorkletNode(audioCtx, "nuked-opn2-processor", {
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      workletNode.port.onmessage = (event) => {
        const msg = event.data;
        if (msg?.type === "error") {
          log(`Worklet error: ${msg.message}`, "err");
        }
      };
      workletNode.connect(audioCtx.destination);
      workletReady = true;
    }
    if (audioCtx.state !== "running") {
      await audioCtx.resume();
    }
    return true;
  })();
  return initAudioPromise;
}

function updateControls() {
  btnPlay.disabled = !loadedVgm;
  btnStop.disabled = !playback;
  loopToggle.disabled = !loadedVgm || loadedVgm.loopSample == null;
}

function showMetadata(vgm, fileName) {
  setMeta([
    ["File", fileName],
    ["Version", `0x${hex(vgm.version, 8)}`],
    ["YM2612 Clock", `${vgm.ym2612Clock} Hz`],
    ["Events", String(vgm.events.length)],
    [
      "Total Samples",
      `${vgm.totalSamples} (${(vgm.totalSamples / VGM_SAMPLE_RATE).toFixed(2)} s)`,
    ],
    [
      "Loop",
      vgm.loopSample != null ? `yes @ ${vgm.loopSample} samples` : "none",
    ],
  ]);
}

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    loadedVgm = parseVgm(buffer);
    showMetadata(loadedVgm, file.name);
    log(`Loaded ${file.name}`, "ok");
    for (const warning of loadedVgm.warnings) {
      log(warning, "warn");
    }
    updateControls();
  } catch (error) {
    loadedVgm = null;
    updateControls();
    setMeta([["Status", "Load failed"]]);
    log(error.message, "err");
  }
});

btnPlay.addEventListener("click", async () => {
  if (!loadedVgm) return;
  try {
    await initAudio();
    writeToWorklet({ type: "flush" });
    writeToWorklet({ type: "reset" });
    playback = new VgmSequencer(writeToWorklet, () => {
      log("Playback finished", "info");
      playback = null;
      updateControls();
    });
    playback.start(audioCtx, loadedVgm, loopToggle.checked);
    log(
      `Playback started${loopToggle.checked && loadedVgm.loopSample != null ? " (loop)" : ""}`,
      "info",
    );
    updateControls();
  } catch (error) {
    log(error.message, "err");
  }
});

btnStop.addEventListener("click", () => {
  if (!playback) return;
  playback.stop(true);
  playback = null;
  updateControls();
  log("Playback stopped", "info");
});

setMeta([["Status", "Select a .vgm file"]]);
log("Ready", "info");
