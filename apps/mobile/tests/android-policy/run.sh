#!/bin/sh
set -eu

# Pure JVM policy checks only. These neither compile Android APIs nor use an SDK.
fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mobile_dir=$(CDPATH= cd -- "$fixture_dir/../.." && pwd)
java_home=${FOUNTAIN_JAVA_HOME:-${JAVA_HOME:-}}
if [ -n "$java_home" ]; then
    javac_bin="$java_home/bin/javac"
    java_bin="$java_home/bin/java"
else
    javac_bin=$(command -v javac || true)
    java_bin=$(command -v java || true)
fi
if [ ! -x "$javac_bin" ] || [ ! -x "$java_bin" ]; then
    printf '%s\n' 'A JDK is required: set JAVA_HOME or FOUNTAIN_JAVA_HOME.' >&2
    exit 1
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/fountain-android-policy.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
sources="$mobile_dir/android/app/src/main/java/dev/fountain/workspace"
"$javac_bin" -d "$scratch" "$sources/NativePolicy.java" "$sources/NativeCookieBoundary.java" "$fixture_dir/NativePolicyFixture.java"
"$java_bin" -cp "$scratch" dev.fountain.workspace.NativePolicyFixture
