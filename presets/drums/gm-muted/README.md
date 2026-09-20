# GM ミュート・短音ドラムキット

[試聴・加工前との比較](index.html)。42音、22,050 Hz / signed 16-bit PCM / mono WAV。
ファイル名先頭はGMのMIDIノート番号です。GMに割り当てのない奏法はこのキットに含めていません。
番号は対応表であり、MMLispへのMIDIマッピング実装ではありません。

## 選択と加工

- スネアは手でミュートした奏法。Side Stickのみ対応するクロススティックを使用。
- タムは低タムのミュート奏法1音のみを使用。GMの6段階へ -5 / -3 / 0 / +2 / +4 / +7 半音リサンプリングして展開。これは相対的な音高設計で、GMがタムの絶対音高を定めているわけではありません。
- キックはスナッピーなし／ありを35／36に配置。
- コンガ、クイーカ、トライアングルはGMでミュート／オープンに別番号があるため両方を残しています。
- 元音にミュート奏法がない楽器は末尾のフェードで短縮しました。Low Congaは元音源のTumbaを使用。
- 金物もワンショットのフェード版。最短ループ化は未実施です。

先頭の -60 dBFS 未満の区間を除き、検出した立ち上がりの1 ms前から採用。
末尾は半コサインフェードでゼロに落とし、カットによる不連続を避けています。
音量の均一化・EQは行っていません。16-bitへの量子化にはTPDFディザを使用。
全加工値・元ファイル・ハッシュは[manifest.json](manifest.json)に記録しています。

長さは試聴用の初期値です。ハイハット100–350 ms、クラッシュ600 ms、ライド450 ms、
タム170–240 ms、ミュートスネア180 ms。聴感による最終調整は未実施です。
元の全長WAVはリポジトリに置かず、配布元から取得して加工しています。

## 未収録のGM音

元音源に対応する楽器がないため、以下の5音は未収録です。別楽器での置き換えはしていません。

| MIDIノート | 音色 |
| --- | --- |
| 39 | Hand Clap |
| 40 | Electric Snare |
| 52 | Chinese Cymbal |
| 55 | Splash Cymbal |
| 70 | Maracas |

元音源の「hh splash」はハイハットの足技であり、55番のSplash Cymbalには流用していません。
シェイカーも70番のMaracasには流用していません。

GMの対応範囲は35–81です。[GM Percussion Map](https://www.cs.cmu.edu/~music/cmp/archives/cmsip/readings/GMSpecs_PercMap.htm)。

## 出典

Virtuosity Drums / Versilian Studios・Karoryfer Samples / 演奏 Austin McMahon。
[配布元](https://github.com/sfzinstruments/virtuosity_drums)、コミット `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`。
CC0 1.0。[ライセンス全文](LICENSE-CC0.txt)。元音の来歴は[マニフェスト](manifest.json)の`source`に記録しています。
