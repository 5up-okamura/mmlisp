# NES / VRC6風 YM2612プリセット

[MMLisp音色定義](waveforms.mmlisp) /
[試聴スコア](../../examples/source/nes-vrc6-audition.mmlisp)

1音色につきYM2612のFMを1チャンネル使用する、5種類の持続音です。
アタックは速く、キーオフで止まります。サンプル再生は使いません。

| 名前 | 狙い・構成 |
| --- | --- |
| `wave-square` | 50%矩形波。2倍周波数の変調器を直列接続し、奇数倍音を生成 |
| `wave-pulse-25` | 25%風パルス。ALG 5、4倍の変調器と1・2・3倍のキャリア |
| `wave-pulse-12-approx` | 12.5%パルスの低次倍音に寄せた音。1–4次の加算合成で、高次倍音は不足 |
| `wave-triangle` | 三角波に近い柔らかい音。1・3・5・7次の倍音を概ね1/n²で加算 |
| `wave-saw` | VRC6鋸歯状波を意識した音。等倍の変調器を直列接続 |

音色定義は基本波形バンクに統合しています。NES／VRC6別名や75%用の重複定義はありません。

## 使用例

`examples/source/`内のスコアから:

```lisp
(import "../../presets/waveforms/waveforms.mmlisp")

(fm1 :tempo 150 :oct 4 :len 8 :vel 12
  wave-square c e g > c < g e c _)
(fm2 :oct 3 :len 8 :vel 10
  wave-pulse-25 e g > c < g e g > c < _)
(fm3 :oct 2 :len 4 :vel 12
  wave-triangle c g c g)
```

音色は`nes-…`／`vrc6-…`の名前で直接定義しています。
音色選択は音高・共有LFOレートを書き換えません。AMS/FMSは音色の値（0）を設定します。
音量エンベロープ、アルペジオ、ビブラートは既存のMMLispマクロを音色選択後に追加できます。

## 再現の範囲

これはチップのエミュレーションではなく、FMによる音色の近似です。
**デューティ比の完全再現、VRC6の8段階すべてのパルス、正確なPWMは未対応**です。
特に12.5%の高域の鋭さは4オペレータでは不足します。
三角波の加算合成は倍音振幅を近づけますが、各オペレータの開始位相を自由に設定できないため、
NESの32ステップの波形形状は一致しません。鋸歯状波もVRC6の階段状アキュムレータの再現ではありません。
NESの非線形ミキサー、タイマー量子化、スイープ・長さカウンタも再現しません。

NESノイズはLFSR、DPCMはサンプル再生なので、この5音には含めていません。
それらはPSGの`noise`やPCMで組み合わせるのが実用的です。FMのみで作る場合は
ノイズ風の別音色という扱いになり、NESノイズと一致しません。

## 検証と試聴

比較WAVのFM側は、この音色定義をコンパイルしたレジスタを、リポジトリの
Nuked-OPN2コアへ書いて生成しています。低・中・高（C3 / C4 / C5）を順に鳴らします。
基準側は数式から生成したパルス、32ステップ三角波、7段階鋸歯状波で、実機録音ではありません。
基準側の鋸歯状波はVRC6の音量設定によるビット切り捨てなどを省略した比較モデルです。
比較のためWAVだけDC除去とRMS音量合わせを行っています。プリセット自体のTLには適用しません。
WAVはコアのネイティブレートを整数化した53,267 Hz、16-bit monoです。

コンパイル・MMB出力を検証し、生成WAVの倍音分布も確認しています。
人による聴感評価はまだ行っていません。まず比較試聴で方向性を確認するためのバンクです。

```sh
node tools/scripts/render-nes-vrc6.mjs
```

## 参考

- [Plutiedev: Chiptune sounds](https://www.plutiedev.com/chiptune-sounds): 矩形波・鋸歯状波・25%風パルスのFM構成を参考にし、エンベロープと倍音バランスを調整。
- [NESdev: APU Pulse](https://www.nesdev.org/wiki/APU_Pulse)
- [NESdev: APU Triangle](https://www.nesdev.org/wiki/APU_Triangle)
- [NESdev: VRC6 audio](https://www.nesdev.org/wiki/VRC6_audio)
