// Riko's motion layers.
//
// Each layer adds to the same set of body channels — breathing, posture,
// gestures, weight shift — and the sum is converted to joint rotations once.
// Because they add rather than overwrite, a gesture can never cancel her
// posture, and two gestures running together blend instead of fighting.

import {
  clamp, envelope, resetChannels, mixChannels,
  GESTURES, SPEECH_POOL, IDLE_POOL, LISTEN_POOL, THINK_POOL, EXCITED_POOL,
} from './gestures.js?v=30';

// Her face is the performance now, so the body only hints at what she is
// doing. Everything from the shoulders down is scaled back hard.
const BODY = 0.32;

function pick(av, pool) {
  const fresh = pool.filter((n) => !av.recentGestures.slice(-2).includes(n));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

// Choose a gesture that matches what she is saying right now.
function speechGestureFor(av, text) {
  const s = String(text || '');
  if (/\?$/.test(s.trim()) || /\b(do you|are you|would you|what if)\b/i.test(s)) return 'openBoth';
  if (/\b(but|however|actually|instead|though)\b/i.test(s)) return pick(av, ['emphasisLeft', 'emphasisRight', 'shrug']);
  if (/\b(you|your|we|us|together|welcome)\b/i.test(s)) return pick(av, ['openBoth', 'explainRight', 'explainLeft']);
  if (/\b(so|because|remember|important|really|first|then)\b/i.test(s)) return pick(av, ['emphasisRight', 'pointForward', 'explainRight']);
  return pick(av, SPEECH_POOL);
}

export function playGesture(av, name, strength = 1) {
  const def = GESTURES[name];
  if (!def) return false;
  if (av.gestures.some((g) => g.name === name)) return false;
  av.gestures.push({ name, def, t: 0, strength });
  if (av.gestures.length > 3) av.gestures.shift();
  av.recentGestures.push(name);
  if (av.recentGestures.length > 4) av.recentGestures.shift();
  return true;
}

export function beginClause(av, text, duration) {
  av.speaking = true;
  av.plan = av.buildPlan(text);
  av.planProgress = 0;
  av.planDuration = Math.max(0.4, duration || 1);
  av.clauseIndex += 1;
  if (String(text || '').length > 12 && (av.clauseIndex === 1 || Math.random() < 0.72)) {
    playGesture(av, speechGestureFor(av, text), 0.85 + Math.random() * 0.15);
  }
  av.speechGestureWait = 1.4 + Math.random() * 1.6;
}

export function endSpeech(av) {
  av.speaking = false;
  av.plan = [];
  // A wave already in the air is allowed to finish; everything else stops.
  av.gestures = av.gestures.filter((g) => g.name === 'wave');
  av.idleGestureWait = 1.5 + Math.random() * 2.5;
}

function layerBreathing(av, ch) {
  const t = av.time;
  const breath = Math.sin(t * 1.05) * 0.5 + Math.sin(t * 0.43) * 0.18;
  const idle = av.weights.idle + av.weights.listening * 0.7 + av.weights.speaking * 0.5;
  ch.torso.lean += breath * 0.012 * (0.5 + idle);
  ch.head.nod += Math.sin(t * 0.37) * 0.008;
  ch.left.raise += breath * 0.006;
  ch.right.raise += breath * 0.006;
  // Both arms drift very slightly all the time, so neither ever freezes.
  ch.left.elbow += Math.sin(t * 0.53 + 0.9) * 0.03;
  ch.right.elbow += Math.sin(t * 0.47) * 0.03;
  ch.left.wrist += Math.sin(t * 0.61 + 2.1) * 0.1;
  ch.right.wrist += Math.sin(t * 0.57 + 1.3) * 0.1;
}

function layerPosture(av, ch) {
  const w = av.weights;
  // Arms never dangle straight. A bent elbow, a little abduction and a turned
  // wrist read as "standing comfortably" instead of "switched off".
  ch.left.elbow += 0.4;
  ch.right.elbow += 0.4;
  ch.left.out += 0.16;
  ch.right.out += 0.16;
  ch.left.raise += 0.06;
  ch.right.raise += 0.06;
  ch.left.wrist += 0.15;
  ch.right.wrist -= 0.15;

  if (w.listening > 0.01) {
    ch.left.elbow += 0.1 * w.listening;
    ch.right.elbow += 0.1 * w.listening;
    ch.head.tilt += 0.03 * w.listening;
    ch.torso.lean += 0.015 * w.listening;
    ch.head.nod += Math.sin(av.time * 1.3) * 0.01 * w.listening;
  }
  if (w.thinking > 0.01) {
    ch.head.tilt += 0.07 * w.thinking;
    ch.head.turn -= 0.04 * w.thinking;
    ch.right.raise += 0.06 * w.thinking;
    ch.right.elbow += 0.22 * w.thinking;
    ch.right.out += 0.04 * w.thinking;
  }
  if (w.speaking > 0.01) {
    ch.right.out += 0.1 * w.speaking;
    ch.left.out += 0.1 * w.speaking;
    ch.right.elbow += 0.12 * w.speaking;
    ch.left.elbow += 0.12 * w.speaking;
    ch.torso.lean -= 0.01 * w.speaking;
  }
  if (w.excited > 0.01) {
    ch.left.out += 0.12 * w.excited;
    ch.right.out += 0.12 * w.excited;
    ch.torso.lean -= 0.02 * w.excited;
    ch.head.nod -= 0.01 * w.excited;
  }
  if (w.confused > 0.01) {
    ch.head.tilt += 0.1 * w.confused;
    ch.right.elbow += 0.2 * w.confused;
    ch.right.raise += 0.08 * w.confused;
  }
  if (w.error > 0.01) {
    ch.head.nod += 0.06 * w.error;
    ch.torso.lean += 0.025 * w.error;
    ch.left.raise -= 0.02 * w.error;
    ch.right.raise -= 0.02 * w.error;
  }
  if (w.greeting > 0.01) ch.head.tilt += 0.03 * w.greeting;
}

// Small life while she talks: head follows her voice, the free hand makes small
// movements between the bigger gestures.
function layerSpeechLife(av, ch) {
  if (!av.speaking) return;
  const t = av.time;
  const level = av.mouthLevel;
  ch.head.nod += Math.sin(t * 1.7) * 0.012 + level * 0.02;
  ch.head.turn += Math.sin(t * 0.73) * 0.02;
  ch.torso.turn += Math.sin(t * 0.55) * 0.012;
  ch.left.elbow += Math.sin(t * 1.1) * 0.05;
  ch.right.elbow += Math.cos(t * 0.9) * 0.05;
  ch.left.wrist += Math.sin(t * 1.4) * 0.12;
  ch.right.wrist += Math.cos(t * 1.2) * 0.12;
}

function layerLegs(av, ch) {
  const t = av.time;
  // Weight settles from one leg to the other; the hips tip and the legs
  // counter-rotate, so the feet stay planted where they are.
  const sway = Math.sin(t * 0.23) * 0.022 + Math.sin(t * 0.11 + 1.7) * 0.01;
  ch.legs.shift += sway * 0.5 + Math.sin(t * 0.5) * 0.004;
  ch.legs.knee += 0.02 + Math.sin(t * 0.31) * 0.012;
}

function scheduleGestures(av, d, ch) {
  const w = av.weights;
  const queue = (wait, pool, strength) => {
    av.idleGestureWait -= d;
    if (av.idleGestureWait <= 0 && !av.gestures.length) {
      av.idleGestureWait = wait[0] + Math.random() * (wait[1] - wait[0]);
      playGesture(av, pick(av, pool), strength);
    }
  };

  if (!av.speaking && w.idle > 0.35) queue([8, 16], IDLE_POOL, 0.45 + Math.random() * 0.2);
  if (!av.speaking && w.listening > 0.5) queue([6, 11], LISTEN_POOL, 0.4 + Math.random() * 0.2);
  if (w.thinking > 0.5) queue([4, 7], THINK_POOL, 0.5);
  if (w.excited > 0.5) queue([3, 5], EXCITED_POOL, 0.6);
  if (av.speaking) {
    av.speechGestureWait -= d;
    if (av.speechGestureWait <= 0 && av.gestures.length < 2) {
      av.speechGestureWait = 3.4 + Math.random() * 3;
      playGesture(av, pick(av, SPEECH_POOL), 0.5 + Math.random() * 0.2);
    }
  }

  for (let i = av.gestures.length - 1; i >= 0; i--) {
    const g = av.gestures[i];
    g.t += d;
    const u = g.t / g.def.dur;
    if (u >= 1) {
      av.gestures.splice(i, 1);
      continue;
    }
    mixChannels(ch, g.def.build(u), envelope(u) * g.strength);
  }
}

const add = (av, bone, axis, value) => {
  const entry = av.deltas[bone];
  if (entry) entry[axis] += value;
};

// Her mood moves her head and neck, which is what the camera is actually
// looking at. It is added on top of the small idle movement, never replacing it.
function layerMood(av, ch) {
  ch.head.tilt += av.moodTilt || 0;
  ch.head.turn += av.moodTurn || 0;
  ch.head.nod += av.moodNod || 0;
  // A slow, breathing nod while she holds the viewer's eye.
  ch.head.nod += Math.sin(av.time * 0.52) * 0.006;
  ch.head.tilt += Math.sin(av.time * 0.31 + 1.2) * 0.005;
}

export function buildChannels(av, d) {
  const ch = av.channels;
  resetChannels(ch);
  layerBreathing(av, ch);
  layerPosture(av, ch);
  layerMood(av, ch);
  layerSpeechLife(av, ch);
  scheduleGestures(av, d, ch);
  layerLegs(av, ch);
}

export function applyChannels(av) {
  const ch = av.channels;
  const axes = av.armAxes;
  if (!axes) return;
  // Deltas are rebuilt from the base pose every frame, so nothing accumulates.
  for (const name in av.deltas) {
    const entry = av.deltas[name];
    entry.x = 0;
    entry.y = 0;
    entry.z = 0;
  }

  for (const side of ['left', 'right']) {
    const a = axes[side];
    if (!a) continue;
    const c = ch[side];
    const upper = `${side}UpperArm`;
    const shoulder = `${side}Shoulder`;
    const hand = `${side}Hand`;
    // Lifting and spreading are the same joint motion here (abduction), so they
    // sum onto the measured outward axis. Outward only: rotating an arm inwards
    // is what pushes it through her torso.
    const lift = clamp(Math.max(0, c.out) + Math.max(0, c.raise) * 0.85, 0, 1.55) * BODY;
    const swing = clamp(c.swing, -0.6, 0.9) * BODY;
    const elbow = clamp(c.elbow, 0, 1.5) * (0.55 + BODY * 0.45);
    const wrist = clamp(c.wrist, -1, 1) * BODY;

    add(av, upper, a.out.axis, a.out.sign * lift);
    add(av, upper, a.swing.axis, a.swing.sign * swing);
    add(av, shoulder, a.out.axis, a.out.sign * lift * 0.12);
    add(av, shoulder, a.swing.axis, a.swing.sign * swing * 0.1);
    add(av, `${side}LowerArm`, a.elbow.axis, a.elbow.sign * elbow);
    add(av, hand, 'z', wrist * 0.2);
    add(av, hand, 'x', wrist * 0.13);
    add(av, hand, 'y', wrist * 0.07);

    av.handShape[side] = { spread: c.spread, curl: c.curl };
  }

  const { lean, turn, side: torsoSide } = ch.torso;
  add(av, 'spine', 'x', clamp(lean, -0.12, 0.12) * 0.6);
  add(av, 'chest', 'x', clamp(lean, -0.12, 0.12) * 0.4);
  add(av, 'upperChest', 'x', clamp(lean, -0.12, 0.12) * 0.25);
  add(av, 'spine', 'y', clamp(turn, -0.1, 0.1));
  add(av, 'chest', 'y', clamp(turn, -0.1, 0.1) * 0.5);
  add(av, 'upperChest', 'y', clamp(turn, -0.1, 0.1) * 0.3);
  add(av, 'hips', 'z', clamp(torsoSide, -0.06, 0.06) + ch.legs.shift);
  // Toes take a hint of the weight shift so the feet read as standing.
  add(av, 'leftToes', 'x', -clamp(ch.legs.shift, -0.05, 0.05) * 0.5);
  add(av, 'rightToes', 'x', clamp(ch.legs.shift, -0.05, 0.05) * 0.5);

  const head = ch.head;
  add(av, 'head', 'x', clamp(head.nod, -0.25, 0.25));
  add(av, 'head', 'y', clamp(head.turn, -0.4, 0.4));
  add(av, 'head', 'z', clamp(head.tilt, -0.3, 0.3));
  add(av, 'neck', 'x', clamp(head.nod, -0.2, 0.2) * 0.35);
  add(av, 'neck', 'y', clamp(head.turn, -0.3, 0.3) * 0.3);
  add(av, 'neck', 'z', clamp(head.tilt, -0.25, 0.25) * 0.3);
}
