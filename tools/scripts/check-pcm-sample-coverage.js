#!/usr/bin/env node
"use strict";

const { buildMmb } = require("./mmlisp2mmb");

function main() {
  const ir = {
    metadata: {
      samples: [{ name: "kick" }],
    },
    tracks: [
      {
        id: 1,
        channel: "pcm1",
        events: [
          {
            cmd: "PCM_NOTE_ON",
            tick: 0,
            args: {
              sample: "kick",
              rate: 1,
              length: 4,
              vel: 15,
              mode: "shot",
              baseRate: 0,
            },
          },
        ],
      },
    ],
  };

  try {
    buildMmb(ir);
  } catch (error) {
    if (
      String(error && error.message ? error.message : error) ===
      "PCM_NOTE_ON references undefined sample: kick"
    ) {
      console.log("PCM sample coverage check passed");
      return;
    }
    throw error;
  }

  throw new Error("expected missing compiled PCM sample to fail");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}
