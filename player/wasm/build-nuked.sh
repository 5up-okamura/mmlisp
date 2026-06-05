#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
src_dir="$repo_root/third_party/Nuked-OPN2"
out_dir="$repo_root/player/wasm/dist"
adapter_src="$repo_root/player/wasm/nuked_adapter.c"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten first." >&2
  exit 1
fi

if [[ ! -f "$src_dir/ym3438.c" || ! -f "$src_dir/ym3438.h" ]]; then
  echo "error: Nuked-OPN2 source not found at $src_dir" >&2
  echo "expected files: ym3438.c, ym3438.h" >&2
  exit 1
fi

if [[ ! -f "$adapter_src" ]]; then
  echo "error: adapter source not found at $adapter_src" >&2
  exit 1
fi

mkdir -p "$out_dir"

emcc \
  "$adapter_src" \
  "$src_dir/ym3438.c" \
  -I"$src_dir" \
  -O3 \
  -s WASM=1 \
  -s SINGLE_FILE=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_nopn_init","_nopn_reset","_nopn_write_reg","_nopn_render","_nopn_get_buffer_ptr","_nopn_get_native_sample_rate"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAP16"]' \
  -o "$out_dir/nuked-opn2.js"

echo "Built $out_dir/nuked-opn2.js"

