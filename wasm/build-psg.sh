#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
src_dir="$repo_root/third_party/Nuked-PSG"
out_dir="$repo_root/player/wasm/dist"
out_file="$out_dir/nuked-psg.js"
live_out_file="$repo_root/live/nuked-psg.js"
adapter_src="$repo_root/player/wasm/psg_adapter.c"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten first." >&2
  exit 1
fi

if [[ ! -f "$src_dir/ympsg.c" || ! -f "$src_dir/ympsg.h" ]]; then
  echo "error: Nuked-PSG source not found at $src_dir" >&2
  echo "expected files: ympsg.c, ympsg.h" >&2
  exit 1
fi

if [[ ! -f "$adapter_src" ]]; then
  echo "error: adapter source not found at $adapter_src" >&2
  exit 1
fi

mkdir -p "$out_dir"

emcc \
  "$adapter_src" \
  "$src_dir/ympsg.c" \
  -I"$src_dir" \
  -O3 \
  -s WASM=1 \
  -s SINGLE_FILE=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_psg_init","_psg_reset","_psg_write","_psg_render","_psg_get_buffer_ptr","_psg_get_channel_buffer_ptr","_psg_get_native_sample_rate"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
  -o "$out_file"

cp "$out_file" "$live_out_file"

echo "Built $out_file"
echo "Synced $live_out_file"
