# ntsc-rs WebAssembly Runtime

Unmodified official `ntsc-rs-web-wrapper`, compiled locally from:

- Wrapper: https://github.com/ntsc-rs/ntsc-rs-web/commit/76283f541173ac636f5935001ecdae93f31bb480
- Engine: https://github.com/ntsc-rs/ntsc-rs/commit/bddab2df789162391aa1981271a3d698a478f2e7
- Rust: `nightly-2025-12-26`, `wasm32-unknown-unknown`, release profile.
- wasm-bindgen CLI and locked crate: `0.2.114`.

`provenance.json` records all dependency versions and the WASM SHA-256;
`Cargo.lock` is copied unchanged from the pinned wrapper. This build uses the
baseline target, not relaxed SIMD, and does not run optional `wasm-opt`.
No upstream editor, codec, Preact, or runtime remote dependency is included.

## Build

From the project root, run `bash scripts/build_ntsc_wasm.sh`. It checks out and
builds in a temporary directory, installs the explicitly named Rust toolchain
without changing the global default, and keeps wasm-bindgen local to the build
directory. `NTSC_BUILD_DIR` can point to an existing build cache.

## Integration

The application entry point is `src/vhs/engine.worker.ts`:

```ts
const worker = new Worker(new URL('./vhs/engine.worker.ts', import.meta.url), {
  type: 'module',
});
worker.postMessage({ type: 'init' });
```

Wait for `{type: 'ready', engine: 'ntsc-rs', revision}`. Transfer one `VideoFrame`
or `ImageBitmap` per frame message; the worker closes its input. The returned
`ImageBitmap` belongs to the caller and must be closed after use. Both success
and error messages complete a frame request. Processing never queues frames.

The worker's exported `FrameRequest` documents the frame protocol. Width and
height are output processing dimensions, not necessarily source dimensions.
The WASM URL uses Vite's `?url` asset handling, so it is bundled and self-hosted.
Browser prerequisites: module workers, WebAssembly, OffscreenCanvas 2D, and
createImageBitmap. VideoFrame is optional when using ImageBitmap input.

## Settings

`settings.generated.ts` exports `SETTINGS`, `DEFAULT_SETTINGS`, and `SettingId`.
The descriptors include exact idName keys, numeric IDs, bounds, enum options,
group children, and current defaults, extracted from this binary.
`default-settings.json` is the engine's complete modern default preset.

Frame settings are concise flat overrides. The worker merges them over
`JSON.parse(settingsList.defaultPreset())` and forces `version: 1` before
calling `settingsFromJSON`. It does not rely on legacy partial-preset defaults.
Group boolean switches must be enabled for their children to have an effect.
Unknown/invalid values should be avoided; Rust reports invalid enum values.

Important enum values:

- `use_field`: 0 alternating, 1 upper, 2 lower, 3 both, 4 interleaved upper first,
  5 interleaved lower first. Default 4.
- `vhs_tape_speed`: 0 none, 1 SP, 2 LP, 3 EP. Default 2.
- `chroma_demodulation`: 0 box, 1 notch, 2 one-line comb, 3 two-line comb.
  Comb filters require `video_scanline_phase_shift: 2` (180 degrees).
- `chroma_lowpass_in` / `chroma_lowpass_out`: 0 none, 1 light, 2 full.
- `filter_type`: 0 constant K, 1 Butterworth. Default 1.

Noise, head switching, tracking, edge wave, sharpening, and bandwidth all have
real engine settings in the schema. `chroma_phase_error: 0` avoids a fixed hue
shift. The worker neither adds a shader approximation nor modifies presets.

For direct runtime use, the glue exports `NtscEffectBuf`, `NtscSettingsList`,
`ResizeFilter` (Nearest 0, Bilinear 1, Bicubic 2), and `Rotation` (None 0, Cw90 1,
Cw180 2, Cw270 3). `setEffectSettings` consumes its `NtscConfigurator`.
Reacquire `inputBuffer` each frame; never retain WASM views across allocating
calls. `EffectOutput.free()` releases the handle, not the engine-owned pixels.

## Verification And Licenses

`assets/vhs/verify-engine.mjs` runs isolated headless Chrome tests using an
available Playwright installation (`PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs`).
It exercises the actual binary, output dimensions/alpha, native/fallback frame
copies, init/error recovery, busy rejection, settings caching, resource cleanup,
and a 6,000-frame allocation plateau test. It does not open the application UI.

The wrapper is dual MIT/Apache-2.0 licensed. `LICENSE_MIT`, `LICENSE_APACHE`,
`THIRD_PARTY_LICENSES.txt`, `HIFIJSON_NOTICE.txt`, and `RUST_LIBRARY_COPYRIGHT.html`
retain upstream and dependency notices. The Rust library notice includes the
toolchain's standard-library attributions. Keep these notices with distributions.
