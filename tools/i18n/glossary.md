# Translation glossary

The one hand-kept resource of the app's translations. An AI translating the
`--todo` output of `scripts/i18n-sync.mjs` reads this first; everything else
(what is translated, where it lives, what is stale) the tool decides.

## Never translated

Code is quoted as written. That includes the language's own words
(`:vel`, `:len`, `def-fm`, `(macro …)`, `#sus`, `$slot`, `fm1`, `pcm1`,
`sqr3`, `noise`), channel and register names (TL, ML, AR, RR, DR, SL, alg,
fb, op1–op4, Timer A), chip and product names (YM2612, SN76489, PSG, DAC,
OPN2, Mega Drive, MMLisp, MMLispDRV), file kinds (WAV, MIDI, VGM), units
(dB, dBFS, Hz, kHz, ms, BPM), MIDI note numbers, and menu paths
(`Tools > Release Holds`).

## Fixed terms

Pick one word per concept and keep it across every text.

| English | 日本語 | Español |
| --- | --- | --- |
| score | スコア | partitura |
| track | トラック | pista |
| channel | チャンネル | canal |
| voice (an FM patch) | 音色 | voz |
| sample | サンプル | muestra |
| operator | オペレータ | operador |
| carrier / modulator | キャリア / モジュレータ | portadora / moduladora |
| note / rest | 音符 / 休符 | nota / silencio |
| length (of a note) | 音長 | duración |
| velocity | ベロシティ | velocidad |
| fader | フェーダー | fader |
| curve | カーブ | curva |
| sweep | スイープ | barrido |
| macro | マクロ | macro |
| key-on / key-off | キーオン / キーオフ | key-on / key-off |
| attack (re-attack) | アタック（再アタック） | ataque (reataque) |
| tie / slur | タイ / スラー | ligadura de prolongación / ligadura de expresión |
| loop | ループ | bucle |
| bank (the sample bank) | バンク | banco |
| bake (a sample) | ベイク | hornear |
| driver | ドライバ | driver |
| the game (the host program) | ゲーム | el juego |
| sticky (stays set) | 以後も有効 | persistente |
| slot (a note's time) | スロット | hueco |
| cue | キュー | señal |

## Tone

Short, plain, in the register of a tool's reference card: what it does, its
range, its default. Keep the English sentence's order of ideas where the
language allows, so a reader comparing the two can follow. Japanese: です・ます
is not needed; the terse 体言止め of a manual is right. Spanish: the
impersonal present (`se repite`, `recorre`), no `usted`.
