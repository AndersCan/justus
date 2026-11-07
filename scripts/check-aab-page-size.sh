#!/usr/bin/env bash
# Fails if any LOAD segment of a 64-bit .so in the AAB is aligned below
# 0x4000 (16 KB), which Google Play rejects.
# Usage: READELF=llvm-readelf scripts/check-aab-page-size.sh <app.aab>
set -euo pipefail

archive="${1:?usage: check-aab-page-size.sh <app.aab>}"
readelf="${READELF:-llvm-readelf}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

unzip -q "$archive" -d "$dir"
fail=0
count=0
for abi in arm64-v8a x86_64; do
  for so in "$dir/base/lib/$abi"/*.so; do
    [ -e "$so" ] || continue
    count=$((count + 1))
    out="$("$readelf" -lW "$so")"
    aligns="$(printf "%s\n" "$out" | awk '$1 == "LOAD" { print $NF }')"
    if [ -z "$aligns" ]; then
      echo "$abi/$(basename "$so"): no LOAD segments" >&2
      fail=1
    fi
    while read -r align; do
      [ -n "$align" ] || continue
      echo "$abi/$(basename "$so") LOAD align $align"
      if [ $((align)) -lt $((0x4000)) ]; then
        echo "  ^ below 0x4000" >&2
        fail=1
      fi
    done <<< "$aligns"
  done
done

if [ "$count" -eq 0 ]; then
  echo "no 64-bit .so files found under base/lib" >&2
  exit 1
fi
exit "$fail"
