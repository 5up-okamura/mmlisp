# MMLisp プリセット

作曲に使う音色とサンプルの置き場です。`.mmlisp` のバンクは `import` で読み込み、
WAV は `def :sample` から参照します。

## 構成

| 場所 | 中身 |
| --- | --- |
| [gm/](gm/README.md) | GM 128音色のFMバンク（libOPNMIDI XG由来、MIT） |
| [waveforms/](waveforms/README.md) | 基本波形6音色。[NES / VRC6風の解説](waveforms/nes-vrc6.md)も同じバンク |
| [acid/](acid/README.md) | TB-303風のベース音色とアクセント／スライドの書き方 |
| [drums/](#pcmドラム用の無料サンプル) | PCM用のドラムキット（[TR-808系22音](drums/tr808-gm/README.md) / [GMミュート42音](drums/gm-muted/README.md)） |

試聴スコアは `examples/source/` にあります（[一覧](../examples/README.md)）。
Liveで開くときは File > Open Folder… でリポジトリのルートを選んでください。

比較試聴用のレンダリングWAVはリポジトリに含めません。`tools/scripts/render-*.mjs`
を実行すると `presets/_renders/` に生成されます。測定値は各セットのレポートJSONに
コミットしています。

## PCMドラム用の無料サンプル

同梱しているのは2キットです。どちらも 22.05 kHz / 16-bit / mono、長いサンプルは
フェードで短縮済み。GM のノート番号でファイル名を付けています。

- [808 GM番号キット（22音）](drums/tr808-gm/README.md)
- Virtuosity Drums由来の[GMミュート・短音キット（42音）](drums/gm-muted/README.md)

下表は、同梱を検討した配布元の条件です（2026-09-19に確認）。

| 音源 | 配布元での条件 | 用途 |
| --- | --- | --- |
| [Virtuosity Drums](https://versilian-studios.com/virtuosity-drums/) | CC0 | 生ドラム＋補助パーカッション。サンプルを加工・同梱する用途の第一候補 |
| [Salamander Drumkit](https://github.com/endolith/Salamander-Drumkit) | 作者が2022年に自身のサンプル音源をパブリックドメイン化 | 生ドラム。旧配布物にはCC BY-SA表記が残るため、作者の声明も保存する |
| [99 Drum Samples](https://99sounds.org/drum-samples/) | 商用作品利用可、音声ファイル単体の再配布不可 | 個人でダウンロードして楽曲に使う用途。リポジトリのサンプル集としての同梱には不向き |

条件の根拠: [Salamander作者の声明](https://rytmenpinne.wordpress.com/2022/03/04/good-news-everyone/)、
[99Soundsライセンス](https://99sounds.org/license/)。SFZのマッピングや第三者の追加ファイルは、
サンプル本体とは別に配布物のライセンスを確認してください。

MMLispにはSFZ全体ではなく、キック、スネア、ハイハットなど必要なWAVを選んで読み込みます。
対応するPCM WAV形式に変換し、短いワンショットに整えて既存の`def :sample`で使用します。
記法とPCMの発音数・レートは[ガイドのPCM節](../docs/guide.md)を参照してください。
このFMバンクの113–120番は旋律用パーカッションであり、GMチャンネル10のドラムキットとは別です。

## 基本波形

[アナログ基本波形](waveforms/README.md)はサイン、三角、ノコギリ、矩形、25%・12.5%風パルスの6音色。
同じバンクを[NES / VRC6風](waveforms/nes-vrc6.md)の視点でも説明しています。GMバンクとは別です。

## 303風ベース

[通常FMの303風音色・アクセント／スライド演奏](acid/README.md)。鋸歯状波版と矩形波版があります。
