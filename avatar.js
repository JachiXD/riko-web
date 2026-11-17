// Riko's body: the body itself, the camera, her face, and the frame loop.
//
// No animation clips ship with the model, so every pose is generated on her
// real humanoid rig and blended additively over a captured base pose. The motion
// layers live in motion.js; the joints and their measured axes live in rig.js;
// her mouth, blink and eye look-at live in face.js.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { clamp, approach, emptyChannels } from './gestures.js?v=30';
import { captureRig, emptyDeltas, measureArms, applyPose, applyLegs } from './rig.js?v=30';
import { buildVisemePlan, readEmotion, advanceMouth, advanceBlink, advanceMood, applyExpressions } from './face.js?v=30';
import { playGesture, beginClause, endSpeech, buildChannels, applyChannels } from './motion.js?v=30';

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'greeting', 'excited', 'confused', 'error'];

export class Avatar {
  constructor(host) {
    this.host = host;
    this.state = 'idle';
    this.weights = Object.fromEntries(STATES.map((s) => [s, s === 'idle' ? 1 : 0]));
    this.time = 0;
    this.rig = {};
    this.fingers = [];
    this.deltas = {};
    this.channels = emptyChannels();
    this.handShape = {};
    this.available = new Set();
    this.vrm = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.lookTarget = null;
    this.ready = false;
    this.greeted = false;

    // Expression weights, all fading into each other rather than snapping:
    // happy and relaxed do most of the work, the rest are small accents.
    this.emotion = { happy: 0.12, relaxed: 0.14, sad: 0, surprised: 0, angry: 0 };
    this.emotionTarget = { ...this.emotion };
    this.moodName = 'calm';
    this.moodWait = 3 + Math.random() * 4;
    this.browWait = 4 + Math.random() * 5;
    this.browPulse = 0;
    this.smileWait = 6 + Math.random() * 6;
    this.smilePulse = 0;

    this.mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.mouthLevel = 0;
    this.speaking = false;
    this.plan = [];
    this.planProgress = 0;
    this.planDuration = 1;
    this.clauseIndex = 0;

    this.gestures = [];
    this.recentGestures = [];
    this.idleGestureWait = 2.5 + Math.random() * 3;
    this.speechGestureWait = 0.4;
    this.nextIdleLook = 2 + Math.random() * 3;
    this.gestureSeed = Math.random() * 1000;
    this.stateTimer = 0;

    this.blinkWait = 2 + Math.random() * 3;
    this.blinkPhase = -1;
    this.blinkDouble = false;
    this.eyeBlink = 0;

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
    const captured = captureRig(vrm);
    this.rig = captured.rig;
    this.fingers = captured.fingers;
    this.deltas = emptyDeltas(this.rig);
    this.#setupExpressions();
    this.#setupLookAt();
    this.armAxes = measureArms(vrm, this.rig);

    this.ready = true;
    this.info = {
      visemes: [...this.available].filter((n) => ['aa', 'ih', 'ou', 'ee', 'oh'].includes(n)),
      fingers: this.fingers.length,
      lookAt: !!vrm.lookAt,
      bones: Object.keys(this.rig).length,
    };
    return this.info;
  }

  // The camera is deliberately not user-driven: no orbit, no zoom, no pan. She
  // used to be a full-body turntable, but her arms are the least convincing part
  // of the rig, so the default framing is a locked portrait that keeps them out
  // of shot. setFraming('full') restores the old full-body view for later.
  #frameCamera() {
    const vrm = this.vrm;
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const span = box.max.y - box.min.y;
    const height = span > 0.3 && span < 20 ? span : 1.6;
    this.frame = { box, height, top: box.max.y, y: box.min.y + height * 0.7 };
    // 'face' is the default: her head, hair and shoulders, close enough that
    // the eyes and mouth are the subject instead of the silhouette.
    this.framing = this.framing || 'face';
    this.#placeCamera();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.#placeCamera();
    });
  }

  /**
   * 'face' (default, head and shoulders), 'portrait' (chest up) or 'full'
   * (whole model). All three are locked in place; only the distance changes.
   */
  setFraming(mode) {
    this.framing = ['face', 'portrait', 'full'].includes(mode) ? mode : 'face';
    if (this.frame && this.camera) this.#placeCamera();
  }

  #placeCamera() {
    const { height, top } = this.frame;
    const mode = this.framing;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const halfFov = Math.tan(vFov / 2);
    const aspect = this.camera.aspect || 1;

    // How much of her the frame covers, in fractions of her own height measured
    // from the top of her head. 'face' ends just above her chest, which is the
    // head, hair and shoulders shot; 'portrait' ends at the waist.
    const visible = height * (mode === 'full' ? 1.06 : mode === 'portrait' ? 0.42 : 0.34);
    // A little air above her hair, so blinking and head tilts never crop it.
    const topEdge = mode === 'full' ? top + height * 0.03 : top + visible * 0.05;
    const center = mode === 'full' ? top - height * 0.5 : topEdge - visible / 2;

    // Fit vertically, then give ground only when the viewport is narrow enough
    // to cut her shoulders away entirely. A phone crops a little shoulder, which
    // is what a close-up is meant to do; it never crops her face.
    const distanceForHeight = visible / 2 / halfFov;
    const shoulderWidth = height * 0.3;
    const keepWidth = mode === 'full' ? 1 : mode === 'portrait' ? 0.86 : 0.58;
    const distanceForWidth = (shoulderWidth * keepWidth) / 2 / (halfFov * aspect);
    const cap = mode === 'face' ? 1.3 : 1.2;
    const distance = Math.min(Math.max(distanceForHeight, distanceForWidth), distanceForHeight * cap);

    this.frame.distance = distance;
    this.frame.centerY = center;
    this.frame.visible = visible;
    this.camera.position.set(0, center, distance);
    this.camera.lookAt(0, center, 0);
    this.camera.updateMatrixWorld();
  }

  #setupExpressions() {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    const wanted = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'neutral'];
    // VRM expressions are matched case-insensitively, because this model calls
    // one of them "Surprised" and a name lookup alone would miss it.
    this.exprNames = {};
    const actual = Object.keys(manager.expressionMap || {});
    for (const key of wanted) {
      const real = actual.find((name) => name.toLowerCase() === key);
      if (real) {
        this.available.add(key);
        this.exprNames[key] = real;
      }
    }
    this.blinkKey = this.available.has('blink');
    this.hasSplitBlink = this.available.has('blinkLeft') && this.available.has('blinkRight');
  }

  #setupLookAt() {
    if (!this.vrm.lookAt) return;
    this.lookTarget = new THREE.Object3D();
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const y = head ? head.getWorldPosition(new THREE.Vector3()).y : this.frame.y + this.frame.height * 0.35;
    // Just in front of the lens, so she meets the viewer's eyes from where the
    // camera actually sits rather than from the old full-body distance.
    this.lookTarget.position.set(0, y - 0.02, (this.frame?.distance || 1.4) * 0.92);
    this.scene.add(this.lookTarget);
    this.vrm.lookAt.target = this.lookTarget;
    this.gazeY = y;
  }

  setState(next) {
    if (!STATES.includes(next) || this.state === next) return;
    this.state = next;
    if (next === 'thinking') this.deliberateBlink();
    if (next === 'error') this.setEmotion({ sad: 0.35, happy: 0 });
    if (next === 'greeting' || next === 'excited' || next === 'confused') {
      // These read as a moment, not a mode: they settle back on their own.
      this.stateTimer = next === 'greeting' ? 2.9 : 2.2;
    }
  }

  greet() {
    // In close-up a wave happens entirely out of frame, so she greets with her
    // face instead. The wave still fires if anyone asks for the full body.
    if (this.framing === 'full') playGesture(this, 'wave');
    this.setEmotion({ happy: 0.55, relaxed: 0.3 });
    this.deliberateBlink();
    this.setState('greeting');
  }

  // A mood writes the steady expression; a moment like this tints it. Both fade
  // through the same path, so nothing on her face ever snaps.
  setEmotion(partial) {
    this.tone = this.tone || { happy: 0, sad: 0, surprised: 0, angry: 0, shy: 0 };
    for (const key in partial) {
      if (typeof partial[key] === 'number') this.tone[key] = clamp(partial[key], 0, 1);
    }
  }

  // The colour of her own words also picks a body mood.
  reactTo(text) {
    const s = String(text || '');
    const excited = /(wow|amazing|great news|so excited|yay|love it|awesome)/i.test(s);
    const puzzled = /(not sure|i do not know|confus|what do you mean|hmm)/i.test(s);
    if (excited) this.setState('excited');
    else if (puzzled) this.setState('confused');
  }

  readTextEmotion(text) {
    const s = String(text || '');
    const felt = readEmotion(s);
    this.setEmotion(felt);
    // A strong feeling also decides the mood on the spot, rather than waiting
    // for the next slot.
    if (felt.shy > 0.2) this.moodName = 'shy';
    else if (felt.surprised > 0.28) this.moodName = 'surprise';
    else if (felt.happy > 0.32) this.moodName = 'bright';
    this.reactTo(s);
  }

  deliberateBlink() {
    this.blinkPhase = 0;
    this.blinkWait = 2 + Math.random() * 2;
  }

  buildPlan(text) {
    return buildVisemePlan(text);
  }

  playGesture(name, strength = 1) {
    return playGesture(this, name, strength);
  }

  beginClause(text, duration) {
    beginClause(this, text, duration);
  }

  endSpeech() {
    endSpeech(this);
  }

  // She waves hello once the boot screen actually clears, so the wave is not
  // wasted behind it. This keeps the greeting inside the body itself.
  #watchBoot() {
    if (this.greeted || !this.ready) return;
    const boot = document.getElementById('boot');
    if (!boot || boot.classList.contains('gone')) {
      this.greeted = true;
      this.greet();
    }
  }

  update(dt, level = 0) {
    if (!this.ready) return;
    const d = Math.min(dt, 0.05);
    this.time += d;

    for (const key in this.weights) {
      this.weights[key] = approach(this.weights[key], key === this.state ? 1 : 0, 3.6, d);
    }
    if (this.stateTimer > 0) {
      this.stateTimer -= d;
      if (this.stateTimer <= 0) {
        this.stateTimer = 0;
        this.setState(this.speaking ? 'speaking' : 'idle');
      }
    }

    this.mouthLevel = approach(this.mouthLevel, this.speaking ? clamp(level, 0, 1) : 0, this.speaking ? 18 : 10, d);

    buildChannels(this, d);
    applyChannels(this);

    const hipRoll = this.deltas.hips?.z || 0;
    applyPose(this.rig, this.deltas, hipRoll);
    // Her hands are out of frame in every close framing, and busy fingers are
    // the first thing that makes a still body look wrong, so they stay relaxed.
    applyLegs(this.rig, hipRoll, this.channels.legs.knee);

    advanceMood(this, d);
    advanceMouth(this, d);
    advanceBlink(this, d);
    this.#updateGaze(d);

    // Slow enough that every expression reads as a transition, not a switch.
    for (const key in this.emotion) {
      this.emotion[key] = approach(this.emotion[key], this.emotionTarget[key], 1.9, d);
    }
    applyExpressions(this.vrm, this.available, this.mouth, this.eyeBlink, this.emotion, this.moodName, this.exprNames);

    this.#watchBoot();
    this.vrm.update(d);
    this.controls?.update();
  }

  render() {
    this.renderer?.render(this.scene, this.camera);
  }

  // Eye contact is the loudest thing on a face at this distance, so she holds
  // the viewer and only glances away in small, brief darts.
  #updateGaze(d) {
    if (!this.lookTarget) return;
    const hint = this.moodGaze || { x: 0, y: 0 };
    this.nextIdleLook -= d;
    if (this.nextIdleLook <= 0) {
      this.nextIdleLook = this.state === 'thinking' ? 1.1 + Math.random() * 2.2 : 2.2 + Math.random() * 4.2;
      const spread = this.weights.listening > 0.5 ? 0.05 : 0.13;
      // Mostly tiny movements that read as saccades, occasionally a real glance.
      const wide = Math.random() < 0.18 ? 1.9 : 1;
      this.lookOffset.set((Math.random() - 0.5) * spread * wide, (Math.random() - 0.5) * spread * 0.55 * wide, 0);
    }
    if (this.state === 'thinking') this.lookOffset.lerp(new THREE.Vector3(-0.18, 0.07, 0), Math.min(1, d * 1.4));
    else if (this.state === 'listening') this.lookOffset.lerp(new THREE.Vector3(0, 0, 0), Math.min(1, d * 1.6));

    const y = this.gazeY ?? this.frame.y;
    this.lookAim.set(this.lookOffset.x + hint.x, y + this.lookOffset.y + hint.y, this.lookTarget.position.z);
    this.lookTarget.position.lerp(this.lookAim, Math.min(1, d * 5));
  }

  getMouthShape() {
    return { ...this.mouth, level: this.mouthLevel };
  }

  getMouthDebug() {
    return {
      targets: this.lastTargets || null,
      planLength: this.plan.length,
      progress: this.planProgress,
      indexSample: this.plan.slice(0, 24).map((p) => p.v || '.').join(''),
    };
  }

  getMotion() {
    const bones = {};
    for (const name in this.rig) {
      const entry = this.rig[name];
      const r = entry.node.rotation;
      bones[name] = {
        x: +(r.x - entry.base.x).toFixed(4),
        y: +(r.y - entry.base.y).toFixed(4),
        z: +(r.z - entry.base.z).toFixed(4),
      };
    }
    const fingers = {};
    for (const finger of this.fingers) {
      fingers[finger.name] = {
        z: +(finger.node.rotation.z - finger.base.z).toFixed(4),
        y: +(finger.node.rotation.y - finger.base.y).toFixed(4),
      };
    }
    return {
      state: this.state,
      gestures: this.gestures.map((g) => g.name),
      channels: JSON.parse(JSON.stringify(this.channels)),
      bones,
      fingers,
      axes: this.armAxes,
    };
  }
}
