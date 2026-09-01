import * as THREE from "three";
import type { AudioBus } from "./light-ambience";
import type { StreamedWorld } from "./streamed-world";

type Voice = { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; pan: PannerNode; stopping: boolean };

export class DistantAlarm {
  error: string | null = null;
  private wait = 100 + Math.random() * 120;
  private elapsed = 0;
  private played = 0;
  private silenced = 0;
  private ringing = false;
  private active = false;
  private audible = false;
  private level = 0;
  private buffer: AudioBuffer | null = null;
  private preparing: Promise<void> | null = null;
  private voice: Voice | null = null;
  private root = new THREE.Group();
  private indicator = new THREE.MeshBasicMaterial({ color: 0x38231e });
  private button: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private normalMatrix = new THREE.Matrix3();
  private pickCamera = new THREE.PerspectiveCamera();
  private walls: THREE.Object3D[] = [];
  private point = new THREE.Vector3();
  private box = new THREE.Box3();
  private enabledView = false;

  constructor(private camera: THREE.PerspectiveCamera, private getBus: () => AudioBus | null,
    private changed: () => void, private getWorld: () => StreamedWorld, scene: THREE.Scene) {
    this.root.name = "Wall alarm";
    this.root.visible = false;
    scene.add(this.root);
    // Face shading is explicit because the architecture uses baked lighting, not scene lights.
    const side = new THREE.MeshBasicMaterial({ color: 0x787765 });
    const top = new THREE.MeshBasicMaterial({ color: 0xb4b09a });
    const bottom = new THREE.MeshBasicMaterial({ color: 0x626151 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x282820 });
    const red = new THREE.MeshBasicMaterial({ color: 0x783d2d });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      this.root.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(0.268, 0.36, 0.018), side, 0, 0, 0.017);
    add(new THREE.BoxGeometry(0.245, 0.336, 0.084), [side, side, top, bottom, top, side], 0, 0, 0.058);
    const face = document.createElement("canvas");
    face.width = 256; face.height = 384;
    const ctx = face.getContext("2d")!;
    ctx.fillStyle = "#b6b097";
    ctx.fillRect(0, 0, 256, 384);
    let seed = 71;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = i % 3 ? "rgba(55,48,33,0.055)" : "rgba(239,229,199,0.16)";
      ctx.fillRect(random() * 256, random() * 384, 1 + random() * 7, 1 + random() * 2);
    }
    ctx.fillStyle = "#39392f";
    ctx.font = '500 30px "Helvetica Neue", Helvetica, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("Alarm", 116, 61);
    ctx.font = '24px "Helvetica Neue", Helvetica, sans-serif';
    ctx.fillText("Silence", 128, 358);
    const texture = new THREE.CanvasTexture(face);
    texture.colorSpace = THREE.SRGBColorSpace;
    add(new THREE.PlaneGeometry(0.225, 0.316), new THREE.MeshBasicMaterial({ map: texture }), 0, 0, 0.101);
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.144, 0.006, 0.003), dark, 0, 0.053 - i * 0.016, 0.104);
    const surround = add(new THREE.CylinderGeometry(0.046, 0.046, 0.012, 24), dark, 0, -0.097, 0.109);
    surround.rotation.x = Math.PI / 2;
    this.button = add(new THREE.CylinderGeometry(0.035, 0.035, 0.018, 24), red, 0, -0.097, 0.121);
    this.button.rotation.x = Math.PI / 2;
    add(new THREE.SphereGeometry(0.010, 12, 8), this.indicator, 0.087, 0.116, 0.108);
    for (const x of [-0.103, 0.103]) for (const y of [-0.143, 0.143]) {
      const screw = add(new THREE.CylinderGeometry(0.005, 0.005, 0.003, 10), side, x, y, 0.104);
      screw.rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.006, 0.001, 0.001), dark, x, y, 0.107);
    }
  }

  prepare(): Promise<void> {
    if (this.buffer) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const bus = this.getBus();
    if (!bus) return Promise.resolve();
    this.preparing = (async () => {
      const response = await fetch("/audio/alarm/distant-fire-alarm.wav");
      if (!response.ok) throw new Error("Alarm recording could not be loaded.");
      const source = await bus.context.decodeAudioData(await response.arrayBuffer());
      if (source.duration < 1) throw new Error("Alarm recording is incomplete.");
      // Blend the loop boundary so an ongoing alarm does not click every twelve seconds.
      const overlap = Math.floor(source.sampleRate * 0.08);
      const loop = bus.context.createBuffer(source.numberOfChannels, source.length - overlap, source.sampleRate);
      for (let channel = 0; channel < source.numberOfChannels; channel++) {
        const from = source.getChannelData(channel), to = loop.getChannelData(channel);
        to.set(from.subarray(overlap, source.length - overlap));
        for (let i = 0; i < overlap; i++) {
          const t = i / (overlap - 1);
          to[source.length - 2 * overlap + i] = from[source.length - overlap + i] * (1 - t) + from[i] * t;
        }
      }
      this.buffer = loop;
      this.error = null;
    })().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Alarm audio unavailable.";
    }).finally(() => { this.preparing = null; this.changed(); });
    return this.preparing;
  }

  private place() {
    const world = this.getWorld();
    world.root.updateMatrixWorld(true);
    this.walls = [];
    world.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      let node: THREE.Object3D | null = object;
      while (node) {
        const surface = String(node.userData.surface ?? "");
        if (node.userData.surfaceFamily === "walls" || surface === "walls" || surface.endsWith("-walls")) {
          this.walls.push(object); break;
        }
        node = node.parent;
      }
    });
    const origin = new THREE.Vector3(this.camera.position.x, 1.42, this.camera.position.z);
    const start = Math.random() * Math.PI * 2;
    const candidates: { point: THREE.Vector3; normal: THREE.Vector3; visible: boolean }[] = [];
    for (let i = 0; i < 40; i++) {
      const angle = start + i * Math.PI * 2 / 40;
      this.ray.set(origin, new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
      this.ray.near = 0; this.ray.far = 10;
      const hit = this.ray.intersectObjects(this.walls, false)[0];
      if (!hit?.face || hit.distance < 1.8) continue;
      const normal = hit.face.normal.clone().applyNormalMatrix(this.normalMatrix.getNormalMatrix(hit.object.matrixWorld));
      if (Math.abs(normal.y) > 0.05) continue;
      const approach = hit.point.clone().addScaledVector(normal, 0.65);
      const delta = approach.clone().sub(this.camera.position); delta.y = 0;
      const length = delta.length();
      const path = new THREE.Ray(new THREE.Vector3(this.camera.position.x, 0.8, this.camera.position.z), delta.normalize());
      const blocked = world.colliders.some(box => {
        if (box.min[1] >= 1.8 || box.max[1] <= 0.1) return false;
        this.box.min.set(box.min[0] - 0.27, box.min[1], box.min[2] - 0.27);
        this.box.max.set(box.max[0] + 0.27, box.max[1], box.max[2] + 0.27);
        return !!path.intersectBox(this.box, this.point) && this.point.distanceTo(path.origin) < length;
      });
      if (blocked) continue;
      const tangent = new THREE.Vector3(-normal.z, 0, normal.x);
      let fits = true;
      for (const x of [-0.15, 0.15]) for (const y of [-0.20, 0.20]) {
        const probe = hit.point.clone().addScaledVector(tangent, x).addScaledVector(normal, 0.25);
        probe.y += y;
        this.ray.set(probe, normal.clone().negate()); this.ray.far = 0.30;
        const support = this.ray.intersectObjects(this.walls, false)[0];
        if (!support || Math.abs(support.distance - 0.25) > 0.02) fits = false;
      }
      if (!fits) continue;
      const projected = hit.point.clone().project(this.camera);
      candidates.push({ point: hit.point.clone(), normal, visible: projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1 });
      if (candidates.length >= 8) break;
    }
    this.walls = [];
    if (!candidates.length) return false;
    const hidden = candidates.filter(candidate => !candidate.visible);
    const pool = hidden.length ? hidden : candidates;
    const selected = pool[Math.floor(Math.random() * pool.length)];
    this.root.position.copy(selected.point).addScaledVector(selected.normal, 0.004);
    this.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), selected.normal);
    this.root.visible = true;
    this.root.updateMatrixWorld(true);
    this.button.position.z = 0.121;
    this.ringing = true;
    this.elapsed = 0;
    this.played++;
    return true;
  }

  update(seconds: number, active: boolean, audible: boolean) {
    if (!active || document.hidden) { this.reset(); return; }
    this.active = true;
    const bus = this.getBus();
    this.audible = audible && bus?.context.state === "running";
    const dt = Math.min(Math.max(seconds, 0), 0.1);
    if (!this.audible) { this.stopSound(); return; }
    if (!this.ringing) {
      this.wait = Math.max(0, this.wait - dt);
      if (this.wait > 0 || !this.buffer || this.voice) return;
      if (this.root.visible && this.root.position.distanceTo(this.camera.position) < 12) {
        this.point.copy(this.root.position).project(this.camera);
        if (this.point.z < 1 && Math.abs(this.point.x) < 1.1 && Math.abs(this.point.y) < 1.1) { this.wait = 5; return; }
      }
      if (!this.place()) { this.wait = 5; return; }
    }
    this.elapsed = Math.min(18, this.elapsed + dt);
    const urgency = THREE.MathUtils.smoothstep(this.elapsed, 0, 18);
    this.level = 0.18 + urgency * 0.57;
    this.indicator.color.setRGB(0.55 + urgency * 0.25, 0.012, 0.004);
    if (!this.voice && this.buffer && bus) {
      const now = bus.context.currentTime;
      const source = bus.context.createBufferSource();
      source.buffer = this.buffer; source.loop = true;
      const filter = bus.context.createBiquadFilter();
      filter.type = "lowpass"; filter.frequency.value = 3500; filter.Q.value = 0.7;
      const gain = bus.context.createGain();
      gain.gain.value = 0;
      const pan = bus.context.createPanner();
      pan.panningModel = "HRTF"; pan.distanceModel = "inverse";
      pan.refDistance = 6; pan.rolloffFactor = 0.7;
      source.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(bus.output);
      const voice = { source, filter, gain, pan, stopping: false };
      this.voice = voice;
      source.onended = () => {
        source.disconnect(); filter.disconnect(); gain.disconnect(); pan.disconnect();
        if (this.voice === voice) this.voice = null;
      };
      source.start(now);
    }
    if (this.voice && !this.voice.stopping && bus) {
      const distance = this.root.position.distanceTo(this.camera.position);
      const reach = 1 - THREE.MathUtils.smoothstep(distance, 25, 55);
      this.voice.gain.gain.setTargetAtTime(this.level * reach, bus.context.currentTime, 0.4);
      this.voice.pan.positionX.value = this.root.position.x;
      this.voice.pan.positionY.value = this.root.position.y;
      this.voice.pan.positionZ.value = this.root.position.z;
    }
  }

  updateView() {
    this.pickCamera.copy(this.camera);
    this.pickCamera.updateMatrixWorld(true);
    this.enabledView = this.active && this.ringing && this.root.visible;
    return this.hit(0, 0);
  }

  private hit(x: number, y: number) {
    if (!this.enabledView) return false;
    this.root.updateMatrixWorld(true);
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.pickCamera);
    this.ray.near = 0; this.ray.far = 2.2;
    const hit = this.ray.intersectObject(this.root, true)[0];
    if (!hit) return false;
    const obstruction = this.ray.intersectObject(this.getWorld().root, true)[0];
    return !obstruction || obstruction.distance >= hit.distance - 0.01;
  }

  interact(x: number, y: number) {
    if (!this.active || !this.ringing || !this.hit(x, y)) return false;
    this.ringing = false;
    this.enabledView = false;
    this.level = 0;
    this.silenced++;
    this.button.position.z = 0.113;
    this.indicator.color.setHex(0x38231e);
    this.wait = 100 + Math.random() * 120;
    this.stopSound();
    return true;
  }

  preview() {
    if (!this.buffer || this.ringing || this.voice || document.hidden || this.getBus()?.context.state !== "running") return false;
    this.root.visible = false;
    this.wait = 0;
    this.update(0, true, true);
    return this.ringing;
  }

  shiftOrigin(shift: { x: number; z: number }) {
    if (!this.root.visible) return;
    this.root.position.x += shift.x; this.root.position.z += shift.z;
    this.root.updateMatrixWorld(true);
    if (this.voice) {
      this.voice.pan.positionX.value = this.root.position.x;
      this.voice.pan.positionZ.value = this.root.position.z;
    }
  }

  private stopSound() {
    const voice = this.voice;
    if (!voice) return;
    const bus = this.getBus();
    if (!bus || bus.context.state !== "running" || document.hidden) {
      voice.source.stop();
      voice.source.disconnect(); voice.filter.disconnect(); voice.gain.disconnect(); voice.pan.disconnect();
      this.voice = null;
    } else if (!voice.stopping) {
      voice.stopping = true;
      voice.gain.gain.cancelAndHoldAtTime(bus.context.currentTime);
      voice.gain.gain.linearRampToValueAtTime(0, bus.context.currentTime + 0.2);
      voice.source.stop(bus.context.currentTime + 0.2);
    }
  }

  reset(clear = false) {
    this.active = false; this.audible = false; this.enabledView = false;
    this.stopSound();
    if (clear) {
      this.ringing = false; this.root.visible = false;
      this.elapsed = 0; this.level = 0;
      this.wait = 100 + Math.random() * 120;
      this.walls = [];
    }
  }

  get threat() {
    if (!this.ringing || !this.audible) return 0;
    return (0.25 + this.level * 0.7) * (1 - THREE.MathUtils.smoothstep(this.root.position.distanceTo(this.camera.position), 3, 15));
  }

  get diagnostics() {
    return { nextIn: this.wait, ringing: this.ringing, playing: !!this.voice, stopping: this.voice?.stopping ?? false,
      elapsed: this.elapsed, reachesCapAfter: 18, level: this.level, maxLevel: 0.75, played: this.played, silenced: this.silenced,
      activeVoices: this.voice ? 1 : 0, loaded: !!this.buffer, sourceDuration: this.buffer?.duration ?? 0,
      position: this.root.visible ? this.root.position.toArray() : null,
      distance: this.root.visible ? this.root.position.distanceTo(this.camera.position) : null, error: this.error };
  }
}
