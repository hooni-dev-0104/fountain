#!/bin/sh
set -eu
fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mobile_dir=$(CDPATH= cd -- "$fixture_dir/../.." && pwd)
java_home=${FOUNTAIN_JAVA_HOME:-${JAVA_HOME:-}}
if [ -n "$java_home" ]; then javac_bin="$java_home/bin/javac"; java_bin="$java_home/bin/java"; else javac_bin=$(command -v javac); java_bin=$(command -v java); fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/fountain-android-organization.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
sources="$mobile_dir/android/app/src/main/java/dev/fountain/workspace"
"$javac_bin" --release 8 -d "$scratch" "$sources/NativePolicy.java" "$sources/NativeOrganizationPolicy.java" "$fixture_dir/NativeOrganizationFixture.java"
"$java_bin" -cp "$scratch" dev.fountain.workspace.NativeOrganizationFixture
