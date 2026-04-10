# GMLisp Roadmap

## Phase 0: Spec and Authoring Validation

- Define language subset and IR
- Build minimal web playback validation path
- Produce demo songs and prune unnecessary commands
- Freeze v0.1

Current concrete outputs:

1. v0.1 spec draft
2. command table draft
3. IR draft
4. GMB format draft
5. freeze checklist

## Phase 1: Web Authoring Environment (GMLisp Live)

- Editor and diagnostics
- Transport controls and marker/loop visualization
- Parameter modulation panel
- Runtime intervention simulator

Phase 1 exit signal:

1. Demo songs can be edited and auditioned end-to-end in the web workflow

## Phase 2: Compiler and Format Stabilization

- Source parser and AST
- IR generation
- GMB binary writer
- Compatibility/version checks

Phase 2 exit signal:

1. Deterministic IR and GMB outputs for freeze demos

## Phase 3: Driver Implementation (GMLDRV)

- Minimal event playback on SGDK target
- Incremental command support based on frozen spec
- Performance/cycle-budget tuning

Phase 3 entry condition:

1. v0.1 freeze checklist complete

## Phase 4: Integration and Demo

- End-to-end toolchain: source to GMB to SGDK playback
- Example game-scene mappings for interactive music
- Documentation and migration notes for v0.2

## Immediate Local Backlog

1. Fill demo1-stage-loop and demo2-event-recovery with validation phrases
2. Produce initial IR snapshots in examples/ir
3. Produce initial GMB exports in examples/gmb
4. Record first actionable freeze review using docs/reviews template

---

## Future Vision (post-MVP ideas)

### GML `import` system

```lisp
(import "reverb"    :from :stdlib)
(import "dx7-brass" :from :patches)
(import "my-arp"    :from "https://gml.community/patches/okamura/arp01")
```

- `import` はマクロ展開として実装。コンパイル時に解決し IR に fold → ランタイム依存なし
- パッチの種類:
  - **関数エフェクト** (delay, arpeggiator, LFO, ...) — ir-player.js スケジューラーレイヤーで実装可能
  - **FM 音色** — `VOICE_LOAD` オペコードとして v0.2 スコープに定義
- バージョン固定 (`@1.2.3`) は再現性に必須

### パッチサーバー / コミュニティ

- `GET /patches/:slug[@version]` → GML スニペットまたは FM 音色 JSON
- 作者 ID + ライセンス + バージョン履歴をパッチに付与
- VGM コミュニティとの親和性：snesmusic / hcs64 等の既存フォーラム層

### フォーク & コラボレーション (GitHub モデル)

- 誰かがアップした音色を別の人が **fork して派生版として公開**できる
- fork 元への逆リンク（lineage）を保持 → 音色の系譜が辿れる
- PR 的な「改善提案」を元作者に送れる仕組みも検討
- 例: `dx7-brass` → fork → `dx7-brass-warmer` (by user B) → fork → `dx7-brass-warmer-megadrive` (by user C)

### マネタイゼーション

- パッチ URL ごとに作者の wallet / Stripe を紐付け
- 投げ銭（per-patch donation）
- プレミアムパッチ（有料 DL）も選択肢
