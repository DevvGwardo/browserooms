#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${NTSC_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/ntsc-wasm.XXXXXX")}"
REVISION=76283f541173ac636f5935001ecdae93f31bb480
TOOLCHAIN=nightly-2025-12-26
SOURCE="$BUILD/ntsc-rs-web-76283f541173"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$BUILD"
if [ ! -d "$SOURCE/.git" ]; then
  git clone https://github.com/ntsc-rs/ntsc-rs-web.git "$SOURCE"
fi
git -C "$SOURCE" checkout --detach "$REVISION"
rustup toolchain install "$TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown

if [ "$(uname -sm)" = 'Darwin arm64' ]; then
  BINDGEN="$BUILD/wasm-bindgen-0.2.114-aarch64-apple-darwin/wasm-bindgen"
  if [ ! -x "$BINDGEN" ]; then
    curl -fL https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.114/wasm-bindgen-0.2.114-aarch64-apple-darwin.tar.gz -o "$BUILD/wasm-bindgen-0.2.114.tar.gz"
    printf '%s  %s\n' b0ef565865b3004bca5df72c83fef9256fa059e7aaa9075493f4e392b1d17350 "$BUILD/wasm-bindgen-0.2.114.tar.gz" | shasum -a 256 -c -
    tar -xzf "$BUILD/wasm-bindgen-0.2.114.tar.gz" -C "$BUILD"
  fi
else
  cargo +"$TOOLCHAIN" install wasm-bindgen-cli --version 0.2.114 --locked --root "$BUILD/bindgen"
  BINDGEN="$BUILD/bindgen/bin/wasm-bindgen"
fi

cd "$SOURCE/ntsc-rs-web-wrapper"
cargo +"$TOOLCHAIN" build --release --locked --target wasm32-unknown-unknown
"$BINDGEN" --target web --out-dir build --omit-default-module-path target/wasm32-unknown-unknown/release/ntsc_rs_web_wrapper.wasm
node "$ROOT/scripts/build_ntsc_wasm.mjs" "$PWD"
