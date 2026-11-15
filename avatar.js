// Riko's body: the body itself, the camera, her face, and the frame loop.
//
// No animation clips ship with the model, so every pose is generated on her
// real humanoid rig and blended additively over a captured base pose. The motion
// layers live in motion.js; the joints and their measured axes live in rig.js;
// her mouth, blink and eye look-at live in face.js.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { clamp, approach, emptyChannels } from './gestures.js?v=29';
import { captureRig, emptyDeltas, measureArms, applyPose, applyLegs, applyFingers } from './rig.js?v=29';
import { buildVisemePlan, readEmotion, advanceMouth, advanceBlink, applyExpressions } from './face.js?v=29';
import { playGesture, beginClause, endSpeech, buildChannels, applyChannels } from './motion.js?v=29';

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

  #setupExpressions() {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    const wanted = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'sad', 'angry', 'surprised', 'relaxed'];
    for (const key of wanted) if (manager.getExpression(key)) this.available.add(key);
    this.blinkKey = this.available.has('blink');
    this.hasSplitBlink = this.available.has('blinkLeft') && this.available.has('blinkRight');
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
    playGesture(this, 'wave');
    this.setState('greeting');
  }

  setEmotion(partial) {
    for (const key in this.emotionTarget) {
      if (typeof partial[key] === 'number') this.emotionTarget[key] = clamp(partial[key], 0, 1);
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
    this.setEmotion(readEmotion(s));
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
    applyFingers(this.fingers, this.handShape, this.time, this.gestureSeed);
    applyLegs(this.rig, hipRoll, this.channels.legs.knee);

    advanceMouth(this, d);
    advanceBlink(this, d);
    this.#updateGaze(d);

    for (const key in this.emotion) {
      this.emotion[key] = approach(this.emotion[key], this.emotionTarget[key], 2.4, d);
    }
    applyExpressions(this.vrm, this.available, this.mouth, this.eyeBlink, this.emotion);

    this.#watchBoot();
    this.vrm.update(d);
    this.controls?.update();
  }

  render() {
    this.renderer?.render(this.scene, this.camera);
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
