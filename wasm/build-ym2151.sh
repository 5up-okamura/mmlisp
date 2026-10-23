#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="$repo_root/third_party/ymfm"
out_dir="$repo_root/wasm/dist"
out_file="$out_dir/ymfm-ym2151.js"
live_out_file="$repo_root/live/ymfm-ym2151.js"
adapter_src="$repo_root/wasm/ym2151_adapter.cpp"

if ! command -v em++ >/dev/null 2>&1; then
  echo "error: em++ not found. Install Emscripten first." >&2
  exit 1
fi

for f in ymfm_opm.cpp ymfm_opm.h; do
  if [[ ! -f "$src_dir/$f" ]]; then
    echo "error: ymfm source not found at $src_dir ($f)" >&2
    exit 1
  fi
done

if [[ ! -f "$adapter_src" ]]; then
  echo "error: adapter source not found at $adapter_src" >&2
  exit 1
fi

mkdir -p "$out_dir"

em++ \
  "$adapter_src" \
  "$src_dir/ymfm_opm.cpp" \
  -I"$src_dir" \
  -std=c++14 \
  -O3 \
  -fno-exceptions \
  -Wno-array-bounds \
  -s WASM=1 \
  -s SINGLE_FILE=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_y5_init","_y5_reset","_y5_write_reg","_y5_render","_y5_get_buffer_ptr","_y5_get_tap_ptr"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAP16","HEAPU8"]' \
  -o "$out_file"

cp "$out_file" "$live_out_file"

echo "Built $out_file"
echo "Synced $live_out_file"
