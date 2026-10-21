// The OPN family's 4-operator FM channel (YM2612, YM2608): the operator
// registers, the algorithm and feedback, the chip's one LFO, and FM3's
// independent-operator and CSM tracks.
import { words } from "./parts.js";

export const opnFm = {
  name: "fm",
  label: "OPN FM",
  kind: "fm",
  words: words(/^FM_/, "PAN"),
  songWords: words("LFO_RATE"),
};
