#!/bin/sh
set -eu
fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sources="$fixture_dir/../../android/app/src/main/java/dev/fountain/workspace"
java_home=${FOUNTAIN_JAVA_HOME:-${JAVA_HOME:-}}
if [ -n "$java_home" ]; then javac_bin="$java_home/bin/javac"; java_bin="$java_home/bin/java"; else javac_bin=$(command -v javac); java_bin=$(command -v java); fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/fountain-android-multiworkspace.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
"$javac_bin" --release 8 -d "$scratch" "$sources/NativePolicy.java" "$sources/NativeAccountPolicy.java" "$sources/NativeOrganizationPolicy.java" "$sources/NativeWorkspacePolicy.java" "$fixture_dir/NativeWorkspaceFixture.java" "$fixture_dir/PublicationCompositionFixture.java" "$fixture_dir/URIComponentCompositionFixture.java"
"$java_bin" -cp "$scratch" dev.fountain.workspace.NativeWorkspaceFixture

node "$fixture_dir/publication-composition.mjs" "$scratch/publication-urls.txt"
"$java_bin" -cp "$scratch" dev.fountain.workspace.PublicationCompositionFixture "$scratch/publication-urls.txt"
node "$fixture_dir/uri-composition.mjs" "$scratch/uri-vectors.txt"
"$java_bin" -cp "$scratch" dev.fountain.workspace.URIComponentCompositionFixture "$scratch/uri-vectors.txt"
