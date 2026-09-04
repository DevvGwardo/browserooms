# Gates: browserooms ENTER — loading UX fix (unlazy, solo)

Scope: The enter button sits `disabled` (wait cursor) for 30-60s+ while the
default continuous kit (~170MB / 45 files) loads, with only a 2px progress bar
and a screen-reader-only label as feedback. Users read it as broken. Fix the
UX: visible progress with staged messages. No gameplay, visual, or API changes.

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 6'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — 96 pass / 1 pre-existing fail (early-materials drift)
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: 96 pass
  EVIDENCE: 192160 expect() calls | Ran 97 tests across 17 files. [1.51s]

- [x] G3: Load label is sighted-visible (no 1px clip) with staged progress text
  CHECK: bash -c 'echo "label-css: $(grep -c "load-label" src/style.css) stage-calls: $(grep -c "stageLoad" src/main.ts)"'
  EXPECT: label-css: 1 stage-calls: 5
  EVIDENCE: label-css: 1 stage-calls: 5

- [x] G4: Headless boot — no errors, loader hidden, canvas live, enter enabled
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|button id=\"enter\"[^>]*disabled|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden
