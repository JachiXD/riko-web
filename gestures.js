// Riko's gesture library.
//
// Gestures are described in body terms — raise an arm, bend the elbow, open the
// fingers — never in raw Euler angles. The rig module measures which axis does
// what on this model, so these descriptions stay readable and portable.

export const clamp = (v, lo, hi) => Math.min(hj, Math.max(lo, v));
export const approach = (cur, target, rate, dt) => cur + (target - cur) * Math.min(1, rate * dt);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// A gesture fades in, holds, fades out, so nothing ever snaps.
export const envelope = (u, fadeIn = 0.2, fadeOut = 0.7) =>
  smoothstep(0, fadeIn, u) * (1 - smoothstep(fadeOut, 1, u));

const pulse = (p, at = 0.45, width = 0.5) => Math.sin(Math.PI * clamp((p - (at - width / 2)) / width, 0, 1));

export const emptyChannels = () => ({
  left: { raise: 0, out: 0, swing: 0, elbow: 0, wrist: 0, spread: 0, curl: 0 },
  right: { raise: 0, out: 0, swing: 0, elbow: 0, wrist: 0, spread: 0, curl: 0 },
  torso: { lean: 0, turn: 0, side: 0 },
  head: { nod: 0, turn: 0, tilt: 0 },
  legs: { shift: 0, knee: 0 },
});

export const resetChannels = (ch) => {
  for (const side of ['left', 'right']) {
    Object.assign(ch[side], { raise: 0, out: 0, swing: 0, elbow: 0, wrist: 0, spread: 0, curl: 0 });
  }
  Object.assign(ch.torso, { lean: 0, turn: 0, side: 0 });
  Object.assign(ch.head, { nod: 0, turn: 0, tilt: 0 });
  Object.assign(ch.legs, { shift: 0, knee: 0 });
};

export const mixChannels = (into, spec, weight) => {
  if (!spec || weight <= 0) return;
  for (const side of ['left', 'right']) {
    const src = spec[side];
    if (!src) continue;
    for (const key in src) if (key in into[side]) into[side][key] += src[key] * weight;
  }
  for (const group of ['torso', 'head', 'legs']) {
    const src = spec[group];
    if (!src) continue;
    for (const key in src) if (key in into[group]) into[group][key] += src[key] * weight;
  }
};

export const GESTURES = {
  // A one-handed explanation: the working hand lifts and turns over while the
  // other stays relaxed. This is the workhorse of her talking.
  explainRight: {
    dur: 2.6,
    build: (p) => {
      const e = pulse(p, 0.45, 0.9);
      return {
        right: { raise: 0.3 * e, out: 0.22 * e, elbow: 0.95 * e, swing: 0.12 * e, wrist: 0.5 * e, spread: 0.55 * e, curl: 0.15 * e },
        left: { elbow: 0.12 * e },
        torso: { turn: -0.035 * e },
        head: { nod: 0.02 * e, turn: -0.03 * e },
      };
    },
  },
  explainLeft: {
    dur: 2.4,
    build: (p) => {
      const e = pulse(p, 0.45, 0.9);
      return {
        left: { raise: 0.28 * e, out: 0.24 * e, elbow: 0.9 * e, swing: 0.1 * e, wrist: 0.45 * e, spread: 0.5 * e, curl: 0.15 * e },
        right: { elbow: 0.1 * e },
        torso: { turn: 0.035 * e },
        head: { nod: 0.02 * e, turn: 0.03 * e },
      };
    },
  },
  // Emphasis on a stressed word: a compact downward beat of the forearm.
  emphasisRight: {
    dur: 1.15,
    build: (p) => {
      const beat = Math.sin(Math.PI * clamp(p / 0.55, 0, 1)) * (1 - smoothstep(0.6, 1, p));
      return {
        right: { raise: 0.16 * beat, out: 0.14 * beat, elbow: 0.55 * beat, wrist: 0.2 * beat, curl: 0.25 * beat },
        head: { nod: 0.035 * beat },
        torso: { lean: -0.015 * beat },
      };
    },
  },
  emphasisLeft: {
    dur: 1.1,
    build: (p) => {
      const beat = Math.sin(Math.PI * clamp(p / 0.55, 0, 1)) * (1 - smoothstep(0.6, 1, p));
      return {
        left: { raise: 0.15 * beat, out: 0.13 * beat, elbow: 0.52 * beat, wrist: 0.18 * beat, curl: 0.25 * beat },
        head: { nod: 0.03 * beat },
      };
    },
  },
  // Both palms open outwards: "here is the thing", questions, anything aimed
  // at the person listening.
  openBoth: {
    dur: 2.1,
    build: (p) => {
      const e = pulse(p, 0.45, 0.85);
      return {
        left: { raise: 0.26 * e, out: 0.34 * e, elbow: 0.6 * e, swing: 0.22 * e, wrist: 0.6 * e, spread: 0.85 * e, curl: 0.05 * e },
        right: { raise: 0.26 * e, out: 0.34 * e, elbow: 0.6 * e, swing: 0.22 * e, wrist: 0.6 * e, spread: 0.85 * e, curl: 0.05 * e },
        torso: { lean: 0.02 * e },
        head: { nod: 0.02 * e, tilt: 0.03 * e },
      };
    },
  },
  pointForward: {
    dur: 1.9,
    build: (p) => {
      const e = pulse(p, 0.4, 0.7);
      return {
        right: { raise: 0.42 * e, out: 0.16 * e, elbow: 0.35 * e, swing: 0.4 * e, wrist: 0.15 * e, spread: -0.15 * e, curl: 0.45 * e },
        head: { nod: 0.03 * e, turn: -0.02 * e },
        torso: { lean: 0.02 * e },
      };
    },
  },
  shrug: {
    dur: 1.7,
    build: (p) => {
      const e = pulse(p, 0.45, 0.8);
      return {
        left: { raise: 0.12 * e, out: 0.26 * e, elbow: 0.55 * e, wrist: 0.3 * e, spread: 0.4 * e },
        right: { raise: 0.12 * e, out: 0.26 * e, elbow: 0.55 * e, wrist: 0.3 * e, spread: 0.4 * e },
        head: { tilt: 0.06 * e, nod: -0.01 * e },
        torso: { side: 0.02 * e },
      };
    },
  },
  // Thinking: forearm up near the chin, hand loose, head tipped away.
  thinkChin: {
    dur: 3.4,
    build: (p) => {
      const e = smoothstep(0, 0.25, p) * (1 - smoothstep(0.8, 1, p));
      const drift = Math.sin(p * Math.PI * 3) * 0.02 * e;
      return {
        right: { raise: 0.4 * e, out: 0.1 * e, elbow: 1.35 * e, swing: 0.12 * e, wrist: 0.6 * e, spread: -0.1 * e, curl: 0.55 * e },
        left: { elbow: 0.18 * e },
        head: { tilt: 0.1 * e + drift, turn: -0.05 * e, nod: -0.02 * e },
        torso: { turn: 0.04 * e, side: 0.02 * e },
      };
    },
  },
  tiltCurious: {
    dur: 2.6,
    build: (p) => {
      const e = pulse(p, 0.45, 0.85);
      return {
        head: { tilt: 0.16 * e, turn: 0.06 * e },
        right: { raise: 0.18 * e, out: 0.24 * e, elbow: 0.7 * e, wrist: 0.5 * e, spread: 0.5 * e },
        torso: { side: 0.02 * e, turn: 0.03 * e },
        legs: { shift: 0.015 * e },
      };
    },
  },
  nodYes: {
    dur: 1.5,
    build: (p) => {
      const a = Math.sin(p * Math.PI * 2.4) * (1 - smoothstep(0.65, 1, p));
      return { head: { nod: 0.07 * a }, torso: { lean: 0.008 * a } };
    },
  },
  nodSlow: {
    dur: 2.2,
    build: (p) => {
      const a = Math.sin(p * Math.PI) * (1 - smoothstep(0.7, 1, p));
      return { head: { nod: 0.06 * a, tilt: 0.02 * a }, torso: { lean: 0.012 * a }, right: { elbow: 0.12 * a } };
    },
  },
  // A real wave: raised upper arm, forearm swinging, fingers spread.
  wave: {
    dur: 2.8,
    build: (p) => {
      const up = smoothstep(0, 0.3, p) * (1 - smoothstep(0.75, 1, p));
      const swing = Math.sin(p * Math.PI * 4) * 0.22 * up;
      return {
        right: { raise: 0.95 * up, out: 0.42 * up, elbow: 1.05 * up, swing: 0.25 * up + swing, wrist: 0.8 * up, spread: 0.9 * up, curl: 0.05 * up },
        left: { elbow: 0.1 * up },
        head: { tilt: 0.05 * up, nod: 0.02 * up },
        torso: { turn: -0.03 * up, side: -0.015 * up },
      };
    },
  },
  excitedOpen: {
    dur: 2.4,
    build: (p) => {
      const e = smoothstep(0, 0.3, p) * (1 - smoothstep(0.7, 1, p));
      return {
        left: { raise: 0.55 * e, out: 0.4 * e, elbow: 0.5 * e, wrist: 0.7 * e, spread: 0.9 * e },
        right: { raise: 0.55 * e, out: 0.4 * e, elbow: 0.5 * e, wrist: 0.7 * e, spread: 0.9 * e },
        torso: { lean: -0.03 * e },
        head: { nod: -0.02 * e },
        legs: { shift: 0.02 * e },
      };
    },
  },
  // Small idle life: a hand drifts, fingers move, weight settles.
  fidget: {
    dur: 3.2,
    build: (p) => {
      const e = pulse(p, 0.5, 0.9);
      return {
        right: { raise: 0.06 * e, out: 0.08 * e, elbow: 0.28 * e, wrist: 0.35 * e, curl: 0.3 * e, spread: 0.2 * e },
        head: { tilt: 0.03 * e, turn: 0.04 * e },
        torso: { side: 0.015 * e, turn: 0.02 * e },
        legs: { shift: 0.012 * e, knee: 0.04 * e },
      };
    },
  },
  shoulderRoll: {
    dur: 3.6,
    build: (p) => {
      const e = pulse(p, 0.5, 0.95);
      return {
        left: { raise: 0.05 * e, out: 0.12 * e, elbow: 0.2 * e, wrist: 0.2 * e },
        right: { raise: 0.05 * e, out: 0.12 * e, elbow: 0.2 * e, wrist: 0.2 * e },
        torso: { side: 0.02 * e, turn: -0.02 * e },
        head: { nod: 0.02 * e },
      };
    },
  },
  // Relaxed hands come together low, then drift apart: casual conversation.
  handsLow: {
    dur: 2.8,
    build: (p) => {
      const e = pulse(p, 0.45, 0.9);
      return {
        left: { raise: 0.14 * e, out: 0.05 * e, elbow: 0.55 * e, wrist: 0.25 * e, spread: 0.25 * e },
        right: { raise: 0.14 * e, out: 0.05 * e, elbow: 0.55 * e, wrist: 0.25 * e, spread: 0.25 * e },
        head: { nod: 0.02 * e },
        torso: { lean: 0.012 * e },
      };
    },
  },
  leanIn: {
    dur: 3.0,
    build: (p) => {
      const e = pulse(p, 0.5, 0.95);
      return {
        torso: { lean: 0.05 * e, turn: 0.02 * e },
        head: { nod: 0.03 * e, turn: 0.02 * e },
        left: { elbow: 0.25 * e, out: 0.05 * e },
        right: { elbow: 0.25 * e, out: 0.05 * e },
      };
    },
  },
};

// What she reaches for in each situation.
export const SPEECH_POOL = ['explainRight', 'explainLeft', 'openBoth', 'emphasisRight', 'emphasisLeft', 'pointForward', 'handsLow', 'shrug'];
export const IDLE_POOL = ['fidget', 'shoulderRoll', 'nodSlow', 'handsLow', 'tiltCurious', 'leanIn'];
export const LISTEN_POOL = ['nodSlow', 'nodYes', 'tiltCurious', 'leanIn'];
export const THINK_POOL = ['thinkChin', 'tiltCurious', 'nodSlow'];
export const EXCITED_POOL = ['excitedOpen', 'openBoth', 'explainRight', 'wave'];
