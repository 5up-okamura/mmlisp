# TR-808 Fischer — GM番号ドラムキット

[試聴ページ](index.html)。22音、22,050 Hz（22.05 kHz）/ signed 16-bit PCM / mono WAV。
ファイル名先頭はGMのMIDIノート番号です。既存の[GM短音キット](../gm-muted/README.md)と同じ番号で楽器を選べます。
MMLispのMIDIノート自動マッピング機能ではなく、WAV素材と対応表です。

## 選択と加工

Michael Fischer / TechnopolisのTR-808実機サンプルを使用。
複数のノブ設定からキット用の代表音を選びました。タムは低・中・高それぞれの
TUNING 2.5 / 7.5の録音を使い、6段階に配置しています。音高のデジタル変更はしていません。

元の立ち上がりを保持し、長いサンプルは末尾を半コサインフェードでゼロに落として短縮。
短い元音は全長を維持し、末尾2 msのみフェードします。
キック最大220–300 ms、スネア220–240 ms、タム170–260 ms、
オープンハイハット350 ms、シンバル600 ms。ループはありません。
音量の均一化・EQは行っていません。モノラル化、アンチエイリアス付きリサンプリング、
TPDFディザによる16-bit化を実施。クリップの可能性がある場合だけ減衰します。

38番のAcoustic Snareも808の電子音です（GMの配置名を維持）。
40番は別のSNAPPY設定、57番は別のTONE設定のシンバル。
62番Mute Hi Congaは高コンガを短くした派生音で、ミュート奏法の録音ではありません。

未収録: 44、51–55、58–61、65–69、71–74、76–81。
808にないペダルハイハット、ライド、チャイナ、スプラッシュ、ボンゴなどを別楽器で補完していません。
GM番号のない中コンガも独立音として収録していません。

形式・クリッピング・末尾ゼロ・ハッシュは検証済み。聴感による最終調整は未実施です。
長さは試聴ページで確認して調整できます。

## 出典・再生成

- [tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer)
- Revision: `85fbecf1bec32553395625ea659e2a56dfd7c0e1`
- 録音: Michael Fischer / Technopolis、1994年。
- 配布リポジトリのライセンス: CC0 1.0。[全文](LICENSE-CC0.txt)。
- [manifest.json](manifest.json): 元ファイルURL・SHA-256・変換前後の長さ・フェード時間・ゲイン。

`numpy`、`scipy`、`soundfile`をインストールしたPython環境で再生成できます。

```sh
python tools/scripts/build-tr808-kit.py
```

元のWAVは一時ディレクトリ`mmlisp-tr808-source/<commit>/`にキャッシュされます。
再生成はこのキットのWAVとマニフェスト、試聴ページを上書きします。

## GM対応表

| MIDIノート | GM名 | 808の元音 | 長さ |
| --- | --- | --- | --- |
| 35 | [Acoustic Bass Drum](035-acoustic-bass-drum.wav) | `bd8/BD5050.WAV` | 300 ms |
| 36 | [Bass Drum 1](036-bass-drum-1.wav) | `bd8/BD5025.WAV` | 220 ms |
| 37 | [Side Stick](037-side-stick.wav) | `rs8/RS.WAV` | 120 ms |
| 38 | [Acoustic Snare](038-acoustic-snare.wav) | `sd8/SD5050.WAV` | 220 ms |
| 39 | [Hand Clap](039-hand-clap.wav) | `cp8/CP.WAV` | 240 ms |
| 40 | [Electric Snare](040-electric-snare.wav) | `sd8/SD5075.WAV` | 240 ms |
| 41 | [Low Floor Tom](041-low-floor-tom.wav) | `lt8/LT25.WAV` | 260 ms |
| 42 | [Closed Hi Hat](042-closed-hi-hat.wav) | `ch8/CH.WAV` | 100 ms |
| 43 | [High Floor Tom](043-high-floor-tom.wav) | `lt8/LT75.WAV` | 240 ms |
| 45 | [Low Tom](045-low-tom.wav) | `mt8/MT25.WAV` | 220 ms |
| 46 | [Open Hi Hat](046-open-hi-hat.wav) | `oh8/OH50.WAV` | 350 ms |
| 47 | [Low Mid Tom](047-low-mid-tom.wav) | `mt8/MT75.WAV` | 200 ms |
| 48 | [Hi Mid Tom](048-hi-mid-tom.wav) | `ht8/HT25.WAV` | 180 ms |
| 49 | [Crash Cymbal 1](049-crash-cymbal-1.wav) | `cy8/CY5050.WAV` | 600 ms |
| 50 | [High Tom](050-high-tom.wav) | `ht8/HT75.WAV` | 170 ms |
| 56 | [Cowbell](056-cowbell.wav) | `cb8/CB.WAV` | 220 ms |
| 57 | [Crash Cymbal 2](057-crash-cymbal-2.wav) | `cy8/CY7550.WAV` | 600 ms |
| 62 | [Mute Hi Conga](062-mute-hi-conga.wav) | `hc8/HC50.WAV` | 100 ms |
| 63 | [Open Hi Conga](063-open-hi-conga.wav) | `hc8/HC50.WAV` | 220 ms |
| 64 | [Low Conga](064-low-conga.wav) | `lc8/LC50.WAV` | 240 ms |
| 70 | [Maracas](070-maracas.wav) | `ma8/MA.WAV` | 130 ms |
| 75 | [Claves](075-claves.wav) | `cl8/CL.WAV` | 100 ms |
