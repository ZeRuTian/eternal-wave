# decimen-codec v0.2.0

Copyright (c) 2026 Evan Crawley (Bash Alarmist).
AGPL-3.0-or-later; see the repository root LICENSE. Generated Emscripten
JavaScript runtime output is MIT-licensed. Unmodified zxing-cpp is Apache-2.0;
see LICENSE.zxing-cpp. Earlier MIT application portions retain LICENSE-MIT.

JS/WASM/type artifacts were obtained without modification from:
https://github.com/bashalarmistalt/decimen-optical-transfer/tree/5301fc2020716b5a97d4edf6e1793c3dedbf6e17/vendor/decimen-codec

The binary banner/runtime identifies build dc2b8c5. Complete codec source is
pinned as third_party/decimen-codec, including its nested zxing-cpp submodule.
Source: https://github.com/bashalarmistalt/decimen-codec/tree/dc2b8c5
Build: git submodule update --init --recursive, then run
third_party/decimen-codec/build.sh (Emscripten 6.0.6 pinned by upstream).

Eternal Wave's own adapter, framing, multi-code renderer and tests are in this
repository. See README.md for application builds and corresponding-source
archive instructions. No upstream protocol change was imported.
