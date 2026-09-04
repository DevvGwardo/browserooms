// Auto-quality governor — pure logic, no three.js, unit-tested.
// Watches rolling FPS and steps render cost down/up with hysteresis so the
// game degrades gracefully on weak GPUs instead of slideshowing.

export const GOV_FACTORS = [1, 0.8, 0.65];
export const MAX_STEP = 3; // 0 full · 1 dpr×0.8 · 2 dpr×0.65 · 3 +bloom off
const DOWN_FPS = 40;
const UP_FPS = 57;
const DOWN_AFTER = 4; // seconds below DOWN_FPS before stepping down
const UP_AFTER = 20; // seconds above UP_FPS before stepping back up

export class AutoQuality {
  step = 0;
  enabled = true;
  private lowT = 0;
  private highT = 0;

  /** Returns true when the step changed and the renderer should re-apply. */
  update(dtSec: number, fps: number): boolean {
    if (!this.enabled || !Number.isFinite(fps) || fps <= 0 || dtSec <= 0) return false;
    if (fps < DOWN_FPS && this.step < MAX_STEP) {
      this.lowT += dtSec;
      this.highT = 0;
      if (this.lowT >= DOWN_AFTER) {
        this.step++;
        this.lowT = 0;
        return true;
      }
    } else if (fps > UP_FPS && this.step > 0) {
      this.highT += dtSec;
      this.lowT = 0;
      if (this.highT >= UP_AFTER) {
        this.step--;
        this.highT = 0;
        return true;
      }
    } else {
      this.lowT = 0;
      this.highT = 0;
    }
    return false;
  }

  factor(): number {
    return GOV_FACTORS[Math.min(this.step, GOV_FACTORS.length - 1)];
  }

  bloomOn(): boolean {
    return this.step < MAX_STEP;
  }

  reset() {
    this.step = 0;
    this.lowT = 0;
    this.highT = 0;
  }

  get diagnostics() {
    return { step: this.step, maxStep: MAX_STEP, enabled: this.enabled, factor: this.factor() };
  }
}
