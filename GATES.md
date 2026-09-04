# Gates: browserooms EXTEND — Entity + OpenClawWorld props + Levels 1-2

Scope: Fork at /Users/devgwardo/browserooms stays fully working; adds a stalking Entity
(sillyNubCat rig), OpenClawWorld GLB clutter, and a 3-level exit progression.
Baseline (clean clone, 2026-09-03): `bun test` 63 pass / 1 pre-existing fail
(early-materials manifest drift, upstream). Build: tsc+vite (to be verified).

- [x] G1: TypeScript + production build green
  CHECK: bash -c 'bun run build 2>&1 | tail -n 12'
  EXPECT: built in
  EVIDENCE: - Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting | - Adjust chunk size limit for this warning via build.chunkSizeWarningL

- [x] G2: Test suite — all baseline tests still pass, new entity/props/levels tests pass, only the 1 pre-existing failure remains
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: 81 pass
  EVIDENCE: 192112 expect() calls | Ran 82 tests across 15 files. [1.52s]

- [x] G3: OpenClawWorld assets vendored (sillyNubCat + 10 item GLBs served from public/)
  CHECK: bash -c 'ls public/models/sillyNubCat.glb public/models/items/*.glb | wc -l'
  EXPECT: 11
  EVIDENCE: 11

- [x] G4: Game boots in headless Chrome with no errors (loader hidden, canvas live)
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "loading\" role=\"status\"[^>]*hidden|error\" role=\"alert\"[^>]*hidden|canvas id=\"scene\"[^>]*width=\"[1-9]" | sort | uniq -c'
  EXPECT: canvas id="scene"
  EVIDENCE: 1 error" role="alert" hidden | 1 loading" role="status" aria-live="polite" hidden

- [x] G5: Entity logic unit-verified (stalk→chase on sight/sound, gaze-stun, catch, lurk-relocate, origin-shift safe)
  CHECK: bash -c 'bun test tests/entity.test.ts 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 26 expect() calls | Ran 8 tests across 1 file. [7.00ms]

- [x] G6: Props deterministic per chunk + clearance-respecting (no props blocking portals/spawn)
  CHECK: bash -c 'bun test tests/props.test.ts 2>&1 | tail -n 4'
  EXPECT: pass
  EVIDENCE: 90 expect() calls | Ran 5 tests across 1 file. [24.00ms]

- [ ] G7: Manual playtest — enter world, entity stalks/chases, alarm+entity coexist, exit door advances L0→L1→L2→escape screen, no console errors (dev server left running for user)
  EVIDENCE: pending

- [x] G8: Third-person view — V key / toolbar button toggles POV, OpenClawWorld avatar (sillyNubCat) follows the player, wall-aware boom (unit-tested), zero regressions
  CHECK: bash -c 'bun test tests/third-person.test.ts 2>&1 | tail -n 4'
  EXPECT: 4 pass
  EVIDENCE: 7 expect() calls | Ran 4 tests across 1 file. [30.00ms]

- [x] G9: Boot DOM exposes the view toggle after the extension
  CHECK: bash -c 'CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CHROME" --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=30000 --dump-dom http://127.0.0.1:5177/ 2>/dev/null | grep -o -E "id=\"view-toggle\"|V view" | sort | uniq -c'
  EXPECT: view-toggle
  EVIDENCE: 1 id="view-toggle" | 1 V view

- [x] G10: Third-person camera stays below the ceiling (lowered boom + true-3D boom solver)
  CHECK: bash -c 'bun test tests/third-person.test.ts 2>&1 | tail -n 4'
  EXPECT: 6 pass
  EVIDENCE: 11 expect() calls | Ran 6 tests across 1 file. [39.00ms]

- [ ] G11: Live on Vercel production at backrooms.nub.lol (HTTP 200, game boots)
  CHECK: bash -c 'curl -s -o /dev/null -w "%{http_code}\n" https://backrooms.nub.lol/; curl -s https://backrooms.nub.lol/ | grep -o -E "<title>[^<]*" | head -n 1'
  EXPECT: Backrooms
  EVIDENCE: pending — domain added to project; DNS CNAME missing (see below)

- [x] G12: Production deployment live on Vercel (title + kit + avatar + LUT + audio all 200)
  CHECK: bash -c 'curl -s https://backrooms-nub-lol.vercel.app/ | grep -o -E "<title>[^<]*"; for u in models/sillyNubCat.glb continuous/modules.json color/agx-medium-high.bin; do printf "%s:" "$u"; curl -s -o /dev/null -w "%{http_code}\n" "https://backrooms-nub-lol.vercel.app/$u"; done'
  EXPECT: Backrooms
  EVIDENCE: continuous/modules.json:200 | color/agx-medium-high.bin:200

- [x] G13: Perf trim — props stream only into the fog-visible inner ring (≤2/chunk), suite stays green
  CHECK: bash -c 'bun test 2>&1 | tail -n 4'
  EXPECT: 89 pass
  EVIDENCE: 192114 expect() calls | Ran 90 tests across 16 files. [1.52s]

- [ ] G14: Lag root-caused with measured A/B (forked vs upstream draw calls/tris), fix pushed
  CHECK: bash -c 'cat /tmp/perf-ab.txt'
  EXPECT: VERDICT
  EVIDENCE: pending
