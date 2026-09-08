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
# BLASTEM_OUT lets a run build somewhere OTHER than drv/out/blastem. That is
# what makes "does this reproduce from a clean tree?" a question with an answer:
# the existing working copy cannot be the evidence for itself (R9 §26.2).
out="${BLASTEM_OUT:-$here/../out/blastem}"
src="$out/src"
# `libretro`, not `master`: that mirror's master is an old snapshot with no
# Makefile.libretro at all, and the branch we want is the repository's own HEAD.
# Pinned by name rather than by commit so a fix upstream is one pull away; if a
# run ever needs the exact tree again, BLASTEM_REV takes a commit.
branch="${BLASTEM_BRANCH:-libretro}"
# BLASTEM_REV takes a COMMIT, and a commit is not a branch: `git clone --branch`
# refuses one. So the branch is cloned and the commit is fetched and checked out
# on top, which is what lets a result name the exact tree it was built from.
#
# PINNED BY DEFAULT, because probe.patch is a context diff and a moving branch
# head is a moving target: the day it stops applying, this script now fails
# instead of quietly building an unpatched core (R9 §26.2). `BLASTEM_REV=libretro`
# follows the branch again, which is what you want when moving the pin forward.
rev_wanted="${BLASTEM_REV:-b4d75247ebad8852fd9bc385b423df704c6c5af5}"
repo="${BLASTEM_REPO:-https://github.com/libretro/blastem.git}"

mkdir -p "$out"

if [ ! -d "$src/.git" ]; then
    echo "blastem: cloning $repo ($branch)"
    git clone --depth 1 --branch "$branch" "$repo" "$src"
    if [ "$rev_wanted" != "$branch" ]; then
        echo "blastem: checking out $rev_wanted"
        ( cd "$src" && git fetch --depth 1 origin "$rev_wanted" \
            && git checkout --detach FETCH_HEAD ) || {
            echo "blastem: $rev_wanted is not reachable in $repo" >&2; exit 1; }
    fi
else
    echo "blastem: reusing $src"
fi

# The probe patch, if there is one. Kept as a patch rather than a fork so that
# what we changed about the emulator is one readable diff — and so a run can be
# repeated against a stock core to check that the patch is not the finding.
#
# APPLIED, ALREADY APPLIED and DOES NOT APPLY ARE THREE ANSWERS, not two. The
# earlier form ran `git apply --check` and, on any failure, printed "already
# applied (or does not apply)" and carried on building. So a tree with an OLD
# version of the patch in it — which is what a rebuild after the patch grows
# looks like — silently kept the old emulator, and every test that depended on
# the new hunks passed against a core that did not contain them. That is how
# the RAM watch came to exist only in an untracked working copy.
if [ -f "$here/probe.patch" ]; then
    if ( cd "$src" && git apply --check "$here/probe.patch" 2>/dev/null ); then
        ( cd "$src" && git apply "$here/probe.patch" )
        echo "blastem: probe patch applied"
    elif ( cd "$src" && git apply --reverse --check "$here/probe.patch" 2>/dev/null ); then
        echo "blastem: probe patch already applied in full"
    else
        echo "blastem: probe.patch neither applies nor is applied to $src." >&2
        echo "         The tree is at some other state — most likely an older" >&2
        echo "         version of the patch. Building from it would produce a" >&2
        echo "         core that is not the one this patch describes." >&2
        echo "         Remove $src and re-run, or reconcile it by hand." >&2
        exit 1
    fi
fi

# The patch is applied ONLY if it fully reverses, which is the same check the
# "already applied" branch uses. A partially applied patch is caught here even
# if `git apply` succeeded on a subset of hunks for some reason.
if [ -f "$here/probe.patch" ]; then
    ( cd "$src" && git apply --reverse --check "$here/probe.patch" 2>/dev/null ) || {
        echo "blastem: probe.patch is not fully applied to $src after the attempt" >&2
        exit 1
    }
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

# What was actually built, so a result can say which core produced it.
rev=$( cd "$src" && git rev-parse HEAD )
patch_hash=$( shasum -a 256 "$here/probe.patch" 2>/dev/null | cut -c1-16 \
              || sha256sum "$here/probe.patch" | cut -c1-16 )
core_hash=$( shasum -a 256 "$core" 2>/dev/null | cut -c1-16 \
             || sha256sum "$core" | cut -c1-16 )
cat > "$out/build.json" <<JSON
{ "revision": "$rev", "patch": "$patch_hash", "core": "$core_hash",
  "repo": "$repo", "rev_name": "$rev_wanted" }
JSON

echo "blastem: ready — $out/host, $core"
echo "blastem: revision $rev, patch $patch_hash, core $core_hash"
