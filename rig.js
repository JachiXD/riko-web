// Riko's rig.
//
// The model has no animation clips, but it does have a full VRoid humanoid
// skeleton: spine, neck, head, shoulders, elbows, wrists, thirty finger joints,
// hips, knees, ankles and toes. This module finds those joints and — crucially —
// asks the rig which local axis actually raises an arm or bends an elbow, by
// nudging the joint and measuring where the hand went. Nothing here assumes an
// axis, which is why the gestures never twist her arms.

import * as THREE from 'three';
import { clamp } from './gestures.js?v=29';

const AXES = ['x', 'y', 'z'];

export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

export const BODY_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot', 'leftToes', 'rightToes',
];

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];

export function captureRig(vrm) {
  const rig = {};
  const fingers = [];
  for (const name of BODY_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (node) rig[name] = { node, base: node.rotation.clone() };
  }
  for (const side of ['left', 'right']) {
    for (const finger of FINGERS) {
      for (const segment of FINGER_SEGMENTS) {
        const name = `${side}${finger}${segment}`;
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) fingers.push({ name, side, finger, segment, node, base: node.rotation.clone() });
      }
    }
  }
  return { rig, fingers };
}

export function emptyDeltas(rig) {
  const deltas = {};
  for (const name in rig) deltas[name] = { x: 0, y: 0, z: 0 };
  return deltas;
}

/* Nudge one joint at a time and watch the hand. Outward = the hand moves away
   from the body's centre line; raise shares that axis (both are abduction on
   this rig); swing moves it forward; elbow is whichever rotation carries the
   hand up and forward without twisting. */
export function measureArms(vrm, rig) {
  const result = {};
  const hand = new THREE.Vector3();
  const base = new THREE.Vector3();
  const test = new THREE.Vector3();
  const STEP = 0.16;

  for (const side of ['left', 'right']) {
    const upper = rig[`${side}UpperArm`];
    const lower = rig[`${side}LowerArm`];
    const handBone = rig[`${side}Hand`];
    if (!upper || !handBone) continue;

    const read = () => {
      vrm.scene.updateMatrixWorld(true);
      handBone.node.getWorldPosition(hand);
      return hand.clone();
    };

    base.copy(read());
    const axes = {
      out: { axis: 'z', sign: 1, score: 0 },
      raise: { axis: 'z', sign: 1, score: 0 },
      swing: { axis: 'x', sign: 1, score: 0 },
      elbow: { axis: 'z', sign: 1, score: 0 },
    };

    for (const axis of AXES) {
      for (const sign of [1, -1]) {
        upper.node.rotation.set(upper.base.x, upper.base.y, upper.base.z);
        upper.node.rotation[axis] += STEP * sign;
        test.copy(read());
        upper.node.rotation.copy(upper.base);

        const outward = (Math.abs(test.x) - Math.abs(base.x)) / STEP;
        const lift = (test.y - base.y) / STEP;
        const forward = (test.z - base.z) / STEP;

        if (outward > axes.out.score) axes.out = { axis, sign, score: outward };
        if (lift > axes.raise.score) axes.raise = { axis, sign, score: lift };
        if (forward > axes.swing.score) axes.swing = { axis, sign, score: forward };
      }
    }

    if (lower) {
      base.copy(read());
      for (const axis of AXES) {
        for (const sign of [1, -1]) {
          lower.node.rotation.set(lower.base.x, lower.base.y, lower.base.z);
          lower.node.rotation[axis] += STEP * sign;
          test.copy(read());
          lower.node.rotation.copy(lower.base);

          const up = (test.y - base.y) / STEP;
          const forward = (test.z - base.z) / STEP;
          const score = up * 0.6 + forward * 0.8;
          if (score > axes.elbow.score) axes.elbow = { axis, sign, score };
        }
      }
    }

    result[side] = axes;
  }
  return result;
}

export function addDelta(deltas, bone, axis, value) {
  const entry = deltas[bone];
  if (entry) entry[axis] += value;
}

/* Every joint is rebuilt from its captured base pose each frame, with the
   channel sums layered on top and clamped so a bad blend cannot fold a joint
   inside out. */
export function applyPose(rig, deltas, hipRoll) {
  for (const name in rig) {
    const entry = rig[name];
    const b = entry.base;
    const node = entry.node;
    if (name === 'leftUpperLeg' || name === 'rightUpperLeg') {
      // Cancel the hip roll here so her feet stay planted; the knee and ankle
      // get the remainder in applyLegs.
      node.rotation.set(b.x, b.y, b.z - hipRoll);
      continue;
    }
    const extra = deltas[name];
    if (!extra) {
      node.rotation.set(b.x, b.y, b.z);
      continue;
    }
    node.rotation.set(
      b.x + clamp(extra.x, -1.2, 1.2),
      b.y + clamp(extra.y, -1.35, 1.35),
      b.z + clamp(extra.z, -1.35, 1.35),
    );
  }
}

export function applyLegs(rig, shift, knee) {
  for (const side of ['left', 'right']) {
    const lower = rig[`${side}LowerLeg`];
    const foot = rig[`${side}Foot`];
    const weighted = side === 'left' ? 1 + shift * 2 : 1 - shift * 2;
    if (lower) lower.node.rotation.set(lower.base.x + knee * 0.5 * weighted, lower.base.y, lower.base.z);
    if (foot) foot.node.rotation.set(foot.base.x, foot.base.y, foot.base.z + shift * 0.4);
  }
}

/* Relaxed hands keep a natural half-curl; gestures open them up and spread the
   fingers from the middle one, so an open palm looks open. */
export function applyFingers(fingers, shapes, time, seed) {
  for (const finger of fingers) {
    const sideSign = finger.side === 'left' ? -1 : 1;
    const segmentScale = finger.segment === 'Proximal' ? 1 : finger.segment === 'Intermediate' ? 0.85 : 0.6;
    const shape = shapes[finger.side] || { spread: 0, curl: 0 };

    const curl = (0.12 + shape.curl * 0.55) * segmentScale;
    const fidget = Math.sin(time * 0.7 + seed + FINGERS.indexOf(finger.finger)) * 0.015;
    const spreadIndex = finger.finger === 'Thumb' ? -1 : FINGERS.indexOf(finger.finger) - 2;
    const spread = shape.spread * spreadIndex * 0.16 * (finger.segment === 'Proximal' ? 1 : 0.35);

    finger.node.rotation.set(
      finger.base.x,
      finger.base.y + sideSign * spread,
      finger.base.z + sideSign * (curl + fidget),
    );
  }
}
