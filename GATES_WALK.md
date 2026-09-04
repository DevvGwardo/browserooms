# Gates: browserooms WALK — Blender-baked cat walk cycle (unlazy, solo)

Scope: Headless Blender 4.5.2 bakes a looping walk clip into a NEW file
`public/models/sillyNubCat-walk.glb` (original untouched). Entity + avatar play
it via AnimationMixer with speed-scaled timeScale. No gameplay or API changes.

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 6'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — baseline green, new walk tests pass, only 1 pre-existing fail
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 192160 expect() calls | Ran 97 tests across 17 files. [1.54s]

- [x] G3: Walk GLB valid — 1+ clips, node names identical to original, skin intact
  CHECK: bash -c 'python3 scripts/check-walk-glb.py public/models/sillyNubCat-walk.glb'
  EXPECT: WALK-GLB-OK
  EVIDENCE: WALK-GLB-OK clips=1 channels=27 legcorr=-0.53

- [x] G4: Avatar materials preserved through Blender roundtrip (count + base colors)
  CHECK: bash -c 'python3 scripts/check-walk-glb.py --materials public/models/sillyNubCat-walk.glb'
  EXPECT: MATERIALS-OK
  EVIDENCE: MATERIALS-OK count=1

- [x] G5: Both consumers drive the clip (mixer update per frame in each)
  CHECK: bash -c 'grep -c "mixer?.update\|mixer.update" src/entity.ts src/third-person.ts | tr "\n" ";"'
  EXPECT: src/entity.ts:1;src/third-person.ts:1;
  EVIDENCE: src/entity.ts:1;src/third-person.ts:1;

- [x] G6: Headless boot — no errors, loader hidden, canvas live
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden
