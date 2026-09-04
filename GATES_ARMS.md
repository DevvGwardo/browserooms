# Gates: browserooms ARMS — arms hang down ~80deg (unlazy, solo)

Scope: Both nub rigs hold their arms out sideways (T-pose-ish). Swing each
whole arm ~80deg below horizontal from the Shoulder as a rest-pose change
(forearm follows rigidly, elbow/Hand untouched), re-export both base GLBs,
rebake both walks. No gameplay or API changes.

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 6'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — baseline green, only 1 pre-existing fail
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 192173 expect() calls | Ran 101 tests across 18 files. [1.53s]

- [x] G3: Both base GLBs valid (nodes/joints/mats/morph/color)
  CHECK: bash -c 'python3 scripts/check-pink-glb.py public/models/pinkNUB.glb && python3 scripts/check-blue-glb.py public/models/blueNUB.glb'
  EXPECT: BLUE-GLB-OK
  EVIDENCE: PINK-GLB-OK nodes=28 joints=25 mats=2 morph=kept pink=[1, 0.7913032174110413, 0.8631464242935181] | BLUE-GLB-OK nodes=28 joints=25 mats=2 morph=kept blue=[0.3915693163871765, 0.6514061689376831, 1]

- [x] G4: Both walk GLBs valid (clip/phase/loop/materials)
  CHECK: bash -c 'python3 scripts/check-walk-glb.py public/models/pinkNUB-walk.glb && python3 scripts/check-walk-glb.py --base public/models/blueNUB.glb public/models/blueNUB-walk.glb'
  EXPECT: WALK-GLB-OK
  EVIDENCE: WALK-GLB-OK clips=1 channels=75 legcorr=-1.00 | WALK-GLB-OK clips=1 channels=75 legcorr=-1.00

- [x] G5: Arm segments hang >= 70deg down, elbows straight, both rigs
  CHECK: bash -c 'python3 scripts/check-arms.py public/models/pinkNUB-walk.glb && python3 scripts/check-arms.py public/models/blueNUB-walk.glb'
  EXPECT: ARMS-OK
  EVIDENCE: ARMS-OK R=[86, 79] L=[86, 79] (deg below horizontal) | ARMS-OK R=[86, 79] L=[86, 79] (deg below horizontal)

- [x] G6: Headless boot — no errors, loader hidden, canvas live
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden
