// Riko's personality layer: moods, teasing reactions, games, and the small
// spontaneous remarks she makes without being asked.
//
// Her answers come from her server. This file holds everything else: the
// expression the current thought puts on her face, what she says during a
// game, and the observation she drops when the room has gone quiet. Every line
// is a Japanese/English pair, exactly like a reply segment, so nothing here can
// be spoken without a subtitle.

const pair = (ja, en) => ({ ja, en });
const choose = (list) => list[Math.floor(Math.random() * list.length)];

/** Draws from a shuffled deck, so a line never repeats until all have been used. */
class Deck {
  constructor(items) {
    this.items = items.slice();
    this.pile = [];
  }

  next() {
    if (!this.items.length) return null;
    if (!this.pile.length) {
      this.pile = this.items.slice();
      for (let i = this.pile.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.pile[i], this.pile[j]] = [this.pile[j], this.pile[i]];
      }
    }
    return this.pile.pop();
  }
}

// How hard she teases. HIGH is her setting: she goes for the joke first and
// only backs off when something is actually wrong.
export const TEASING = 'high';

/* ── moods ───────────────────────────────────────────────────────────────────
   These names are shared with face.js, so a mood here is what her face does. */

export const MOOD_NAMES = new Set([
  'calm', 'smile', 'bright', 'curious', 'thoughtful', 'shy', 'surprise',
  'smug', 'amused', 'annoyed', 'excited', 'disappointed', 'competitive',
  'supportive', 'confused', 'serious', 'playful',
]);

/* Order matters: the first line that matches wins, and the specific moods come
   before the generic ones. */
const MOOD_RULES = [
  ['shy', /\b(embarrass|blush|don't look|stop it|too kind|flatter|i wasn't|shut up,? you)\b/i],
  ['smug', /\b(told you|knew it|called it|i was right|obviously|as i said|of course i|naturally|told you so)\b/i],
  ['competitive', /\b(rematch|bet you|i'll win|bring it|challenge|try me|one more round|best of)\b/i],
  ['disappointed', /\b(disappoint|sigh|i expected more|that's it\?|of course you did|i had hope)\b/i],
  ['annoyed', /\b(seriously|ugh|whatever|ridiculous|are you kidding|unbelievable|don't test me)\b/i],
  ['supportive', /\b(you've got this|i'm here|proud of you|it's okay|take your time|you can do it|i get it)\b/i],
  ['confused', /\b(i don't follow|makes no sense|what do you mean|confus|run that by me|what\?)\b/i],
  ['amused', /\b(haha|lol|funny|hilarious|that's rich|okay,? that was good|i'll allow it)\b/i],
  ['excited', /(!{2}|amazing|can't wait|let's go|excellent|finally!)/i],
  ['curious', /(\?|tell me|what about|how come|i wonder)/i],
];

/** The mood behind a finished English reply, or null when nothing stands out. */
export function moodFromReply(text) {
  const s = String(text || '');
  for (const [name, rule] of MOOD_RULES) if (rule.test(s)) return name;
  if (/!/.test(s)) return 'bright';
  return null;
}

const SERIOUS = /\b(died|passed away|funeral|hospital|diagnos|cancer|depress|anxious|panic|breakup|broke up|divorce|fired|laid off|suicid|grief|grieving|sick|scared|terrified|abused|homeless|miss (her|him|them)|lost (my|our) (job|mum|mom|dad|father|mother|sister|brother))\b/i;

export function isSerious(text) {
  return SERIOUS.test(String(text || ''));
}

/* How the person's own words read, so her face answers them even before the
   server has said anything. */
const USER_MOODS = [
  ['supportive', /\b(i'?m (sad|tired|exhausted|stressed|upset|anxious|scared|struggling)|i feel (awful|terrible|bad)|having a rough|rough day)\b/i],
  ['shy', /\b(you (?:are|'?re) (?:so |really )?(cute|pretty|beautiful|amazing|the best|lovely)|i like you|i love you|you (?:are|'?re) my favou?rite)\b/i],
  ['annoyed', /\b(shut up|you'?re wrong|that'?s stupid|you don'?t know|dumb)\b/i],
  ['competitive', /\b(bet|i can|i'?ll win|i beat|challenge|prove it)\b/i],
  ['amused', /\b(haha|lol|lmao|funny|joke|😂)\b/i],
  ['smug', /\b(i told you|knew it|i was right|obviously|easy)\b/i],
  ['curious', /(\?|how|why|what)\b/i],
];

export function moodForUser(text) {
  const s = String(text || '');
  for (const [name, rule] of USER_MOODS) if (rule.test(s)) return name;
  return null;
}

/* ── things she says on her own ──────────────────────────────────────────── */

const IDLE_LINES = [
  { mood: 'curious', ...pair('ねえ、生きてる?', 'Hey — still alive over there?') },
  { mood: 'amused', ...pair('静かすぎて、こっちが落ち着かないんだけど。', "It's so quiet it's making me nervous.") },
  { mood: 'curious', ...pair('何してるの? 画面の前で固まってるけど。', "What are you doing? You've been frozen in front of the screen.") },
  { mood: 'annoyed', ...pair('ひま。君もひまでしょ。', "I'm bored. You're bored too, aren't you.") },
  { mood: 'playful', ...pair('ちょっと変なこと聞いていい? カレーって飲み物だと思う?', 'Can I ask something weird? Does curry count as a drink?') },
  { mood: 'competitive', ...pair('じゃんけん、やらない? 逃げるなら別にいいけど。', "Rock paper scissors? Unless you're scared.") },
  { mood: 'amused', ...pair('さっきから思ってたんだけど、その姿勢、腰に悪いよ。', "I've been meaning to say — that posture is terrible for your back.") },
  { mood: 'curious', ...pair('ねえ、今日で一番ムカついたこと、何?', 'Hey — what annoyed you most today?') },
  { mood: 'playful', ...pair('なんか面白い話してよ。ハードルは低くていいから。', 'Tell me something interesting. The bar is on the floor.') },
  { mood: 'curious', ...pair('あ、今の間、何考えてたの?', 'That pause just now — what were you thinking about?') },
  { mood: 'smug', ...pair('君って、そういうとこあるよね。', "You do that thing, you know. That thing you do.") },
  { mood: 'playful', ...pair('コーヒー飲んでる? 私の分は?', "Are you having coffee? Where's mine?") },
  { mood: 'curious', ...pair('ちょっと聞くけど、幽霊って信じる?', 'Quick question: do you believe in ghosts?') },
  { mood: 'annoyed', ...pair('…今、ため息ついた?', '...Did you just sigh?') },
  { mood: 'competitive', ...pair('ゲームでもしない? 負けるの嫌いじゃなければ。', "Want to play something? If you don't mind losing.") },
  { mood: 'playful', ...pair('なぞなぞ出すよ。疲れてる? それともやる?', "I've got a riddle. Too tired, or shall we?") },
  { mood: 'curious', ...pair('君の好きな曲、まだ聞いてないんだけど。', "I still haven't heard your favourite song, you know.") },
  { mood: 'amused', ...pair('ずっと黙ってるけど、怒ってる? それとも充電切れ?', "You've gone quiet. Angry, or just out of battery?") },
  { mood: 'shy', ...pair('ね、一つだけ言っていい? …別に、何でもない。', 'Hey, can I say one thing? ...Never mind.') },
  { mood: 'annoyed', ...pair('この部屋、ちょっと暑くない?', "Isn't this room a bit warm?") },
];

const INTERJECTIONS = [
  { mood: 'smug', ...pair('ちなみに今の話、ちょっと自慢っぽかったよ。', 'For the record, that came out a little bit braggy.') },
  { mood: 'curious', ...pair('あ、そうだ。今日、ちゃんと水飲んだ?', "Oh — right. Have you actually had water today?") },
  { mood: 'amused', ...pair('その言い方、微妙に失礼だよね。', 'That phrasing was borderline rude, you know.') },
  { mood: 'playful', ...pair('…今の、自分で言ってて恥ずかしくない?', '...Did that not embarrass you, saying it out loud?') },
  { mood: 'curious', ...pair('ところで、その話の続きは?', 'Anyway — how does that story end?') },
  { mood: 'shy', ...pair('なんか、そういうとこ嫌いじゃないよ。…今のは忘れて。', "That's the kind of thing I don't hate about you. ...Forget I said that.") },
  { mood: 'smug', ...pair('はい、今の私の勝ち。記録しておいて。', "Right, that one's mine. Note it down.") },
  { mood: 'amused', ...pair('君、真面目な顔で変なこと言うよね。', 'You say strange things with a very straight face.') },
];

/* ── games ───────────────────────────────────────────────────────────────── */

const RPS_JA = { rock: 'グー', paper: 'パー', scissors: 'チョキ' };
const RPS_EN = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function readRpsChoice(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(rock|stone)\b|グー|ぐー/.test(t)) return 'rock';
  if (/\bpaper\b|パー|ぱー/.test(t)) return 'paper';
  if (/\b(scissors|scissor|sissors)\b|チョキ|ちょき/.test(t)) return 'scissors';
  return null;
}

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function readNumber(text) {
  const s = String(text || '');
  const digits = /\b(\d{1,3})\b/.exec(s);
  if (digits) return Number(digits[1]);
  const words = s.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  return words ? NUM_WORDS[words[1]] : null;
}

const RIDDLES = [
  {
    q: pair('夜になると増えて、朝には消えてるもの、なーんだ?', 'It grows at night and is gone by morning. What is it?'),
    a: /(star|stars|星)/i,
    answer: pair('星だよ。空、たまには見なよ。', 'Stars. Look up once in a while.'),
  },
  {
    q: pair('歩いても歩いても、ちっとも進まないもの、なーんだ?', 'It walks and walks and never gets anywhere. What is it?'),
    a: /(clock|watch|時計|time)/i,
    answer: pair('時計。針は回ってるのにね。', 'A clock. The hands move, at least.'),
  },
  {
    q: pair('持てば持つほど、大きくなるもの、なーんだ?', 'The more you take, the bigger it gets. What is it?'),
    a: /(hole|穴)/i,
    answer: pair('穴。掘るほど大きくなるやつ。', 'A hole. Digging only makes it bigger.'),
  },
  {
    q: pair('声を出さないのに、こっちの言葉を返してくるもの、なーんだ?', 'It never speaks, yet it answers you back. What is it?'),
    a: /(echo|こだま|反響)/i,
    answer: pair('こだま。…地味に怖くない?', 'An echo. ...Quietly creepy, no?'),
  },
  {
    q: pair('毎日やってくるのに、いつも新しいもの、なーんだ?', 'It arrives every day and is always new. What is it?'),
    a: /(tomorrow|明日)/i,
    answer: pair('明日だよ。来るたびに新品。', 'Tomorrow. Brand new every time.'),
  },
];

const QUIZ = [
  {
    q: pair('クイズ。日本の首都は?', 'Quiz: what is the capital of Japan?'),
    a: /(tokyo|東京)/i,
    r: pair('東京。…それ、小学校でやったよね?', 'Tokyo. ...They covered that in primary school, I think.'),
  },
  {
    q: pair('1年は何日? うるう年はなしで。', 'How many days in a year? No leap years.'),
    a: /\b365\b/,
    r: pair('365日。ちなみにうるう年は366。', '365. Leap years get 366, for the record.'),
  },
  {
    q: pair('水が沸騰する温度、摂氏で何度?', 'At what temperature does water boil, in Celsius?'),
    a: /\b100\b/,
    r: pair('100度。山の上だとちょっと変わるけどね。', 'One hundred. It shifts a little up a mountain.'),
  },
  {
    q: pair('地球に一番近い恒星は?', 'What is the closest star to Earth?'),
    a: /(sun|太陽|sol)/i,
    r: pair('太陽。恒星って言うと、急に遠く感じるでしょ。', 'The Sun. Calling it a star makes it feel further away, right?'),
  },
  {
    q: pair('「吾輩は猫である」を書いたのは誰?', 'Who wrote "I Am a Cat"?'),
    a: /(soseki|natsume|夏目|漱石)/i,
    r: pair('夏目漱石。あの猫、名前はまだ無いんだよ。', 'Natsume Soseki. That cat still has no name.'),
  },
];

const WOULD_YOU_RATHER = [
  {
    q: pair('ずっと眠らない人生と、ずっと寝てる人生、どっち?', 'A life with no sleep, or a life spent asleep — which?'),
    pick: pair('私は寝る方。夢くらい見たいでしょ。', "Me, the sleeping one. You want dreams, don't you."),
  },
  {
    q: pair('一生カレーだけか、一生甘いものだけか。', 'Only curry for life, or only sweets for life.'),
    pick: pair('カレー。甘いものだけは三日で無理になる。', 'Curry. Three days of nothing but sweets and I break.'),
  },
  {
    q: pair('空を飛べるけど誰にも言えないのと、言えるけど飛べないの、どっち?', 'Fly but never tell anyone, or tell everyone and never fly?'),
    pick: pair('飛ぶ方。黙ってればいいだけだし。', 'Flying. I would simply not tell anyone.'),
  },
  {
    q: pair('毎日が月曜日か、毎日が金曜日か。', 'Every day is Monday, or every day is Friday.'),
    pick: pair('金曜。毎日が月曜とか、地獄でしょ。', 'Friday. Every day being Monday is a description of hell.'),
  },
];

const DEBATES = [
  {
    topic: pair('パイナップルはピザに乗せるべき。', 'Pineapple belongs on pizza.'),
    why: pair('甘いのとしょっぱいの、ぶつかるから美味しいんだよ。', 'Sweet and salty are supposed to collide. That is the point.'),
  },
  {
    topic: pair('朝ごはんは絶対に食べるべき。', 'You should always eat breakfast.'),
    why: pair('エンジンかけずに走る車と同じだよ、君の体。', 'Your body on no breakfast is a car running with the engine off.'),
  },
  {
    topic: pair('映画は家で見る方がいい。', 'Films are better at home.'),
    why: pair('一時停止できる時点で、家の勝ち。', 'The moment you can pause, home wins.'),
  },
];

const CHALLENGES = [
  pair('30秒以内に、歌を一曲。ジャンルは問わない。', 'One song, inside thirty seconds. Any genre.'),
  pair('今から10秒、指を一回も動かさないで。', 'Ten seconds. Do not move a single finger.'),
  pair('好きな食べ物を、理由つきで3つ。', 'Three foods you like, with reasons.'),
  pair('今の気分を、一語で。', 'Your mood right now, in one word.'),
  pair('目の前にある物を一つ選んで、自慢してみて。', 'Pick one thing in front of you and brag about it.'),
];

const TWENTY_QUESTIONS = [
  pair('生き物?', 'Is it alive?'),
  pair('手で持てる大きさ?', 'Can you hold it in one hand?'),
  pair('家の中にある?', 'Is it inside your home?'),
  pair('電気で動く?', 'Does it use electricity?'),
  pair('食べられる?', 'Can you eat it?'),
  pair('毎日使う?', 'Do you use it every day?'),
];

const RPS_WIN = [
  pair('私の勝ち。…今の、本気で出した?', 'I win. ...Was that you actually trying?'),
  pair('勝ち。悪くない勝負だったよ、一応。', 'Mine. Not a bad game, technically.'),
  pair('はい、私の勝ち。もう一回やる? 逃げてもいいけど。', "That's me. Again? Or feel free to run."),
];
const RPS_LOSE = [
  pair('負けた。…今のなし。', "I lost. ...That one doesn't count."),
  pair('うわ、負けた。君、そういうとこあるよね。', "Ugh, you got me. You're like that, aren't you."),
  pair('負け。一回だけだよ、一回だけ。', 'You win. Once. Exactly once.'),
];
const RPS_TIE = [
  pair('あいこ。もう一回。', 'A tie. Again.'),
  pair('あいこかよ。はい、もう一回ね。', 'A tie. Fine — again.'),
];

const GAMES = {
  rps: {
    label: 'rock paper scissors',
    start: () => ({
      mood: 'competitive',
      data: { wins: 0, losses: 0 },
      pairs: [
        pair('いいよ、じゃんけん。君から出して。', 'Fine, rock paper scissors. You throw first.'),
        pair('負けたら、素直に負けたって言うんだよ。', 'And when you lose, you admit it properly.'),
      ],
    }),
    turn: (text, game) => {
      const choice = readRpsChoice(text);
      if (!choice) return null;
      const hers = choose(['rock', 'paper', 'scissors']);
      game.rounds += 1;
      const intro = pair(`${RPS_JA[hers]}だよ。`, `${RPS_EN[hers]}.`);

      let mood;
      let tail;
      if (hers === choice) {
        mood = 'competitive';
        tail = choose(RPS_TIE);
      } else if (RPS_BEATS[hers] === choice) {
        game.data.wins += 1;
        mood = 'smug';
        tail = choose(RPS_WIN);
      } else {
        game.data.losses += 1;
        mood = 'annoyed';
        tail = choose(RPS_LOSE);
      }

      const over = game.rounds >= 3;
      const pairs = [intro, tail];
      if (over) {
        pairs.push(
          game.data.wins > game.data.losses
            ? pair('はい、おしまい。…強すぎてごめんね。', "Right, that's enough. ...Sorry for being this good.")
            : pair('…もう一回やる? 今度は本気出すから。', '...Rematch? I will actually try this time.'),
        );
      }
      return {
        pairs,
        mood,
        fact: over
          ? `Played rock paper scissors with Riko: she won ${game.data.wins}, they won ${game.data.losses}`
          : null,
        over,
      };
    },
  },

  number: {
    label: 'the number game',
    start: () => ({
      mood: 'playful',
      data: { target: 1 + Math.floor(Math.random() * 10), tries: 0 },
      pairs: [
        pair('1から10までの数字を、一つ思い浮かべたよ。当ててみて。', "I've picked a number from one to ten. Guess it."),
        pair('三回で当たらなかったら、私の勝ちね。', 'Three misses and I win.'),
      ],
    }),
    turn: (text, game) => {
      const guess = readNumber(text);
      if (guess === null) {
        if (/(give up|don'?t know|no idea|降参|わからない)/i.test(text)) {
          return {
            pairs: [
              pair(`降参? 答えは${game.data.target}でした。`, `Giving up? It was ${game.data.target}.`),
              pair('…とはいえ、逃げたのは君だからね。', "...Though technically you're the one who ran."),
            ],
            mood: 'smug',
            over: true,
          };
        }
        return null;
      }
      game.data.tries += 1;
      if (guess === game.data.target) {
        return {
          pairs: [
            pair('…当たり。勘がいいね。', '...That’s it. Good instinct.'),
            pair('でも次は当たらないから。', "It won't happen twice."),
          ],
          mood: 'annoyed',
          over: true,
        };
      }
      if (game.data.tries >= 3) {
        return {
          pairs: [
            pair(`残念、答えは${game.data.target}だったんだよ。`, `Too bad — it was ${game.data.target}.`),
            pair('三回で当てられないって、ちょっとどうなの。', 'Three tries and nothing. What am I supposed to do with you.'),
          ],
          mood: 'amused',
          over: true,
        };
      }
      const up = guess < game.data.target;
      return {
        pairs: [pair(up ? 'もっと上。' : 'もっと下。', up ? 'Higher.' : 'Lower.')],
        mood: 'smug',
      };
    },
  },

  riddle: {
    label: 'a riddle',
    start: () => {
      const riddle = choose(RIDDLES);
      return {
        mood: 'playful',
        data: { riddle, tries: 0 },
        pairs: [pair('じゃあ、なぞなぞ。', 'Right — a riddle.'), riddle.q],
      };
    },
    turn: (text, game) => {
      const { riddle } = game.data;
      if (riddle.a.test(text)) {
        return {
          pairs: [
            riddle.answer,
            pair('悔しいけど、やるじゃん。', 'Annoying, but well done.'),
          ],
          mood: 'annoyed',
          over: true,
        };
      }
      if (/(give up|no idea|don'?t know|降参|わからない|答えは)/i.test(text)) {
        return {
          pairs: [
            pair('降参? しょうがないなあ。', 'Giving up? How predictable.'),
            riddle.answer,
          ],
          mood: 'smug',
          over: true,
        };
      }
      game.data.tries += 1;
      if (game.data.tries >= 2) {
        return {
          pairs: [
            pair('ぶー。もう一回だけヒントあげる。', 'Wrong. One hint, and that is all.'),
            riddle.answer,
          ],
          mood: 'amused',
          over: true,
        };
      }
      return {
        pairs: [pair('ぶー。ちがうよ。', 'Wrong. Nope.')],
        mood: 'smug',
      };
    },
  },

  would: {
    label: 'would you rather',
    start: () => {
      const item = choose(WOULD_YOU_RATHER);
      return {
        mood: 'curious',
        data: { item, index: 0 },
        pairs: [
          pair('じゃあ、究極の選択ね。', 'Right — the impossible choice.'),
          item.q,
          item.pick,
          pair('で、君はどっち?', 'So which one for you?'),
        ],
      };
    },
    turn: (text, game) => {
      const item = game.data.item;
      const idx = WOULD_YOU_RATHER.indexOf(item);
      const next = WOULD_YOU_RATHER[(idx + 1) % WOULD_YOU_RATHER.length];
      game.data.index += 1;
      if (game.data.index > 2) {
        return {
          pairs: [
            pair('そっち? …まあ、わからなくもないけど。', 'That one? ...I can sort of see it, I suppose.'),
            pair('これ以上の選択は、今日はやめとく。', "We're stopping there. Any more and we'll fall out."),
          ],
          mood: 'amused',
          over: true,
        };
      }
      return {
        pairs: [
          pair('そっち? …まあ、わからなくもないけど。', 'That one? ...I can sort of see it, I suppose.'),
          pair('じゃあ、もう一個いくよ。', 'Fine, one more.'),
          next.q,
        ],
        mood: 'playful',
      };
    },
  },

  twenty: {
    label: 'twenty questions',
    start: () => ({
      mood: 'curious',
      data: { index: 0 },
      pairs: [
        pair('いいよ、20の質問ね。君が何か思い浮かべて、私が聞くから。', 'Fine, twenty questions. You think of something, I will ask.'),
        TWENTY_QUESTIONS[0],
      ],
    }),
    turn: (text, game) => {
      game.data.index += 1;
      if (game.data.index < TWENTY_QUESTIONS.length) {
        return {
          pairs: [choose([
            pair('ふーん。', 'Mm.'),
            pair('なるほどね。', 'Interesting.'),
            pair('そういうことね。', 'So it is one of those.'),
          ]), TWENTY_QUESTIONS[game.data.index]],
          mood: 'thoughtful',
        };
      }
      return {
        pairs: [
          pair('…わかった、たぶん。', '...I have it. Probably.'),
          pair('答え、教えて。当たってたら自慢するから。', 'Tell me the answer. If I got it, I am gloating.'),
        ],
        mood: 'smug',
        over: true,
      };
    },
  },

  quiz: {
    label: 'a quiz',
    start: () => {
      const first = choose(QUIZ);
      return {
        mood: 'competitive',
        data: { current: first, asked: [first], score: 0, round: 1 },
        pairs: [
          pair('クイズね。三問だけ。', 'A quiz. Three questions, that is all.'),
          first.q,
        ],
      };
    },
    turn: (text, game) => {
      const d = game.data;
      const answered = d.current;
      const right = answered.a.test(text);
      if (right) d.score += 1;

      if (d.round >= 3) {
        return {
          pairs: [
            answered.r,
            pair(
              `三問中${d.score}問。…まあ、悪くないんじゃない?`,
              `${d.score} out of three. ...Not bad, I suppose.`,
            ),
          ],
          mood: d.score >= 2 ? 'smug' : 'amused',
          fact: `Scored ${d.score}/3 on Riko's quiz`,
          over: true,
        };
      }

      const next = nextQuiz(d.asked);
      d.asked.push(next);
      d.current = next;
      d.round += 1;
      return {
        pairs: [
          answered.r,
          pair(right ? 'はい、正解。次。' : 'はい、次。', right ? 'Correct. Next.' : 'Next.'),
          next.q,
        ],
        mood: right ? 'smug' : 'annoyed',
      };
    },
  },

  debate: {
    label: 'a debate',
    start: () => {
      const topic = choose(DEBATES);
      return {
        mood: 'competitive',
        data: { topic, rounds: 0 },
        pairs: [
          pair('いいよ、議論しよう。ただし、負けたら認めること。', 'Fine, let us argue. But concede when you lose.'),
          topic.topic,
          topic.why,
          pair('さあ、反論は?', 'So — your move.'),
        ],
      };
    },
    turn: (text, game) => {
      if (/(you win|fair enough|i agree|you'?re right|降参|負けました|君の勝ち)/i.test(text)) {
        return {
          pairs: [
            pair('ふふん。素直でよろしい。', 'Mm. I like you honest.'),
            pair('とはいえ、君の言い分も一理あったよ。…ちょっとだけ。', 'Still — you had a point. A small one.'),
          ],
          mood: 'smug',
          over: true,
        };
      }
      game.data.rounds += 1;
      if (game.data.rounds >= 3) {
        return {
          pairs: [
            pair('はい、時間切れ。…引き分けってことで、勘弁してあげる。', "Time. ...Call it a draw, and I'll let you off."),
            pair('次は負けないから。', "I won't lose next time."),
          ],
          mood: 'amused',
          over: true,
        };
      }
      return {
        pairs: [choose([
          pair('弱い。もっとまともな反論を持ってきて。', 'Weak. Come back with a real argument.'),
          pair('それ、意見じゃなくて感想だよね。', 'That is a feeling, not an argument.'),
          pair('今の、自分で聞き返してみ? たぶん恥ずかしいよ。', 'Say that back to yourself. You will wince.'),
        ])],
        mood: 'smug',
      };
    },
  },

  challenge: {
    label: 'a challenge',
    start: () => {
      const item = choose(CHALLENGES);
      return {
        mood: 'playful',
        data: { item },
        pairs: [
          pair('じゃあ、挑戦状。逃げたら負けね。', 'Right — a challenge. Running away counts as a loss.'),
          item,
        ],
      };
    },
    turn: (text, game) => ({
      pairs: [
        choose([
          pair('…やると思わなかった。', "...I didn't think you would actually do it."),
          pair('はい、合格。じゃあ私の番ね。', 'Pass. Right — my turn.'),
          pair('悪くない。ちょっと見直した。', "Not bad. I've revised my opinion. Slightly."),
        ]),
        pair('今日はこのへんにしといてあげる。', "We'll leave it there for today."),
      ],
      mood: 'amused',
      over: true,
    }),
  },
};

function nextQuiz(asked) {
  const left = QUIZ.filter((q) => !asked.includes(q));
  return left.length ? choose(left) : choose(QUIZ);
}

function detectGame(text) {
  const t = String(text || '');
  if (/\b(rock[\s-]?paper[\s-]?scissors|rps|roshambo|janken)\b|じゃんけん/i.test(t)) return 'rps';
  if (/\b(guess (?:a |the |my )?number|number game|guessing game|higher or lower)\b|数字当て/i.test(t)) return 'number';
  if (/\b(riddle|なぞなぞ)\b/i.test(t)) return 'riddle';
  if (/\bwould you rather\b/i.test(t)) return 'would';
  if (/\b(20|twenty) questions\b/i.test(t)) return 'twenty';
  if (/\b(quiz|trivia|test me)\b/i.test(t)) return 'quiz';
  if (/\b(debate|argue with me|change my mind)\b/i.test(t)) return 'debate';
  if (/\b(challenge me|give me a challenge|dare me|challenge)\b/i.test(t)) return 'challenge';
  if (/\b(play (?:a |something|a game)|let'?s play|i'?m bored|so bored|bored)\b/i.test(t)) {
    return choose(['rps', 'riddle', 'would', 'quiz']);
  }
  return null;
}

/* ── the personality itself ──────────────────────────────────────────────── */

export class Persona {
  constructor() {
    this.mood = 'calm';
    this.moodAt = 0;
    this.game = null;
    this.lastGame = null;
    this.seriousUntil = 0;
    this.idleDeck = new Deck(IDLE_LINES);
    this.interjectionDeck = new Deck(INTERJECTIONS);
    this.lastAsideAt = -Infinity;
    this.asides = 0;
    this.repliesSinceAside = 0;
    this.lastUserMood = null;
  }

  /** What the person just said, before her answer exists. */
  observeUser(text) {
    if (isSerious(text)) {
      this.seriousUntil = performance.now() + 120000;
      this.lastUserMood = 'supportive';
      return;
    }
    this.lastUserMood = isSerious(text) ? 'supportive' : moodForUser(text);
  }

  get serious() {
    return performance.now() < this.seriousUntil;
  }

  /**
   * A game she can run by herself. Returns the opening/turn lines, or null when
   * this message is ordinary conversation and her server should answer it.
   */
  route(text) {
    const clean = String(text || '').trim();
    if (!clean) return null;

    if (this.game) {
      if (/(stop|quit|enough|never mind|forget it|i'?m done|やめ|もういい|終わり)/i.test(clean)) {
        const score = this.game.data?.wins != null
          ? pair('はいはい、終わり。…私の勝ちってことでいいよね。', "Fine, we're done. ...I'm counting that as my win.")
          : pair('はい、おしまい。…逃げたのは君ね。', "Right, we're done. ...You're the one who ran.");
        this.game = null;
        return { pairs: [score], mood: 'smug' };
      }
      const result = this.game.def.turn(clean, this.game);
      if (!result) return null;
      if (result.over) {
        this.game = null;
      }
      return result;
    }

    const id = detectGame(clean);
    if (!id) return null;
    const def = GAMES[id];
    const opened = def.start();
    this.game = { id, def, data: opened.data || {}, rounds: 0, at: Date.now() };
    this.lastGame = id;
    return { pairs: opened.pairs, mood: opened.mood || 'playful' };
  }

  /**
   * The line she adds to her own reply now and then, so an ordinary exchange
   * does not stay ordinary. Rate-limited on purpose.
   */
  interjection() {
    this.repliesSinceAside += 1;
    if (this.serious || this.repliesSinceAside < 3) return null;
    if (Math.random() > 0.22) return null;
    this.repliesSinceAside = 0;
    return this.interjectionDeck.next();
  }

  /**
   * Something to say into a quiet room. The gaps grow every time, so she is
   * company rather than a notification.
   */
  idleAside(now, { idleFor = 0, unlocked = false, busy = true } = {}) {
    if (!unlocked || busy) return null;
    if (now < this.seriousUntil) return null;
    if (this.asides >= 12) return null;
    if (idleFor < 30000) return null;
    const gap = Math.min(180000, 42000 + this.asides * 22000);
    if (now - this.lastAsideAt < gap) return null;
    const line = this.idleDeck.next();
    if (!line) return null;
    this.asides += 1;
    this.lastAsideAt = now;
    return line;
  }

  /** She has just spoken; activity restarts the idle clock elsewhere. */
  noteSpoke() {
    this.asides = Math.max(0, this.asides);
  }

  /** The mood her own finished sentence leaves on her face. */
  finalMood(english, serverMoods = []) {
    if (this.serious) return 'supportive';
    const last = [...serverMoods].reverse().find((m) => MOOD_NAMES.has(m));
    if (last) return last;
    const felt = moodFromReply(english);
    if (felt) return felt;
    if (this.lastUserMood === 'supportive') return 'supportive';
    return this.mood;
  }

  seeMood(name) {
    if (!MOOD_NAMES.has(name)) return;
    this.mood = name;
    this.moodAt = performance.now();
  }

  /** A sentence about her current state, appended to her system prompt. */
  promptNote() {
    const parts = [
      'Teasing intensity: HIGH. Go for the joke, the roast and the smug little victory lap when the moment allows it; dial it back when something is actually wrong.',
    ];
    if (this.serious) {
      parts.push('Their last message was serious. Drop the teasing completely, be warm, and let them talk.');
    } else if (this.lastUserMood) {
      parts.push(`Their last message read as ${this.lastUserMood}; answer that feeling, not just the words.`);
    }
    if (this.game) {
      parts.push(`You are in the middle of ${this.game.def.label}. Stay in the game, stay competitive, and do not restart it.`);
    }
    return parts.join('\n');
  }

  get gameLabel() {
    return this.game ? this.game.def.label : '';
  }
}
