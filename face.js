// Riko's face: mouth shapes from her own words, blinking, gaze and the small
// stack of VRM expressions. It runs alongside the body animation and never
// fights it — nothing here touches a body bone.

import { clamp, approach } from './gestures.js?v=29';
import { VISEMES } from './rig.js?v=29';

export const EMOTION_WORDS = {
  happy: /(happy|glad|love|lovely|great|nice|wonderful|good|cute|fun|laugh|haha|yay|beautiful|sweet|proud|excited|awesome|thank)/gi,
  sad: /(sorry|sad|unfortunately|miss|lost|hurt|tired|lonely|sigh|hard|difficult|afraid|worried)/gi,
  surprised: /(wow|really|oh|whoa|sudden|surpris|amazing|unexpected)/gi,
  angry: /(angry|annoying|hate|rude|mad|frustrat|ugh)/gi,
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
  let happy = 0.1 + Math.min(0.22, count(EMOTION_WORDS.happy) * 0.09);
  let sad = Math.min(0.25, count(EMOTION_WORDS.sad) * 0.11);
  let surprised = Math.min(0.22, count(EMOTION_WORDS.surprised) * 0.11);
  const angry = Math.min(0.16, count(EMOTION_WORDS.angry) * 0.08);
  if (s.includes('!')) happy += 0.05;
  if (s.includes('?')) surprised += 0.04;
  return { happy, sad, surprised, angry };
}

/* Mouth: the viseme timeline follows the clip's own clock rather than raw
   loudness, so quiet syllables cannot make the mouth fall behind the words. */
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
    const openness = clamp(level * 2.4, 0, 1) * shapeW;

    if (current.v) targets[current.v] += openness * 0.9;
    if (blend > 0.45 && next.v) targets[next.v] += openness * 0.45 * blend;
    // A little jaw opening on every voiced sound keeps it from looking stamped.
    targets.aa += openness * 0.22;
  }

  av.lastTargets = { ...targets };
  for (const key of VISEMES) {
    const target = clamp(targets[key], 0, 1);
    av.mouth[key] = approach(av.mouth[key], target, target > av.mouth[key] ? 26 : 13, d);
  }
}

export function advanceBlink(av, d) {
  if (!av.blinkKey && !av.hasSplitBlink) return;
  av.blinkWait -= d;
  if (av.blinkWait <= 0 && av.blinkPhase < 0) {
    av.blinkPhase = 0;
    av.blinkDouble = Math.random() < 0.18;
    av.blinkWait = 1.8 + Math.random() * 4.2;
  }

  let value = 0;
  if (av.blinkPhase >= 0) {
    av.blinkPhase += d / 0.14;
    if (av.blinkPhase >= 1) {
      av.blinkPhase += d / 0.07; // hold shut briefly
      value = av.blinkPhase < 1.3 ? 1 : 0;
      if (av.blinkPhase >= 1.4) {
        if (av.blinkDouble) {
          av.blinkDouble = false;
          av.blinkPhase = 0;
        } else {
          av.blinkPhase = -1;
        }
      }
    } else {
      value = Math.sin(av.blinkPhase * Math.PI * 0.5);
    }
  }
  av.eyeBlink = clamp(value * (1 - av.weights.thinking * 0.25), 0, 1);
}

export function applyExpressions(vrm, available, mouth, eyeBlink, emotion) {
  const manager = vrm?.expressionManager;
  if (!manager) return;
  if (available.has('blink')) manager.setValue('blink', eyeBlink || 0);
  else if (available.has('blinkLeft') && available.has('blinkRight')) {
    manager.setValue('blinkLeft', eyeBlink || 0);
    manager.setValue('blinkRight', eyeBlink || 0);
  }

  const soft = (name, value) => {
    if (available.has(name)) manager.setValue(name, clamp(value, 0, 1));
  };
  soft('happy', emotion.happy * 0.55);
  soft('sad', emotion.sad * 0.32);
  soft('angry', emotion.angry * 0.22);
  soft('surprised', emotion.surprised * 0.26);

  for (const key of VISEMES) soft(key, mouth[key]);
}
