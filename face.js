// Riko's face: mouth shapes from her own words, blinking, gaze and the small
// stack of VRM expressions. It runs alongside the body animation and never
// fights it — nothing here touches a body bone.
//
// At this camera distance the face is the whole performance, so expression is
// treated as a small set of named moods that fade into each other, with the
// words adding a temporary tint on top.

import { clamp, approach } from './gestures.js?v=30';
import { VISEMES } from './rig.js?v=30';

export const EMOTION_WORDS = {
  happy: /(happy|glad|love|lovely|great|nice|wonderful|good|cute|fun|laugh|haha|yay|beautiful|sweet|proud|excited|awesome|thank|welcome back)/gi,
  sad: /(sorry|sad|unfortunately|miss|lost|hurt|tired|lonely|sigh|hard|difficult|afraid|worried)/gi,
  surprised: /(wow|really|oh|whoa|sudden|surpris|amazing|unexpected|no way)/gi,
  angry: /(angry|annoying|hate|rude|mad|frustrat|ugh)/gi,
  shy: /(shy|embarrass|blush|fluster|careful|compliment|you are too kind|stop it)/gi,
};

/* Kokoro does not expose phonemes, so mouth shapes are estimated from the
   letters she is about to say; loudness does the rest. */
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

export function buildVisemePlan(text) {
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

export function readEmotion(text) {
  const s = String(text || '');
  const count = (re) => (s.match(re) || []).length;
  let happy = Math.min(0.5, 0.06 + count(EMOTION_WORDS.happy) * 0.11);
  let sad = Math.min(0.35, count(EMOTION_WORDS.sad) * 0.12);
  let surprised = Math.min(0.4, count(EMOTION_WORDS.surprised) * 0.14);
  const angry = Math.min(0.2, count(EMOTION_WORDS.angry) * 0.09);
  const shy = Math.min(0.4, count(EMOTION_WORDS.shy) * 0.16);
  if (s.includes('!')) happy += 0.05;
  if (s.includes('?')) surprised += 0.04;
  return { happy, sad, surprised, angry, shy };
}

/* The moods her face moves between. Weights are for the VRM expressions;
   the gaze and head hints nudge the eyes and the neck in the same direction,
   which is what actually sells an expression at this distance. */
export const MOODS = {
  calm: {
    happy: 0.12, relaxed: 0.22, surprised: 0.0, sad: 0.0,
    gaze: { x: 0, y: 0 }, tilt: 0.0, turn: 0.0, nod: 0.0,
  },
  smile: {
    happy: 0.32, relaxed: 0.36, surprised: 0.0, sad: 0.0,
    gaze: { x: 0.02, y: 0.0 }, tilt: 0.025, turn: 0.0, nod: -0.004,
  },
  bright: {
    happy: 0.66, relaxed: 0.14, surprised: 0.06, sad: 0.0,
    gaze: { x: 0, y: 0.008 }, tilt: 0.035, turn: 0.0, nod: -0.012,
  },
  curious: {
    happy: 0.26, relaxed: 0.12, surprised: 0.24, sad: 0.0,
    gaze: { x: 0.025, y: -0.006 }, tilt: 0.075, turn: 0.018, nod: -0.006,
  },
  thoughtful: {
    happy: 0.06, relaxed: 0.28, surprised: 0.03, sad: 0.04,
    gaze: { x: -0.05, y: 0.055 }, tilt: 0.05, turn: -0.022, nod: 0.022,
  },
  shy: {
    happy: 0.36, relaxed: 0.44, surprised: 0.07, sad: 0.0,
    gaze: { x: -0.035, y: 0.05 }, tilt: -0.065, turn: -0.03, nod: 0.018,
  },
  surprise: {
    happy: 0.1, relaxed: 0.0, surprised: 0.6, sad: 0.0,
    gaze: { x: 0, y: -0.01 }, tilt: 0.02, turn: 0.0, nod: -0.02,
  },
  // The moods her personality layer asks for. Each one is a different little
  // arrangement of the same five expression weights, plus the head and gaze
  // hints that actually read at this distance.
  smug: {
    happy: 0.34, relaxed: 0.3, surprised: 0.02, sad: 0.0, angry: 0.02,
    gaze: { x: 0.035, y: 0.014 }, tilt: 0.07, turn: 0.026, nod: -0.008,
  },
  amused: {
    happy: 0.68, relaxed: 0.22, surprised: 0.1, sad: 0.0, angry: 0.0,
    gaze: { x: 0, y: 0.005 }, tilt: 0.042, turn: 0.0, nod: -0.014,
  },
  annoyed: {
    happy: 0.05, relaxed: 0.12, surprised: 0.1, sad: 0.04, angry: 0.22,
    gaze: { x: -0.03, y: 0.032 }, tilt: -0.06, turn: -0.022, nod: 0.01,
  },
  excited: {
    happy: 0.8, relaxed: 0.06, surprised: 0.16, sad: 0.0, angry: 0.0,
    gaze: { x: 0, y: -0.01 }, tilt: 0.04, turn: 0.0, nod: -0.016,
  },
  disappointed: {
    happy: 0.02, relaxed: 0.1, surprised: 0.02, sad: 0.34, angry: 0.05,
    gaze: { x: -0.04, y: 0.042 }, tilt: -0.04, turn: -0.03, nod: 0.02,
  },
  competitive: {
    happy: 0.4, relaxed: 0.08, surprised: 0.06, sad: 0.0, angry: 0.08,
    gaze: { x: 0.01, y: -0.012 }, tilt: 0.02, turn: 0.012, nod: -0.012,
  },
  supportive: {
    happy: 0.36, relaxed: 0.42, surprised: 0.02, sad: 0.08, angry: 0.0,
    gaze: { x: 0, y: 0.01 }, tilt: 0.03, turn: 0.0, nod: -0.006,
  },
  confused: {
    happy: 0.05, relaxed: 0.06, surprised: 0.3, sad: 0.02, angry: 0.04,
    gaze: { x: 0.05, y: -0.02 }, tilt: 0.13, turn: 0.032, nod: 0.012,
  },
  playful: {
    happy: 0.58, relaxed: 0.2, surprised: 0.12, sad: 0.0, angry: 0.0,
    gaze: { x: 0.025, y: 0.005 }, tilt: 0.05, turn: 0.02, nod: -0.01,
  },
  serious: {
    happy: 0.04, relaxed: 0.16, surprised: 0.0, sad: 0.1, angry: 0.0,
    gaze: { x: 0, y: 0.02 }, tilt: 0.0, turn: 0.0, nod: 0.006,
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/* Picks what her face is doing, on a slow clock, and blends every channel
   towards it. Nothing here changes instantly: the weights, the gaze and the
   head all fade at their own rate. */
export function advanceMood(av, d) {
  const tone = av.tone || (av.tone = { happy: 0, sad: 0, surprised: 0, angry: 0, shy: 0 });
  // The colour of the words fades out over a few seconds; the mood stays.
  for (const key in tone) tone[key] = approach(tone[key], 0, 0.16, d);

  // A mood she chose on purpose holds for a moment before the idle rotation
  // is allowed to take the face back.
  av.moodHold = Math.max(0, (av.moodHold || 0) - d);
  av.moodWait = (av.moodWait ?? 3) - d;
  if (av.moodWait <= 0 && av.moodHold <= 0) {
    av.moodWait = 4.5 + Math.random() * 5.5;
    let pool = ['calm', 'smile', 'smile', 'bright'];
    switch (av.state) {
      case 'thinking': pool = ['thoughtful', 'thoughtful', 'calm']; break;
      case 'listening': pool = ['curious', 'curious', 'smile']; break;
      case 'speaking': pool = ['smile', 'calm', 'bright', 'curious']; break;
      case 'greeting': pool = ['bright', 'smile']; break;
      case 'excited': pool = ['bright', 'bright', 'surprise']; break;
      case 'confused': pool = ['curious', 'thoughtful']; break;
      case 'error': pool = ['calm']; break;
      default: break;
    }
    let next = pick(pool);
    // A strong feeling in the words overrides the neutral rotation.
    if (tone.surprised > 0.28) next = 'surprise';
    else if (tone.shy > 0.2) next = 'shy';
    else if (tone.happy > 0.32) next = Math.random() < 0.5 ? 'bright' : 'smile';
    if (next === av.moodName) next = pick(pool.filter((m) => m !== av.moodName)) || next;
    av.moodName = MOODS[next] ? next : 'calm';
  }
  const mood = MOODS[av.moodName] || MOODS.calm;

  // Two small, irregular accents: a brow lift and a smile that arrive between
  // moods so her face is never completely still.
  av.browWait = (av.browWait ?? 5) - d;
  if (av.browWait <= 0) {
    av.browWait = 5.5 + Math.random() * 7;
    av.browPulse = 1;
  }
  av.browPulse = Math.max(0, (av.browPulse || 0) - d * 2.1);
  av.smileWait = (av.smileWait ?? 7) - d;
  if (av.smileWait <= 0) {
    av.smileWait = 7 + Math.random() * 8;
    av.smilePulse = 1;
  }
  av.smilePulse = Math.max(0, (av.smilePulse || 0) - d * 1.25);

  const target = av.emotionTarget;
  target.happy = clamp(mood.happy + tone.happy * 0.55 + av.smilePulse * 0.12, 0, 1);
  target.relaxed = clamp(mood.relaxed + tone.shy * 0.35 + av.smilePulse * 0.08, 0, 1);
  target.surprised = clamp(mood.surprised + tone.surprised * 0.45 + av.browPulse * 0.1, 0, 1);
  target.sad = clamp(mood.sad + tone.sad * 0.5, 0, 1);
  target.angry = clamp((mood.angry || 0) + tone.angry * 0.4, 0, 1);

  // Head and gaze hints travel with the mood, smoothed separately.
  const rate = Math.min(1, d * 1.1);
  av.moodGaze = av.moodGaze || { x: 0, y: 0 };
  av.moodGaze.x += (mood.gaze.x + tone.shy * -0.02 - av.moodGaze.x) * rate;
  av.moodGaze.y += (mood.gaze.y + tone.shy * 0.03 - av.moodGaze.y) * rate;
  av.moodTilt = (av.moodTilt || 0) + (mood.tilt - (av.moodTilt || 0)) * rate;
  av.moodTurn = (av.moodTurn || 0) + (mood.turn - (av.moodTurn || 0)) * rate;
  av.moodNod = (av.moodNod || 0) + (mood.nod - (av.moodNod || 0)) * rate;
}

/* Mouth: the viseme timeline follows the clip's own clock rather than raw
   loudness, so quiet syllables cannot make the mouth fall behind the words.
   Openness is deliberately restrained — at this distance a wide mouth reads as
   shouting. */
export function advanceMouth(av, d) {
  const targets = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  const level = av.mouthLevel;

  if (av.speaking && av.plan.length) {
    av.planProgress = Math.min(1, av.planProgress + d / av.planDuration);
    const total = av.plan.reduce((sum, p) => sum + p.dur, 0);
    let pos = av.planProgress * total;
    let index = 0;
    while (index < av.plan.length - 1 && pos > av.plan[index].dur) {
      pos -= av.plan[index].dur;
      index++;
    }
    const blend = clamp(pos / av.plan[index].dur, 0, 1);
    const current = av.plan[index];
    const next = av.plan[Math.min(av.plan.length - 1, index + 1)];
    const mix = (a, b, w) => a * (1 - w) + b * w;
    const shapeW = mix(current.w, next.w, blend * 0.5);
    const openness = clamp(level * 2.1, 0, 1) * shapeW;

    if (current.v) targets[current.v] += openness * 0.8;
    if (blend > 0.45 && next.v) targets[next.v] += openness * 0.4 * blend;
    // A little jaw opening on every voiced sound keeps it from looking stamped.
    targets.aa += openness * 0.18;
  }

  av.lastTargets = { ...targets };
  for (const key of VISEMES) {
    const target = clamp(targets[key], 0, 1);
    av.mouth[key] = approach(av.mouth[key], target, target > av.mouth[key] ? 26 : 13, d);
  }
}

/* Blinks: irregular gaps, an occasional double blink, and a slower, heavier
   blink now and then so it never looks metronomic. She blinks more often while
   she is talking, the way people do. */
export function advanceBlink(av, d) {
  if (!av.blinkKey && !av.hasSplitBlink) return;
  av.blinkWait -= d;
  if (av.blinkWait <= 0 && av.blinkPhase < 0) {
    av.blinkPhase = 0;
    const roll = Math.random();
    av.blinkDouble = roll < 0.16;
    av.blinkSlow = roll > 0.88;
    av.blinkWait = av.speaking ? 1.7 + Math.random() * 3.2 : 2.2 + Math.random() * 5.2;
  }

  const speed = av.blinkSlow ? 1.7 : 1;
  let value = 0;
  if (av.blinkPhase >= 0) {
    av.blinkPhase += d / (0.14 * speed);
    if (av.blinkPhase >= 1) {
      av.blinkPhase += d / (0.07 * speed); // hold shut briefly
      value = av.blinkPhase < 1.3 ? 1 : 0;
      if (av.blinkPhase >= 1.4) {
        if (av.blinkDouble) {
          av.blinkDouble = false;
          av.blinkPhase = 0;
        } else {
          av.blinkPhase = -1;
          av.blinkSlow = false;
        }
      }
    } else {
      value = Math.sin(av.blinkPhase * Math.PI * 0.5);
    }
  }
  av.eyeBlink = clamp(value * (1 - av.weights.thinking * 0.2), 0, 1);
}

export function applyExpressions(vrm, available, mouth, eyeBlink, emotion, moodName, names = {}) {
  const manager = vrm?.expressionManager;
  if (!manager) return;
  const actual = (name) => names[name] || name;
  if (available.has('blink')) manager.setValue(actual('blink'), eyeBlink || 0);
  else if (available.has('blinkLeft') && available.has('blinkRight')) {
    manager.setValue(actual('blinkLeft'), eyeBlink || 0);
    manager.setValue(actual('blinkRight'), eyeBlink || 0);
  }

  const soft = (name, value) => {
    if (available.has(name)) manager.setValue(actual(name), clamp(value, 0, 1));
  };

  soft('happy', emotion.happy * 0.82);
  soft('relaxed', (emotion.relaxed ?? 0) * 0.9);
  soft('sad', emotion.sad * 0.46);
  soft('angry', emotion.angry * 0.3);
  soft('surprised', emotion.surprised * 0.5);

  for (const key of VISEMES) soft(key, mouth[key]);
}
