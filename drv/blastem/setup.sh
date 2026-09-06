#!/bin/sh
# Fetch and build BlastEm as a libretro core, and build the frontend that drives
# it. Everything lands in drv/out/blastem/ and nothing is installed system-wide.
#
#   sh drv/blastem/setup.sh
#
# The core is built through Makefile.libretro, which produces a plain shared
# object with NO SDL, NO X11 and no audio device — that is what lets the
# emulator run in a container, from a script, with the result arriving as a
# file. The desktop `blastem` binary needs a display and is not built here.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out="$here/../out/blastem"
src="$out/src"
# `libretro`, not `master`: that mirror's master is an old snapshot with no
# Makefile.libretro at all, and the branch we want is the repository's own HEAD.
# Pinned by name rather than by commit so a fix upstream is one pull away; if a
# run ever needs the exact tree again, BLASTEM_REV takes a commit.
rev="${BLASTEM_REV:-libretro}"
repo="${BLASTEM_REPO:-https://github.com/libretro/blastem.git}"

mkdir -p "$out"

if [ ! -d "$src/.git" ]; then
    echo "blastem: cloning $repo ($rev)"
    git clone --depth 1 --branch "$rev" "$repo" "$src"
else
    echo "blastem: reusing $src"
fi

# The probe patch, if there is one. Kept as a patch rather than a fork so that
# what we changed about the emulator is one readable diff — and so a run can be
# repeated against a stock core to check that the patch is not the finding.
if [ -f "$here/probe.patch" ]; then
    ( cd "$src" && git apply --check "$here/probe.patch" 2>/dev/null \
        && git apply "$here/probe.patch" && echo "blastem: probe patch applied" ) \
      || echo "blastem: probe patch already applied (or does not apply) — continuing"
fi

echo "blastem: building the libretro core"
# `nproc` is coreutils and macOS does not have it.
jobs=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
( cd "$src" && make -f Makefile.libretro core -j"$jobs" >/dev/null )
# The core is a .so on Linux and a .dylib on macOS; take whichever appeared and
# keep its own name, because the frontend is told the path anyway.
for so in blastem_libretro.so blastem_libretro.dylib; do
    [ -f "$src/$so" ] && cp "$src/$so" "$out/$so" && core="$out/$so"
done
[ -n "${core:-}" ] || { echo "blastem: the core did not build"; exit 1; }

echo "blastem: building the frontend"
# -ldl is Linux; on macOS dlopen is in libSystem and the flag is an error.
cc -O2 -Wall -o "$out/host" "$here/host.c" $(uname | grep -q Linux && echo -ldl)

echo "blastem: ready — $out/host, $core"
