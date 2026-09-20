# GM 128音色バンク（YM2612）

libOPNMIDIのXGバンクから、メロディのMSB 0 / LSB 0（GM基本128音色）だけを移植しました。
XG拡張音色・別バンク・FMドラムは含めていません。以前の独自作成バンクを置き換えています。

原作者: Vitaliy Novichkov（Wohlstand）。MITライセンス。
[原文・著作権表示](licenses/libopnmidi-xg.txt) / [出典と抽出データ](source.json)。

## 使い方

`examples/source/`に置いたスコアでは次のように読み込みます。
Liveでは File > Open Folder… でリポジトリを開いてください。

```lisp
(import "../../presets/gm/gm.mmlisp")

(fm1 :tempo 120 :oct 4 :len 8 :vel 12
  gm-001-acoustic-grand-piano c e g > c <)
(fm2 :oct 2 :len 4 :vel 12
  gm-034-electric-bass-finger c g)
(fm3 :oct 4 :len 4 :vel 10
  gm-057-trumpet g c)
```

[全音色の試聴スコア](../../examples/source/gm-audition.mmlisp)は、各音色を1小節ずつ
C–E–G–Cと休符で試聴します（ベースなどは低いオクターブ）。120 BPMで約4分16秒です。
個別に確認する場合は、その音色の行だけ残してください。

GM欄は1始まり、MIDIプログラム値は0始まりです。名前をスコアで指定するライブラリであり、
MIDIファイルのProgram Changeを自動変換する機能ではありません。

## 移植内容と使う際の注意

GM番号1–128（MIDIプログラム値0–127）を、`gm-001-…`～`gm-128-…`の名前で
直接FM音色として定義しています。中間の音色名や演奏設定のラッパーはありません。

- オペレータの順序をWOPNの1,3,2,4からMMLispの1,2,3,4へ変換。
- ALG/FB、DT/MUL、TL、KS/AR、AM/DR、SR、SL/RR、SSG-EG、AMS/FMSを保持。
- 音色定義に`:pitch`や`:lfo-rate`は含めません。音高・共有LFOはスコア側で設定します。
- 元バンクの音高補正・LFO設定・発音管理用の時間情報は、来歴として
  `source.json`にのみ保持しています。音色を選択しても自動適用されません。

レジスタ値は独自調整していません。libOPNMIDIとは音量・ベロシティ処理や発音管理が
異なるため、MIDI再生全体の完全一致を保証するものではありません。
音色単体の聴感による最終確認は未実施です。

## 出典・再生成・検証

配布元: [libOPNMIDI XG bank](https://github.com/Wohlstand/libOPNMIDI/blob/8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b/fm_banks/xg.wopn)。
リビジョン、SHA-256、各音色の原名・元レコードを`source.json`に保存しています。
リポジトリのルートから、取得済みの同じWOPNを指定して再生成できます。

```sh
node tools/scripts/import-xg-gm.mjs /path/to/xg.wopn 8e0a0a6ac97a21f22c4b4d53d67a8d916d8c487b
node tools/scripts/format-mmlisp.js presets/gm/gm.mmlisp
node tools/scripts/check-xg-gm.mjs
```

検証は全128音色について元WOPNとの29バイトの音色レジスタ一致、AMS/FMS、MMB出力を確認します。
試聴スコアの512ノートと、音色選択が音高・共有LFOを書き換えないことも検証します。

## 音色一覧

| GM | MIDI | 音色 | MMLisp |
| --- | --- | --- | --- |
| 1 | 0 | Acoustic Grand Piano | `gm-001-acoustic-grand-piano` |
| 2 | 1 | Bright Acoustic Piano | `gm-002-bright-acoustic-piano` |
| 3 | 2 | Electric Grand Piano | `gm-003-electric-grand-piano` |
| 4 | 3 | Honky-tonk Piano | `gm-004-honky-tonk-piano` |
| 5 | 4 | Electric Piano 1 | `gm-005-electric-piano-1` |
| 6 | 5 | Electric Piano 2 | `gm-006-electric-piano-2` |
| 7 | 6 | Harpsichord | `gm-007-harpsichord` |
| 8 | 7 | Clavinet | `gm-008-clavinet` |
| 9 | 8 | Celesta | `gm-009-celesta` |
| 10 | 9 | Glockenspiel | `gm-010-glockenspiel` |
| 11 | 10 | Music Box | `gm-011-music-box` |
| 12 | 11 | Vibraphone | `gm-012-vibraphone` |
| 13 | 12 | Marimba | `gm-013-marimba` |
| 14 | 13 | Xylophone | `gm-014-xylophone` |
| 15 | 14 | Tubular Bells | `gm-015-tubular-bells` |
| 16 | 15 | Dulcimer | `gm-016-dulcimer` |
| 17 | 16 | Drawbar Organ | `gm-017-drawbar-organ` |
| 18 | 17 | Percussive Organ | `gm-018-percussive-organ` |
| 19 | 18 | Rock Organ | `gm-019-rock-organ` |
| 20 | 19 | Church Organ | `gm-020-church-organ` |
| 21 | 20 | Reed Organ | `gm-021-reed-organ` |
| 22 | 21 | Accordion | `gm-022-accordion` |
| 23 | 22 | Harmonica | `gm-023-harmonica` |
| 24 | 23 | Tango Accordion | `gm-024-tango-accordion` |
| 25 | 24 | Acoustic Guitar nylon | `gm-025-acoustic-guitar-nylon` |
| 26 | 25 | Acoustic Guitar steel | `gm-026-acoustic-guitar-steel` |
| 27 | 26 | Electric Guitar jazz | `gm-027-electric-guitar-jazz` |
| 28 | 27 | Electric Guitar clean | `gm-028-electric-guitar-clean` |
| 29 | 28 | Electric Guitar muted | `gm-029-electric-guitar-muted` |
| 30 | 29 | Overdriven Guitar | `gm-030-overdriven-guitar` |
| 31 | 30 | Distortion Guitar | `gm-031-distortion-guitar` |
| 32 | 31 | Guitar Harmonics | `gm-032-guitar-harmonics` |
| 33 | 32 | Acoustic Bass | `gm-033-acoustic-bass` |
| 34 | 33 | Electric Bass finger | `gm-034-electric-bass-finger` |
| 35 | 34 | Electric Bass pick | `gm-035-electric-bass-pick` |
| 36 | 35 | Fretless Bass | `gm-036-fretless-bass` |
| 37 | 36 | Slap Bass 1 | `gm-037-slap-bass-1` |
| 38 | 37 | Slap Bass 2 | `gm-038-slap-bass-2` |
| 39 | 38 | Synth Bass 1 | `gm-039-synth-bass-1` |
| 40 | 39 | Synth Bass 2 | `gm-040-synth-bass-2` |
| 41 | 40 | Violin | `gm-041-violin` |
| 42 | 41 | Viola | `gm-042-viola` |
| 43 | 42 | Cello | `gm-043-cello` |
| 44 | 43 | Contrabass | `gm-044-contrabass` |
| 45 | 44 | Tremolo Strings | `gm-045-tremolo-strings` |
| 46 | 45 | Pizzicato Strings | `gm-046-pizzicato-strings` |
| 47 | 46 | Orchestral Harp | `gm-047-orchestral-harp` |
| 48 | 47 | Timpani | `gm-048-timpani` |
| 49 | 48 | String Ensemble 1 | `gm-049-string-ensemble-1` |
| 50 | 49 | String Ensemble 2 | `gm-050-string-ensemble-2` |
| 51 | 50 | SynthStrings 1 | `gm-051-synthstrings-1` |
| 52 | 51 | SynthStrings 2 | `gm-052-synthstrings-2` |
| 53 | 52 | Choir Aahs | `gm-053-choir-aahs` |
| 54 | 53 | Voice Oohs | `gm-054-voice-oohs` |
| 55 | 54 | Synth Voice | `gm-055-synth-voice` |
| 56 | 55 | Orchestra Hit | `gm-056-orchestra-hit` |
| 57 | 56 | Trumpet | `gm-057-trumpet` |
| 58 | 57 | Trombone | `gm-058-trombone` |
| 59 | 58 | Tuba | `gm-059-tuba` |
| 60 | 59 | Muted Trumpet | `gm-060-muted-trumpet` |
| 61 | 60 | French Horn | `gm-061-french-horn` |
| 62 | 61 | Brass Section | `gm-062-brass-section` |
| 63 | 62 | SynthBrass 1 | `gm-063-synthbrass-1` |
| 64 | 63 | SynthBrass 2 | `gm-064-synthbrass-2` |
| 65 | 64 | Soprano Sax | `gm-065-soprano-sax` |
| 66 | 65 | Alto Sax | `gm-066-alto-sax` |
| 67 | 66 | Tenor Sax | `gm-067-tenor-sax` |
| 68 | 67 | Baritone Sax | `gm-068-baritone-sax` |
| 69 | 68 | Oboe | `gm-069-oboe` |
| 70 | 69 | English Horn | `gm-070-english-horn` |
| 71 | 70 | Bassoon | `gm-071-bassoon` |
| 72 | 71 | Clarinet | `gm-072-clarinet` |
| 73 | 72 | Piccolo | `gm-073-piccolo` |
| 74 | 73 | Flute | `gm-074-flute` |
| 75 | 74 | Recorder | `gm-075-recorder` |
| 76 | 75 | Pan Flute | `gm-076-pan-flute` |
| 77 | 76 | Blown Bottle | `gm-077-blown-bottle` |
| 78 | 77 | Shakuhachi | `gm-078-shakuhachi` |
| 79 | 78 | Whistle | `gm-079-whistle` |
| 80 | 79 | Ocarina | `gm-080-ocarina` |
| 81 | 80 | Lead 1 square | `gm-081-lead-1-square` |
| 82 | 81 | Lead 2 sawtooth | `gm-082-lead-2-sawtooth` |
| 83 | 82 | Lead 3 calliope | `gm-083-lead-3-calliope` |
| 84 | 83 | Lead 4 chiff | `gm-084-lead-4-chiff` |
| 85 | 84 | Lead 5 charang | `gm-085-lead-5-charang` |
| 86 | 85 | Lead 6 voice | `gm-086-lead-6-voice` |
| 87 | 86 | Lead 7 fifths | `gm-087-lead-7-fifths` |
| 88 | 87 | Lead 8 bass and lead | `gm-088-lead-8-bass-and-lead` |
| 89 | 88 | Pad 1 new age | `gm-089-pad-1-new-age` |
| 90 | 89 | Pad 2 warm | `gm-090-pad-2-warm` |
| 91 | 90 | Pad 3 polysynth | `gm-091-pad-3-polysynth` |
| 92 | 91 | Pad 4 choir | `gm-092-pad-4-choir` |
| 93 | 92 | Pad 5 bowed | `gm-093-pad-5-bowed` |
| 94 | 93 | Pad 6 metallic | `gm-094-pad-6-metallic` |
| 95 | 94 | Pad 7 halo | `gm-095-pad-7-halo` |
| 96 | 95 | Pad 8 sweep | `gm-096-pad-8-sweep` |
| 97 | 96 | FX 1 rain | `gm-097-fx-1-rain` |
| 98 | 97 | FX 2 soundtrack | `gm-098-fx-2-soundtrack` |
| 99 | 98 | FX 3 crystal | `gm-099-fx-3-crystal` |
| 100 | 99 | FX 4 atmosphere | `gm-100-fx-4-atmosphere` |
| 101 | 100 | FX 5 brightness | `gm-101-fx-5-brightness` |
| 102 | 101 | FX 6 goblins | `gm-102-fx-6-goblins` |
| 103 | 102 | FX 7 echoes | `gm-103-fx-7-echoes` |
| 104 | 103 | FX 8 sci-fi | `gm-104-fx-8-sci-fi` |
| 105 | 104 | Sitar | `gm-105-sitar` |
| 106 | 105 | Banjo | `gm-106-banjo` |
| 107 | 106 | Shamisen | `gm-107-shamisen` |
| 108 | 107 | Koto | `gm-108-koto` |
| 109 | 108 | Kalimba | `gm-109-kalimba` |
| 110 | 109 | Bag Pipe | `gm-110-bag-pipe` |
| 111 | 110 | Fiddle | `gm-111-fiddle` |
| 112 | 111 | Shanai | `gm-112-shanai` |
| 113 | 112 | Tinkle Bell | `gm-113-tinkle-bell` |
| 114 | 113 | Agogo | `gm-114-agogo` |
| 115 | 114 | Steel Drums | `gm-115-steel-drums` |
| 116 | 115 | Woodblock | `gm-116-woodblock` |
| 117 | 116 | Taiko Drum | `gm-117-taiko-drum` |
| 118 | 117 | Melodic Tom | `gm-118-melodic-tom` |
| 119 | 118 | Synth Drum | `gm-119-synth-drum` |
| 120 | 119 | Reverse Cymbal | `gm-120-reverse-cymbal` |
| 121 | 120 | Guitar Fret Noise | `gm-121-guitar-fret-noise` |
| 122 | 121 | Breath Noise | `gm-122-breath-noise` |
| 123 | 122 | Seashore | `gm-123-seashore` |
| 124 | 123 | Bird Tweet | `gm-124-bird-tweet` |
| 125 | 124 | Telephone Ring | `gm-125-telephone-ring` |
| 126 | 125 | Helicopter | `gm-126-helicopter` |
| 127 | 126 | Applause | `gm-127-applause` |
| 128 | 127 | Gunshot | `gm-128-gunshot` |

