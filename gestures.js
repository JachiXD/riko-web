// Riko's gesture library.
//
// Gestures are described in body terms — raise an arm, bend the elbow, open the
// fingers — never in raw Euler angles. The rig module measures which axis does
// what on this model, so these descriptions stay readable and portable.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
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

// The gesture table itself lives in its own module; the helpers above are the
// only thing every other module needs from here.
export * from './gesture-library.js?v=29';
