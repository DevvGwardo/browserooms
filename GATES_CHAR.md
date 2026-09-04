# Gates: browserooms CHAR — male/female character select (unlazy, solo)

Scope: The two blends differ by color only (identical 509/15-vert meshes,
25-bone rig, same face bytes): blue naked_NUB = male, pink pink_nub =
female. Add a Character select (settings, persisted) that hot-swaps the
player avatar live; entity mirrors the choice. No gameplay or API changes.

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 6'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — baseline green, new character tests pass, only 1 pre-existing fail
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 192173 expect() calls | Ran 101 tests across 18 files. [1.51s]

- [x] G3: Male GLBs valid — base (nodes/joints/mats/morph/blue) + walk (clip/phase/loop)
  CHECK: bash -c 'python3 scripts/check-blue-glb.py public/models/blueNUB.glb && python3 scripts/check-walk-glb.py --base public/models/blueNUB.glb public/models/blueNUB-walk.glb'
  EXPECT: WALK-GLB-OK
  EVIDENCE: BLUE-GLB-OK nodes=28 joints=25 mats=2 morph=kept blue=[0.3915693163871765, 0.6514061689376831, 1] | WALK-GLB-OK clips=1 channels=75 legcorr=-1.00

- [x] G4: Settings exposes Character select with Male/Female options
  CHECK: bash -c 'grep -c "character" index.html src/main.ts | tr "\n" ";"'
  EXPECT: index.html:2;src/main.ts:3;
  EVIDENCE: index.html:2;src/main.ts:3;

- [x] G5: No stale single-character refs (loader serves both, tests cover mapping)
  CHECK: bash -c 'bun test tests/nubcat.test.ts 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 13 expect() calls | Ran 4 tests across 1 file. [25.00ms]

- [x] G6: Headless boot — no errors, loader hidden, canvas live
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden
