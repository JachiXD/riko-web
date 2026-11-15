// Riko's body.
//
// Everything here is procedural: the model ships with no animation clips, but it
// does have a full VRoid humanoid rig (54 bones, including every finger joint)
// and VRM 0.x blend shapes for a/i/u/e/o plus blink and the basic emotions.
// So motion is generated, layered and eased rather than snapped between presets.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

const BODY_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const approach = (cur, target, rate, dt) => cur + (target - cur) * Math.min(1, rate * dt);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* Gesture library. Each gesture is a short additive pose layered on the idle
   pose. The envelope fades in and out, so nothing ever snaps. Values are
   radians and deliberately small: conversational, not performed. */
const GESTURES = {
  emphasisRight: {
    dur: 1.25,
    pose: (p) => ({
      rightUpperArm: { x: 0.02 * p, y: -0.05 * p, z: 0.16 * p },
      rightLowerArm: { z: 0.32 * p },
      rightHand: { z: -0.14 * p, x: 0.06 * p },
      head: { x: -0.02 * p },
    }),
  },
  emphasisLeft: {
    dur: 1.15,
    pose: (p) => ({
      leftUpperArm: { x: -0.02 * p, y: 0.04 * p, z: -0.13 * p },
      leftLowerArm: { z: -0.26 * p },
      leftHand: { z: 0.12 * p, x: -0.05 * p },
      head: { x: -0.015 * p },
    }),
  },
  openPalms: {
    dur: 1.5,
    pose: (p) => ({
      leftUpperArm: { y: -0.05 * p, z: -0.1 * p },
      rightUpperArm: { y: 0.05 * p, z: 0.1 * p },
      leftLowerArm: { z: -0.2 * p },
      rightLowerArm: { z: 0.2 * p },
      leftHand: { x: -0.08 * p },
      rightHand: { x: 0.08 * p },
    }),
  },
  smallNod: {
    dur: 0.9,
    pose: (p) => ({ head: { x: 0.055 * p }, neck: { x: 0.03 * p } }),
  },
  headTilt: {
    dur: 1.8,
    pose: (p) => ({ head: { z: 0.09 * p }, neck: { z: 0.035 * p } }),
  },
  shoulderShift: {
    dur: 2.2,
    pose: (p) => ({
      leftShoulder: { z: 0.02 * p },
      rightShoulder: { z: -0.015 * p },
      chest: { y: 0.02 * p },
    }),
  },
  thinkingHand: {
    dur: 2.4,
    pose: (p) => ({
      rightUpperArm: { y: -0.1 * p, z: 0.3 * p },
      rightLowerArm: { z: 0.55 * p },
      rightHand: { x: 0.12 * p, z: -0.1 * p },
      head: { z: 0.05 * p, x: 0.03 * p },
    }),
  },
};

/* Text to viseme plan. Kokoro does not expose phonemes, so mouth shapes are
   estimated from the letters she is about to say; amplitude does the rest. */
function visemeFor(ch) {
  switch (ch) {
    case 'a': return { v: 'aa', w: 0.95, dur: 1 };
    case 'e': return { v: 'ee', w: 0.8, dur: 1 };
    case 'i': case 'y': return { v: 'ih', w: 0.78, dur: 0.9 };
    case 'o': return { v: 'ou', w: 0.9, dur: 1 };
    case 'u': return { v: 'ou', w: 0.85, dur: 0.95 };
    case 'w': return { v: 'ou', w: 0.6, dur: 0.8 };
    case 'm': case 'b': case 'p': return { v: null, w: 0.9, dur: 0.7 };
    case 'f': case 'v': return { v: 'ih', w: 0.34, dur: 0.6 };
    case 's': case 'z': case 'c': case 'x': return { v: 'ih', w: 0.3, dur: 0.6 };
    case 'r': case 'n': case 'd': case 't': case 'l': return { v: 'aa', w: 0.3, dur: 0.55 };
    case 'k': case 'g': case 'q': return { v: 'aa', w: 0.3, dur: 0.55 };
    case 'j': case 'h': return { v: 'aa', w: 0.28, dur: 0.55 };
    case ' ': return { v: null, w: 0.7, dur: 0.7 };
    default: return { v: null, w: 0.25, dur: 0.5 };
  }
}

function buildVisemePlan(text) {
  const plan = [];
  const s = String(text || '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!/[a-z ]/.test(ch)) {
      plan.push({ v: null, w: 0.8, dur: /[.!?]/.test(ch) ? 1.6 : 0.9 });
      continue;
    }
    plan.push(visemeFor(ch));
  }
  return plan.length ? plan : [{ v: null, w: 0.5, dur: 1 }];
}

/* Rough emotional read of her own words, used to pick face and gesture. */
const EMOTION_WORDS = {
  happy: /(happy|glad|love|lovely|great|nice|wonderful|good|cute|fun|laugh|haha|yay|beautiful|sweet|proud|excited|awesome|thank)/gi,
  sad: /(sorry|sad|unfortunately|miss|lost|hurt|tired|lonely|sigh|hard|difficult|afraid|worried)/gi,
  surprised: /(wow|really|oh|whoa|sudden|surpris|amazing|unexpected)/gi,
  angry: /(angry|annoying|hate|rude|mad|frustrat|ugh)/gi,
};

export class Avatar {
  constructor(host) {
    this.host = host;
    this.state = 'idle';
    this.weights = { idle: 1, listening: 0, thinking: 0, speaking: 0, error: 0 };
    this.time = 0;
    this.rig = {};
    this.fingerRig = [];
    this.availableExpressions = new Set();
    this.vrm = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.lookTarget = null;
    this.ready = false;

    this.emotion = { happy: 0.1, sad: 0, surprised: 0, angry: 0 };
    this.emotionTarget = { ...this.emotion };

    this.mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.mouthLevel = 0;
    this.speaking = false;
    this.plan = [];
    this.planProgress = 0;
    this.planDuration = 1;
    this.clauseIndex = 0;

    this.gestures = [];
    this.nextIdleGesture = 3 + Math.random() * 4;
    this.nextIdleLook = 2 + Math.random() * 3;
    this.gestureSeed = Math.random() * 1000;

    this.blinkWait = 2 + Math.random() * 3;
    this.blinkPhase = -1;
    this.blinkDouble = false;
    this.eyeBlink = 0;

    this.deltas = new Map();
    this.lookOffset = new THREE.Vector3();
    this.lookAim = new THREE.Vector3();
    this.info = { visemes: [], fingers: 0, lookAt: false, bones: 0 };
  }

  async load(url, onProgress) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    this.host.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    this.scene = scene;

    const light = new THREE.DirectionalLight(0xffffff, Math.PI);
    light.position.set(1, 1, 1);
    scene.add(light);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d9e5, 0.5));

    const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 30);
    this.camera = camera;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url, (event) => {
      if (onProgress && event.total) onProgress(event.loaded / event.total);
    });

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('riko.vrm did not contain a VRM model');
    this.vrm = vrm;
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);

    // Arms down. VRM 0.x models are mirrored on this axis.
    const arm = vrm.meta?.metaVersion === '0' ? -1.46 : 1.46;
    const leftUpper = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpper = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    if (leftUpper) leftUpper.rotation.z = -arm;
    if (rightUpper) rightUpper.rotation.z = arm;

    this.#frameCamera();
    this.#captureRig();
    this.#setupExpressions();
    this.#setupLookAt();

    this.ready = true;
    this.info = {
      visemes: [...this.availableExpressions].filter((n) => VISEMES.includes(n)),
      fingers: this.fingerRig.length,
      lookAt: !!vrm.lookAt,
      bones: Object.keys(this.rig).length,
    };
    return this.info;
  }

  #frameCamera() {
    const vrm = this.vrm;
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const span = box.max.y - box.min.y;
    const height = span > 0.3 && span < 20 ? span : 1.6;
    this.frame = { box, height, y: box.min.y + height * 0.7 };
    this.#placeCamera();

    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.target.set(0, this.frame.y, 0);
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.minDistance = this.frame.distance * 0.3;
    controls.maxDistance = this.frame.distance * 2.6;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    this.controls = controls;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.#placeCamera();
    });
  }

  #placeCamera() {
    const { height, y } = this.frame;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (height * 0.86) / 2 / Math.tan(vFov / 2);
    this.frame.distance = distance;
    this.camera.position.set(0, y + height * 0.015, distance);
    if (this.controls) {
      this.controls.target.set(0, y, 0);
      this.controls.update();
    }
  }

  #captureRig() {
    for (const name of BODY_BONES) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.rig[name] = { node, base: node.rotation.clone() };
    }
    for (const side of ['left', 'right']) {
      for (const finger of FINGERS) {
        for (const segment of FINGER_SEGMENTS) {
          const name = `${side}${finger}${segment}`;
          const node = this.vrm.humanoid.getNormalizedBoneNode(name);
          if (node) this.fingerRig.push({ name, side, finger, segment, node, base: node.rotation.clone() });
        }
      }
    }
  }

  #setupExpressions() {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    const wanted = [...VISEMES, 'blink', 'blinkLeft', 'blinkRight', 'happy', 'sad', 'angry', 'surprised', 'relaxed'];
    for (const key of wanted) {
      if (manager.getExpression(key)) this.availableExpressions.add(key);
    }
    this.blinkKey = this.availableExpressions.has('blink') ? 'blink' : null;
    this.hasSplitBlink = this.availableExpressions.has('blinkLeft') && this.availableExpressions.has('blinkRight');
  }

  #setupLookAt() {
    if (!this.vrm.lookAt) return;
    this.lookTarget = new THREE.Object3D();
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const y = head ? head.getWorldPosition(new THREE.Vector3()).y : this.frame.y + this.frame.height * 0.35;
    this.lookTarget.position.set(0, y - 0.02, 1.4);
    this.scene.add(this.lookTarget);
    this.vrm.lookAt.target = this.lookTarget;
    this.gazeY = y;
  }

  setState(next) {
    if (!(next in this.weights) || this.state === next) return;
    this.state = next;
    if (next === 'thinking') this.deliberateBlink();
    if (next === 'error') this.setEmotion({ sad: 0.35, happy: 0 });
  }

  setEmotion(partial) {
    for (const key of Object.keys(this.emotionTarget)) {
      if (typeof partial[key] === 'number') this.emotionTarget[key] = clamp(partial[key], 0, 1);
    }
  }

  readTextEmotion(text) {
    const s = String(text || '');
    let happy = 0.1;
    let sad = 0;
    let surprised = 0;
    let angry = 0;
    happy += Math.min(0.22, (s.match(EMOTION_WORDS.happy) || []).length * 0.09);
    sad += Math.min(0.25, (s.match(EMOTION_WORDS.sad) || []).length * 0.11);
    surprised += Math.min(0.22, (s.match(EMOTION_WORDS.surprised) || []).length * 0.11);
    angry += Math.min(0.16, (s.match(EMOTION_WORDS.angry) || []).length * 0.08);
    if (/!/.test(s)) happy += 0.05;
    if (/\?/.test(s)) surprised += 0.04;
    this.setEmotion({ happy, sad, surprised, angry });
  }

  deliberateBlink() {
    this.blinkPhase = 0;
    this.blinkWait = 2 + Math.random() * 2;
  }

  beginClause(text, duration) {
    this.speaking = true;
    this.plan = buildVisemePlan(text);
    this.planProgress = 0;
    this.planDuration = Math.max(0.4, duration || 1);
    this.clauseIndex += 1;
    if (this.clauseIndex > 1) this.#maybeGesture();
    this.#gestureSeedFor(text);
  }

  endSpeech() {
    this.speaking = false;
    this.plan = [];
    this.gestures = this.gestures.filter((g) => g.name === 'smallNod');
  }

  #gestureSeedFor(text) {
    const s = String(text || '');
    if (s.length < 24) return;
    const roll = Math.random();
    if (/(but|however|actually|instead|though)/i.test(s) && roll < 0.4) this.#addGesture('emphasisLeft');
    else if (/(so|because|remember|important|really)/i.test(s) && roll < 0.35) this.#addGesture('emphasisRight');
    else if (/(you|we|us|together|welcome)/i.test(s) && roll < 0.3) this.#addGesture('openPalms');
  }

  #maybeGesture() {
    if (Math.random() > 0.55) return;
    const options = ['smallNod', 'headTilt', 'shoulderShift', 'emphasisRight', 'openPalms'];
    this.#addGesture(options[Math.floor(Math.random() * options.length)], 0.75 + Math.random() * 0.25);
  }

  #addGesture(name, strength = 1) {
    const def = GESTURES[name];
    if (!def) return;
    if (this.gestures.some((g) => g.name === name)) return; // never stack the same gesture
    this.gestures.push({ name, def, t: 0, strength });
    if (this.gestures.length > 3) this.gestures.shift();
  }

  update(dt, level = 0) {
    if (!this.ready) return;
    const d = Math.min(dt, 0.05);
    this.time += d;

    for (const key of Object.keys(this.weights)) {
      this.weights[key] = approach(this.weights[key], key === this.state ? 1 : 0, 4.2, d);
    }
    this.mouthLevel = approach(
      this.mouthLevel,
      this.speaking ? clamp(level, 0, 1) : 0,
      this.speaking ? 18 : 10,
      d,
    );

    this.deltas.clear();
    this.#layerIdle();
    this.#layerStates();
    this.#applyGestures(d);
    this.#applyPose();

    this.#updateMouth(d);
    this.#updateBlink(d);
    this.#updateGaze(d);

    for (const key of Object.keys(this.emotion)) {
      this.emotion[key] = approach(this.emotion[key], this.emotionTarget[key], 2.4, d);
    }
    this.#applyExpression();

    this.vrm.update(d);
    this.controls?.update();
  }

  render() {
    this.renderer?.render(this.scene, this.camera);
  }

  #layerIdle() {
    const t = this.time;
    const idle = this.weights.idle;
    const listening = this.weights.listening;
    const thinking = this.weights.thinking;
    const speaking = this.weights.speaking;

    const breathe = Math.sin(t * 1.05) * 0.016 + Math.sin(t * 0.43) * 0.006;
    this.#add('chest', breathe * 0.7 * (idle + listening * 0.6), 0, 0);
    this.#add('spine', breathe * 0.5, Math.sin(t * 0.27) * 0.035 * idle, Math.sin(t * 0.21) * 0.03 * idle);
    this.#add('hips', 0, 0, Math.sin(t * 0.19) * 0.035 * idle);
    this.#add('upperChest', breathe * 0.3, 0, 0);

    const driftX = Math.sin(t * 0.37 + 1.1) * 0.025;
    const driftY = Math.sin(t * 0.29) * 0.09;
    const driftZ = Math.sin(t * 0.23 + 0.4) * 0.03;
    this.#add('head', driftX, driftY * idle, driftZ * idle);
    this.#add('neck', driftX * 0.45, driftY * 0.35 * idle, driftZ * 0.4 * idle);

    this.#add('spine', 0.018 * listening, 0, 0);
    this.#add('head', 0.012 * listening, Math.sin(t * 0.6) * 0.05 * listening, 0.05 * listening);

    this.#add('head', -0.05 * thinking, -0.09 * thinking, 0.07 * thinking);
    this.#add('neck', -0.02 * thinking, -0.03 * thinking, 0.03 * thinking);

    const nod = this.mouthLevel * 0.05 + Math.sin(t * 1.7) * 0.012 * speaking;
    this.#add(
      'head',
      -nod + Math.sin(t * 2.3) * 0.008 * speaking,
      Math.sin(t * 0.9) * 0.045 * speaking,
      Math.sin(t * 1.3) * 0.02 * speaking,
    );
    this.#add('neck', -nod * 0.4, Math.sin(t * 0.9) * 0.02 * speaking, 0);
    this.#add('chest', 0, Math.sin(t * 0.55) * 0.02 * speaking, 0);

    const rest = Math.sin(t * 0.5) * 0.012;
    this.#add('leftUpperArm', rest * 0.5, 0, -Math.abs(rest) * 0.5);
    this.#add('rightUpperArm', -rest * 0.4, 0, Math.abs(rest) * 0.5);
    this.#add('leftLowerArm', 0, 0, -0.04);
    this.#add('rightLowerArm', 0, 0, 0.04);

    const error = this.weights.error;
    this.#add('head', 0.06 * error, Math.sin(t * 9) * 0.02 * error, 0);
    this.#add('spine', 0.03 * error, 0, 0);
  }

  #layerStates() {
    const thinking = this.weights.thinking;
    if (thinking > 0.02) this.#add('rightUpperArm', 0, -0.03 * thinking, 0.04 * thinking);
  }

  #applyGestures(d) {
    for (let i = this.gestures.length - 1; i >= 0; i--) {
      const g = this.gestures[i];
      g.t += d;
      const u = g.t / g.def.dur;
      if (u >= 1) {
        this.gestures.splice(i, 1);
        continue;
      }
      const env = smoothstep(0, 0.22, u) * (1 - smoothstep(0.68, 1, u)) * g.strength;
      const pose = g.def.pose(env);
      for (const [bone, rot] of Object.entries(pose)) {
        this.#add(bone, rot.x || 0, rot.y || 0, rot.z || 0);
      }
    }

    if (!this.speaking && this.weights.idle > 0.6) {
      this.nextIdleGesture -= d;
      if (this.nextIdleGesture <= 0) {
        this.nextIdleGesture = 7 + Math.random() * 9;
        this.#addGesture(Math.random() < 0.5 ? 'headTilt' : 'shoulderShift', 0.6);
      }
    }

    if (this.fingerRig.length) {
      const gestureEnergy = this.gestures.length ? 0.5 : 0;
      const idleFidget = Math.sin(this.time * 0.6 + this.gestureSeed + 0.4) * 0.02;
      for (const finger of this.fingerRig) {
        const sideSign = finger.side === 'left' ? -1 : 1;
        const segmentScale = finger.segment === 'Proximal' ? 1 : finger.segment === 'Intermediate' ? 0.8 : 0.55;
        const curl = (0.05 + idleFidget + gestureEnergy * 0.1) * segmentScale;
        finger.node.rotation.set(
          finger.base.x,
          finger.base.y,
          finger.base.z + sideSign * curl,
        );
      }
    }
  }

  #add(bone, x, y, z) {
    const entry = this.deltas.get(bone);
    if (entry) {
      entry.x += x;
      entry.y += y;
      entry.z += z;
    } else {
      this.deltas.set(bone, { x, y, z });
    }
  }

  #applyPose() {
    for (const [name, entry] of Object.entries(this.rig)) {
      const extra = this.deltas.get(name);
      const b = entry.base;
      const node = entry.node;
      if (!extra) {
        node.rotation.set(b.x, b.y, b.z);
        continue;
      }
      node.rotation.set(
        b.x + clamp(extra.x, -0.6, 0.6),
        b.y + clamp(extra.y, -0.7, 0.7),
        b.z + clamp(extra.z, -0.7, 0.7),
      );
    }
  }

  #updateMouth(d) {
    const targets = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    const level = this.mouthLevel;

    if (this.speaking && this.plan.length) {
      // The viseme timeline follows the clip's own clock, not instantaneous
      // loudness: otherwise quiet syllables make the mouth fall behind the words.
      this.planProgress = Math.min(1, this.planProgress + d / this.planDuration);
      const total = this.plan.reduce((sum, p) => sum + p.dur, 0);
      let pos = this.planProgress * total;
      let index = 0;
      while (index < this.plan.length - 1 && pos > this.plan[index].dur) {
        pos -= this.plan[index].dur;
        index++;
      }
      const blend = clamp(pos / this.plan[index].dur, 0, 1);
      const current = this.plan[index];
      const next = this.plan[Math.min(this.plan.length - 1, index + 1)];
      const mix = (a, b, w) => a * (1 - w) + b * w;
      const shapeW = mix(current.w, next.w, blend * 0.5);
      const voiced = clamp(level * 2.4, 0, 1);
      const openness = voiced * shapeW;

      if (current.v) targets[current.v] += openness * 0.9;
      if (blend > 0.45 && next.v) targets[next.v] += openness * 0.45 * blend;
      // A little jaw opening on every voiced sound keeps it from looking stamped.
      targets.aa += openness * 0.22;
    }

    this.lastTargets = { ...targets };
    for (const key of VISEMES) {
      const target = clamp(targets[key], 0, 1);
      const rate = target > this.mouth[key] ? 26 : 13;
      this.mouth[key] = approach(this.mouth[key], target, rate, d);
    }
  }

  #updateBlink(d) {
    if (!this.blinkKey && !this.hasSplitBlink) return;
    this.blinkWait -= d;
    if (this.blinkWait <= 0 && this.blinkPhase < 0) {
      this.blinkPhase = 0;
      this.blinkDouble = Math.random() < 0.18;
      this.blinkWait = 1.8 + Math.random() * 4.2;
    }

    let value = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += d / 0.14;
      if (this.blinkPhase >= 1) {
        this.blinkPhase += d / 0.07; // hold shut briefly
        value = this.blinkPhase < 1.3 ? 1 : 0;
        if (this.blinkPhase >= 1.4) {
          if (this.blinkDouble) {
            this.blinkDouble = false;
            this.blinkPhase = 0;
          } else {
            this.blinkPhase = -1;
          }
        }
      } else {
        value = Math.sin(this.blinkPhase * Math.PI * 0.5);
      }
    }
    this.eyeBlink = clamp(value * (1 - this.weights.thinking * 0.25), 0, 1);
  }

  #updateGaze(d) {
    if (!this.lookTarget) return;
    this.nextIdleLook -= d;
    if (this.nextIdleLook <= 0) {
      this.nextIdleLook = 1.4 + Math.random() * 3.4;
      const spread = this.weights.listening > 0.5 ? 0.1 : 0.32;
      this.lookOffset.set((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 0.4, 0);
    }

    if (this.state === 'thinking') this.lookOffset.lerp(new THREE.Vector3(-0.35, 0.16, 0), Math.min(1, d * 2));
    else if (this.state === 'listening') this.lookOffset.lerp(new THREE.Vector3(0, 0, 0), Math.min(1, d * 1.6));

    const y = this.gazeY ?? this.frame.y;
    this.lookAim.set(this.lookOffset.x, y + this.lookOffset.y, 1.1);
    this.lookTarget.position.lerp(this.lookAim, Math.min(1, d * 6));
  }

  #applyExpression() {
    const manager = this.vrm?.expressionManager;
    if (!manager) return;

    if (this.blinkKey) manager.setValue(this.blinkKey, this.eyeBlink || 0);
    else if (this.hasSplitBlink) {
      manager.setValue('blinkLeft', this.eyeBlink || 0);
      manager.setValue('blinkRight', this.eyeBlink || 0);
    }

    const e = this.emotion;
    if (this.availableExpressions.has('happy')) manager.setValue('happy', clamp(e.happy * 0.55, 0, 0.42));
    if (this.availableExpressions.has('sad')) manager.setValue('sad', clamp(e.sad, 0, 0.32));
    if (this.availableExpressions.has('angry')) manager.setValue('angry', clamp(e.angry, 0, 0.22));
    if (this.availableExpressions.has('surprised')) manager.setValue('surprised', clamp(e.surprised, 0, 0.26));

    for (const key of VISEMES) {
      if (this.availableExpressions.has(key)) manager.setValue(key, clamp(this.mouth[key], 0, 1));
    }
  }

  getMouthShape() {
    return { ...this.mouth, level: this.mouthLevel };
  }

  getMouthDebug() {
    return {
      targets: this.lastTargets || null,
      planLength: this.plan.length,
      progress: this.planProgress,
      indexSample: this.plan.slice(0, 24).map((p) => p.v || '·').join(''),
    };
  }
}
