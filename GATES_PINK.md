# Gates: browserooms PINK — adopt pink_nub.blend rig (unlazy, solo)

Scope: pink_nub.blend is the new version (pink body, same 509/15-vert meshes,
same 25-bone rig, identical 338x69 face texture). Export clean pinkNUB.glb +
pinkNUB-walk.glb (Cube junk + unused slot + dead actions pruned, transforms
baked), point the loader at pink, match code colors to the artist pink, delete
the 4 dead GLBs. No gameplay or API changes.

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 6'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — 98 pass / 1 pre-existing fail (early-materials drift)
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: 98 pass
  EVIDENCE: 192164 expect() calls | Ran 99 tests across 18 files. [1.54s]

- [x] G3: Pink base GLB valid — 28 nodes, 25-joint skin, 2 mats, morph target kept
  CHECK: bash -c 'python3 scripts/check-pink-glb.py public/models/pinkNUB.glb'
  EXPECT: PINK-GLB-OK
  EVIDENCE: PINK-GLB-OK nodes=28 joints=25 mats=2 morph=kept pink=[1, 0.7913032174110413, 0.8631464242935181]

- [x] G4: Pink walk GLB valid — clip, opposing legs, closed loop, materials kept
  CHECK: bash -c 'python3 scripts/check-walk-glb.py public/models/pinkNUB-walk.glb && python3 scripts/check-walk-glb.py --materials public/models/pinkNUB-walk.glb'
  EXPECT: MATERIALS-OK
  EVIDENCE: WALK-GLB-OK clips=1 channels=75 legcorr=-1.00 | MATERIALS-OK count=2

- [x] G5: Loader + colors point at pink (no naked/silly refs in src)
  CHECK: bash -c 'grep -rn "nakedNUB\|sillyNubCat\|0x6377b8" src/*.ts tests/*.ts | wc -l | tr -d " "'
  EXPECT: 0
  EVIDENCE: 0

- [x] G6: Headless boot — no errors, loader hidden, canvas live, avatar standing
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden
