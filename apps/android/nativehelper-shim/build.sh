#!/usr/bin/env bash
# Rebuilds the libnativehelper.so shim (ekrooh#45) into app/src/main/nativehelper.
# 16 KB page alignment is required by Google Play for 64-bit libraries.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ndk="$sdk/ndk/27.2.12479018"
bin="$(echo "$ndk"/toolchains/llvm/prebuilt/*/bin)"
out="$here/../app/src/main/nativehelper"
api=29

build() { # abi triple extra-flags...
  local abi=$1 triple=$2; shift 2
  mkdir -p "$out/$abi"
  "$bin/$triple$api-clang" -shared -fPIC -O2 "$@" \
    -Wl,-soname,libnativehelper.so \
    -Wl,--version-script="$here/shim.map" \
    -Wl,-z,max-page-size=16384 \
    -o "$out/$abi/libnativehelper.so" "$here/shim.c"
  "$bin/llvm-strip" --strip-unneeded "$out/$abi/libnativehelper.so"
}

build arm64-v8a aarch64-linux-android -mbranch-protection=standard
build x86_64 x86_64-linux-android
build armeabi-v7a armv7a-linux-androideabi
build x86 i686-linux-android
