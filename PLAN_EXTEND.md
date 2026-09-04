# PLAN: browserooms EXTEND (unlazy, solo)

Goal: keep upstream's endless-VHS-exploration soul; add horror pressure (Entity),
liminal clutter (OpenClawWorld props), and a finishable arc (3 levels + escape).

## Contracts (read before editing — upstream APIs I integrate with)
- `StreamedWorld`: `root`, `colliders: Collider[] {min[3],max[3]}` (world-space, origin-relative),
  `update(pos)` returns shift or null, `setOrigin`, `spawnAt`, `stats`, events `chunkload/chunkunload`
  with `{definition, object}` (object positioned at chunk offset; children local).
  Floating origin: EVERY free-floating sim object needs `shiftOrigin({x,z})`.
- `movePlayer(pos, dx, dz, colliders, radius)` — reuse for Entity sliding (radius 0.4).
- LOS pattern (from DistantAlarm): `THREE.Ray` + `ray.intersectBox(padded Box3)` over
  `world.colliders` filtered to `min[1]<1.8 && max[1]>0.1`.
- Interact pattern: `hit(x,y)` raycast ≤2.2m + click handler + `KeyF` handler in main.ts.
- Threat bus: `distant.update(elapsed, active, audible, lightThreat)` where
  `lightThreat = max(flicker?.threat ?? 0, alarm.threat)` → ADD `entity.threat`.
- Audio: classes take `getBus: () => AudioBus | null`, `prepare()` fetches assets.
  Entity adds ZERO audio files: procedural WebAudio drone (oscillator+gain, HRTF pan like alarm).
- `window.backrooms.state` diagnostics object in main.ts — extend with `entity`, `props`, `levels`.
- Tests run under bun; keep all 63 green. Pre-existing fail: early-materials (upstream drift, hands off).

## Leaves
1. L-props-assets: copy sillyNubCat.glb + 10 item GLBs → public/models[.] + G3.
2. L-entity (`src/entity.ts`, pure-logic core in `src/entity-logic.ts` for testability):
   states stalk/chase/stunned/lurk/taken; steering + movePlayer slide + unstick jitter;
   senses: LOS (AABB), hear (player speed>2.6 within 13m), see (range 7m, 17m if zoomed-gaze
   toward it... actually gaze STUNS: facing dot>0.94 + zoom>1.5 + <9m builds stun meter → 4s stun);
   catch <1.2m → taken: overlay div (CSS shake + red eyes, reuse jumpscare pattern from our R3F build),
   respawn at spawn, deaths counter; shiftOrigin; reset(clear); threat getter (chase proximity);
   diagnostics. Unit tests in tests/entity.test.ts against entity-logic (no WebGL needed).
3. L-props (`src/props.ts`): GLTFLoader cached; on chunkload pick 0-3 floor anchors via
   hash(seed:chunkId) seeded rand; fit: prop footprint ≤ anchor.clearance (fallback: skip);
   parent to chunk.object (auto-unload);Determinism test + clearance test in tests/props.test.ts.
4. L-levels (`src/levels.ts` + main.ts wiring): exit door mesh (procedural, emissive) + beacon
   oscillator placed at chunk (5,-3) room-center-ish (first floor anchor of that chunk, fallback
   spawnAt offset); click/F within 2.4m → advance: level index, worldSeed=`L${n}:${seed}`,
   rebuild world (remove root children? construct NEW StreamedWorld + scene.replace + new
   ExplorationMap + reset alarm/entity/props/trail), fog/background tint per level
   (L0 #302a15 / L1 #23282a concrete / L2 #1a1f1a dark), HUD banner div, after L2 → escaped
   overlay + time + restart. LEVELS pure config + tests/levels.test.ts.
5. L-verify: build, tests, headless boot, screenshots, ledger fill.

## Status log
- [2026-09-03] cloned (1.4G), baseline 63pass/1prefail, boot verified, gates+plan written.
- [2026-09-03] extensions done: entity + props + 3 levels, 81pass/1prefail, 6/7 gates (G7 manual).
- [2026-09-03] third-person view: ThirdPersonRig (render-offset apply/restore, zero sim changes),
  sillyNubCat avatar normalized to 0.55m, wall-aware boom (4 unit tests), V key + toolbar button.
  Verified headless in forced-third boot (avatar visible, no console errors), reverted to
  first-person default. 85pass/1prefail, 8/9 gates (G7 manual playtest with user).
- [2026-09-03] camera fix (G10): boom 4.2m/+2.0m → 3.6m/+1.1m; solver now true-3D
  (was eye-level band only, so ceilings never caught the boom). 6 solver tests incl.
  overhead-ceiling containment proof. Forced-third screenshot: camera inside room,
  ceiling + light panels visible, zero console errors. 87pass/1prefail, 9/10 gates.
