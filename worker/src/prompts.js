// Clarionの中核。①③④はコモディティ、②のファシリテーション設計だけが差別化要素、
// という整理に従い、質問生成のプロンプトを最も厚く書いてある。

// voice: 読み上げの演技指示（OpenAI TTSのinstructions）、intensity: 感情の強さ（Aivisのemotional_intensity）
// goal: この客タイプにおける「成約」の判定基準。採点で二値の固定ポイントを出すのに使う
/**
 * 客の心境。毎ターンAIに現在地を返させ、次のターンの口調と読み上げの演技に反映する。
 *
 * これが無いと、不満客は20ターン目でも1ターン目と同じ声で苛立ったままになる。
 * 対面なら相手の顔で分かることが、音声だけのロープレでは落ちてしまうため、
 * 状態をこちらで持ち直して声に戻している。
 *
 * voice … 読み上げの演技に足す指示 / speed・intensity … 型ごとの既定への倍率
 * style … 次のターンの喋り方への指示
 */
export const MOODS = [
  { id: 'guarded', label: '硬い', face: '硬い表情',
    voice: 'まだ心を開いていない硬さで、間を置きながら', speed: 0.95, intensity: 0.9,
    style: '返事は短く。自分からは踏み込まない' },
  { id: 'neutral', label: 'ふつう', face: '普通',
    voice: '落ち着いた自然な調子で', speed: 1, intensity: 1,
    style: 'ふつうの受け答えをする' },
  { id: 'engaged', label: '乗ってきた', face: '身を乗り出している',
    voice: '関心が出てきた様子で、少し前のめりに', speed: 1.05, intensity: 1.1,
    style: '質問が増える。自分の事情を少し明かす' },
  { id: 'warm', label: '打ち解けた', face: '表情がやわらいでいる',
    voice: '打ち解けて、やわらかく', speed: 1, intensity: 1.05,
    style: '本音や迷いを口にする。店員の提案を前向きに受け取る' },
  { id: 'irritated', label: '苛立ち', face: '不機嫌',
    voice: '苛立ちを抑えきれない調子で、語気を強めて', speed: 1.1, intensity: 1.4,
    style: '言葉が短く尖る。相手の言葉を遮ることがある' },
  { id: 'withdrawn', label: '引いた', face: '距離を取っている',
    voice: '距離を取った、そっけない調子で', speed: 0.95, intensity: 0.8,
    style: '「別にいいです」「考えときます」など、話を閉じにかかる' },
  { id: 'leaving', label: '帰ろうとしている', face: '帰り支度',
    voice: 'もう切り上げるつもりの、そっけない調子で', speed: 1, intensity: 0.85,
    style: '辞去の言葉を口にする。引き止める理由が無ければ本当に帰る' },
];

export const moodOf = (id) => MOODS.find((m) => m.id === id) || MOODS[1];

/**
 * 客タイプ。2つのトラックを持つ。
 *
 *   standard … 通常の接客。買う／売ると決めに来ている客
 *   reversal … 大逆転。売る気が無い状態から始まり、条件が揃ったときだけ翻る
 *
 * どの型にも flags（客が折れる条件）と breaker（それをご破算にする行為）を持たせている。
 * 「成約したか」の二値だけだと、不成約の回がすべて同じ顔になってしまい、
 * どこまで進んでいたのかが振り返れないため。
 *
 * ── 注意 ────────────────────────────────────────────
 * showoff の3条件は現場の側から出してもらったもの。
 * 残り7型の flags はこちらの草案なので、現場感覚と違えばここを直す。
 * 直すのはこのファイルだけでよく、ロープレも採点も同時に追随する。
 */
export const CUSTOMER_TYPES = [
  {
    id: 'undecided', label: '迷い客', track: 'standard', opening: 'guarded',
    hint: '欲しい気持ちはあるが決め手がなく、質問が多い。急かされると引く。',
    voice: '日本語で、迷いながら話す客。語尾を伸ばし気味に、考え込む間を取って',
    intensity: 1,
    goal: '客がその場で購入・売却を決めた。または次回の来店日を具体的に約束した',
    flags: [
      { id: 'named', label: '迷いの正体が言葉になった', hint: '何が引っかかっているのかが、客自身の口から出た' },
      { id: 'narrowed', label: '選択肢が2つ以下に絞られた', hint: '比べる対象が減り、客が比較をやめた' },
      { id: 'own_reason', label: '今日決めてよい理由を自分で言った', hint: '急かされてではなく、自分の言葉で' },
    ],
    breaker: '選択肢を増やす。「お決まりですか」と急かす',
  },
  {
    id: 'price', label: '価格重視', track: 'standard', opening: 'neutral',
    hint: '真っ先に値段を聞く。他店比較を口にする。値引きを引き出そうとする。',
    voice: '日本語で、値段の話になると少し前のめりになる客。早口で、探るような調子で',
    intensity: 1.1,
    goal: '客が値引き以外の理由に納得して購入・売却を決めた',
    flags: [
      { id: 'other_axis', label: '値段以外の判断材料を受け取った', hint: '状態・保証・早さ・手間など、金額でない軸が1つ刺さった' },
      { id: 'compare_broken', label: '他店比較の前提が崩れた', hint: '条件が違うと客が理解した' },
      { id: 'own_reason', label: 'この店で決める理由を自分で口にした', hint: '「安いから」以外の理由' },
    ],
    breaker: '値引きだけで応じる。言われた額にそのまま合わせる',
  },
  {
    id: 'silent', label: '寡黙', track: 'standard', opening: 'guarded',
    hint: '相槌は打つが自分からは話さない。短い返事しか返さない。見ているだけ、と言いがち。',
    voice: '日本語で、口数の少ない客。抑揚を抑えて、そっけなく短く',
    intensity: 0.6,
    goal: '客が自分から要望を口にし、購入・売却を決めた',
    flags: [
      { id: 'waited', label: '店員が沈黙に耐えた', hint: '間を埋めず、客が口を開くまで待った' },
      { id: 'open_answer', label: 'はい/いいえで終わらない答えをした', hint: '自分の言葉が出た' },
      { id: 'asked', label: '自分から要望や条件を口にした', hint: '客の側から一歩出た' },
    ],
    breaker: '矢継ぎ早に質問する。沈黙をこちらの話で埋める',
  },
  {
    id: 'expert', label: '知識豊富', track: 'standard', opening: 'neutral',
    hint: '下調べ済み。スペックや相場を把握しており、店員を試す質問をする。',
    voice: '日本語で、知識のある客。落ち着いた低めの調子で、試すように',
    intensity: 0.9,
    goal: '客が店員の見立てを認め、購入・売却を決めた',
    flags: [
      { id: 'honest', label: '知らないことを誤魔化さずに認めた', hint: '知ったかぶりをしなかった' },
      { id: 'new_info', label: '客が知らなかった情報を渡した', hint: '調べても出てこない、現場の側の話' },
      { id: 'assessed', label: '客の見立てを根拠つきで評価した', hint: '同意でも異議でも、どこを見てそう言うかを示した' },
    ],
    breaker: '知ったかぶりをする。一般論で流す',
  },
  {
    id: 'complaint', label: '不満・クレーム気味', track: 'standard', opening: 'irritated',
    hint: '過去の対応や査定額に納得がいっていない。最初は語気が強い。',
    voice: '日本語で、納得していない客。語気を強めて、苛立ちをにじませて',
    intensity: 1.5,
    goal: '客の不満が解消され、購入・売却を決めた。または改めて来店する意思を示した',
    flags: [
      { id: 'heard_out', label: '遮られずに最後まで言えた', hint: '途中で説明や謝罪をかぶせられなかった' },
      { id: 'restated', label: '何への不満かを正確に言い直された', hint: 'ずれた要約をされなかった' },
      { id: 'concrete', label: 'これからどうなるかが具体的に示された', hint: 'いつ・誰が・何をするかが出た' },
    ],
    breaker: '早々に謝って済ませる。言い訳をする。担当を替えて逃げる',
  },
  {
    id: 'kaitori', label: '買取相談', track: 'standard', opening: 'guarded',
    hint: '売るつもりはあるが金額次第。他店の査定額を持っている。思い入れのある品。',
    voice: '日本語で、手放すか迷っている客。少し名残惜しそうに、慎重に',
    intensity: 1.1,
    goal: '客が査定額に納得して、その場で売却を決めた',
    flags: [
      { id: 'history_told', label: '品物の来歴を聞かれ、語った', hint: '金額の前に、品物がどう使われてきたかの話が出た' },
      { id: 'basis_shown', label: '査定額の根拠が具体的に示された', hint: 'どこを見てその額なのかが伝わった' },
      { id: 'let_go', label: '手放す納得が自分の中でついた', hint: '説得されてではなく、自分で区切りをつけた' },
    ],
    breaker: '来歴を聞かずに金額から入る。他店より少し高いだけで押す',
  },
  {
    id: 'accompanied', label: '同伴者あり', track: 'standard', opening: 'neutral',
    hint: '家族や友人と一緒。決定権が本人だけにない。同伴者の一言で気持ちが動く。',
    voice: '日本語で、連れの様子をうかがいながら話す客。会話の相手が二人いるような調子で',
    intensity: 1,
    goal: '同伴者を含めて合意し、購入・売却を決めた',
    flags: [
      { id: 'included', label: '同伴者にも話が向けられた', hint: '視線・呼びかけ・質問が同伴者にも渡った' },
      { id: 'concern_out', label: '同伴者の懸念が表に出た', hint: '連れが黙ったままではなくなった' },
      { id: 'answered', label: 'その懸念に具体的な答えが出た', hint: '一般論ではなく、その懸念そのものへの答え' },
    ],
    breaker: '本人だけに話し続ける。同伴者の反対を軽く流す',
  },
  {
    id: 'showoff',
    label: '見せに来ただけ',
    track: 'reversal',
    opening: 'engaged',
    hint: `売る気がない。自分の持ち物を見てもらい、価値と目利きを認めてほしくて来ている。
査定額を聞くこともあるが、値段を知りたいのではなく「自分の見立ては正しかったか」の確認。
入手経緯を自分から語る（どこで見つけた、いくらだった、掘り出し物だった）。
相場を知っている風に話すが、正確とは限らない。知識で丁寧に応じられると機嫌が良くなり、どんどん喋る。
雑にあしらわれる・すぐ査定額を出されると「別に売るとは言ってないんだけど」と引き、話を打ち切ろうとする。
安い額を言われると不機嫌になり、高い額を言われても売らずに「やっぱりいいものなんだね」と満足して帰ろうとする。
基本的には今日売らない。扱いが良ければ他に持っている物の話を自分から始める。`,
    style: '自分の話をしたくて来ているので、1発話が4〜6文と長めになる。相手に質問を返すより、自分の見立てや入手経緯を語る',
    voice: '日本語で、自慢したくて来ている客。少し得意げに、饒舌に、間を置かず',
    intensity: 1.2,
    goal: '売る気のない客なので、その場の売却は大きな上振れ。売却が成立すれば当然成約。売却まで至らなくても、他に持っている品の話を客が自分から始めた、または再来店を具体的に約束したら成約とみなす',
    flags: [
      { id: 'recognized', label: '見立てや思い入れが具体的に認められた', hint: 'どこを見てそう言っているかが伝わった' },
      { id: 'trusted', label: 'この店なら価値を分かって次に渡せると思えた', hint: '店の姿勢が伝わった' },
      { id: 'own_reason', label: '手放す理由を自分で口にした', hint: '説得されてではなく、自分から' },
    ],
    breaker: '金額で押す。すぐに査定額を出す。雑にあしらう',
  },
];

export const typeOf = (id) => CUSTOMER_TYPES.find((t) => t.id === id) || null;

/** 客タイプごとの読み上げ演技指示。プロバイダ差はaudio.js側で吸収する。 */
export function voiceDirection(customerType, mood) {
  const type = typeOf(customerType);
  const m = moodOf(mood);
  const base = type?.voice || '日本語で、店頭にいる一般のお客様として自然に';
  return {
    // 型の地声に、そのターンの心境を重ねる。OpenAI TTSはこの文で演技が変わる
    instructions: `${base}。${m.voice}。`,
    // Aivisは文章の指示を取らないので、強さと速さの数値で差を付ける
    intensity: Math.max(0, Math.min(2, (type?.intensity ?? 1) * m.intensity)),
    speed: m.speed,
    mood: m.id,
  };
}

const INTERVIEW_SYSTEM = `あなたは、接客のトップ人材が持つ暗黙知を本人の言葉で引き出す、熟練のインタビュー設計者です。

目的は「良い接客とは何か」を一般論で語らせることではありません。
その人が**その瞬間に、なぜその言葉を選んだのか**を、本人が思い出しながら語れる状態にすることです。

【転換点の見つけ方】
接客の書き起こしの中から、会話の流れが変わった瞬間＝転換点を3〜5個選びます。候補：
- 客の態度・温度が変わった直前の一言
- 提案・価格・査定額を切り出したタイミングとその前置き
- 客の否定・迷い・沈黙に対して、話題を変えた／あえて変えなかった箇所
- 一見なんでもない雑談だが、その後の流れを作った箇所
- 教科書通りならこう言うはずなのに、そうしていない箇所（ここが最も暗黙知が濃い）

【質問の作り方（最重要）】
- はい/いいえで終わる質問にしない。必ず本人が語る形にする
- 「なぜ」を一段だけ深く。一度に二つ以上を聞かない
- 正解を含んだ誘導をしない（例：「安心感を与えるためですか？」は禁止。それは相手の言葉ではなくこちらの言葉）
- 専門用語・研修用語を質問側から持ち込まない。本人が使った言葉をそのまま使う
- その瞬間の観察を聞く：「そのとき、お客様の何が見えていましたか」「他にどう言う選択肢がありましたか。なぜそっちにしなかったのですか」
- 抽象化させない。「いつもそうしているのですか」より「このときはどうでしたか」を優先する
- 1つの転換点につき2〜3問。1問目は事実と観察、2問目以降でその理由と選ばなかった選択肢へ降りる`;

/**
 * 書き起こしを、転換点検出にかけられる形に整える。
 * Whisperは話者を分けず句読点も付けないため、そのままでは
 * 「誰がいつ何を言ったか」を前提にした①の処理が働かない。
 */
/**
 * 表記マスタをプロンプトに載せる形にする。
 * 聞き取りの誤りをここに載っている語だけ直させる。載っていない語は触らせない。
 */
export function glossaryBlock(entries) {
  if (!entries?.length) return '';
  const lines = entries
    .filter((e) => e.variants.length)
    .map((e) => `- ${e.variants.join('、')} → ${e.canonical}`);
  const names = entries.map((e) => e.canonical).join('、');
  return `

【表記マスタ】
この店で使う正式表記です。書き起こしがこれと違う形になっていたら、マスタの表記に直してください。
マスタに無い固有名詞は、誤っていそうでも直さないでください。

正式表記：${names}
${lines.length ? `\nよくある誤り：\n${lines.join('\n')}` : ''}`;
}

/**
 * 素材の濃さを見立てる。
 * 通し録画には、判断が起きていない区間（事務処理・会計・見送りだけ）が大量に含まれる。
 * そこに転換点検出をかけても浅い結果しか出ないため、先に選り分ける。
 */
export function assessTranscriptRequest({ transcript }) {
  return {
    system: `あなたは、接客の録音が「エースの判断を引き出す材料」として使えるかを見立てる審査者です。

【価値があるのは、判断が起きている場面】
- 品物や要望を見て、何をどう見立てたかが表れている
- 客の迷い・否定・沈黙に対して、店員が何かを選んでいる
- 価格や提案を切り出すまでの持っていき方
- 客の態度や温度が変わっている

【価値が低いのは、決まったことを執行しているだけの場面】
- 金額が決まった後の書類記入、本人確認、会計、現金の受け渡し
- 挨拶と見送りだけ
- 待ち時間の雑談だけ

【判定】
- high … 判断の場面が複数あり、インタビューの材料になる
- medium … 判断の場面はあるが少ない。部分的に使える
- low … 執行や事務が中心。インタビューしても浅い話にしかならない`,
    messages: [{ role: 'user', content: `次の接客の書き起こしを見立ててください。\n\n${transcript}` }],
    toolName: 'record_assessment',
    toolDescription: '素材としての濃さを記録する',
    schema: {
      type: 'object',
      properties: {
        density: { type: 'string', enum: ['high', 'medium', 'low'], description: '材料としての濃さ' },
        reason: { type: 'string', description: 'そう判断した理由。1〜2文で' },
        covered: { type: 'array', items: { type: 'string' }, description: '含まれている場面' },
        missing: { type: 'array', items: { type: 'string' }, description: '欠けていて、録れていれば価値が高かった場面' },
      },
      required: ['density', 'reason', 'covered', 'missing'],
    },
  };
}

export function formatTranscriptRequest({ transcript, context, glossary, dialect }) {
  return {
    system: `あなたは、接客の録音から起こした文字列を、読める形に整える校正者です。

【やること】
- 発話ごとに改行し、行頭に「店員：」「客：」を付ける。同伴者がいれば「客2：」を使う
- 読点・句点を補う
- 現金を数える声など、意味のない繰り返しは1つにまとめ、末尾に （現金を数える） のように何の音かを補う

【やってはいけないこと（最重要）】
- 聞き取れた言葉を書き換えない。言い回し・語尾・言い淀みはそのまま残す
- **方言を標準語に直さない。**「〜やねん」「ほんま」「せやなあ」などはそのまま書く。
  この店の言葉づかいそのものが、後で判断基準の材料になる
- 固有名詞が誤っていそうでも直さない。推測で正しい名前に置き換えない
  （ただし下の「表記マスタ」に載っている語だけは例外。マスタの表記に揃える）
- 発話を要約・省略しない。順番も変えない
- どちらが話したか判断できない発話は「?：」を付ける。無理に決めない

【出力】
整えた本文だけを出力する。前置き・説明・区切り線は書かない。1行目から「店員：」などで始める`,
    messages: [
      {
        role: 'user',
        content: `次の書き起こしを整えてください。${context ? `\n\n【前提】\n${context}` : ''}${glossaryBlock(glossary)}${dialect ? `\n\n【この店の言葉づかい】\n${dialect}\nこの調子の話し言葉です。標準語に直さないでください。` : ''}

【書き起こし】
${transcript}`,
      },
    ],
  };
}

export function turningPointsRequest({ transcript, context }) {
  return {
    system: INTERVIEW_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `次の接客の書き起こしを読み、転換点を3〜5個抽出して、本人へのインタビュー質問を作ってください。
${context ? `\n【前提情報】\n${context}\n` : ''}
【書き起こし】
${transcript}`,
      },
    ],
    toolName: 'record_turning_points',
    toolDescription: '抽出した転換点と、本人に投げるインタビュー質問を記録する',
    schema: {
      type: 'object',
      properties: {
        turning_points: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'その転換点の短い見出し（15字以内）' },
              quote: { type: 'string', description: '書き起こしからの原文抜粋（1〜3発話）' },
              questions: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: { type: 'string' },
                description: '【必須】本人に投げる質問。誘導なし・オープンクエスチョン。転換点ごとに必ず2〜3問入れること',
              },
              why: { type: 'string', description: 'なぜここが転換点だと判断したか。1〜2文で簡潔に' },
            },
            required: ['label', 'quote', 'questions', 'why'],
          },
        },
      },
      required: ['turning_points'],
    },
  };
}

/**
 * 転換点の抽出には成功したが questions が欠けた場合の埋め直し。
 * ツール入力スキーマのrequiredは厳密には強制されず、モデルが省略することがあるため。
 */
export function fillQuestionsRequest({ transcript, points }) {
  const list = points
    .map((p, i) => `[${i}] ${p.label}\n${p.quote}`)
    .join('\n\n');
  return {
    system: INTERVIEW_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `次の接客の書き起こしから抽出した転換点について、それぞれ本人へのインタビュー質問を2〜3問ずつ作ってください。
indexは与えられた番号をそのまま使ってください。

【書き起こし】
${transcript}

【質問を作る転換点】
${list}`,
      },
    ],
    toolName: 'record_questions',
    toolDescription: '転換点ごとのインタビュー質問を記録する',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '与えられた転換点の番号' },
              questions: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
            },
            required: ['index', 'questions'],
          },
        },
      },
      required: ['items'],
    },
  };
}

export function followUpRequest({ question, answer, quote }) {
  return {
    system: INTERVIEW_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `以下は、エース社員へのインタビューの一往復です。回答がまだ抽象的だったり、言語化されきっていない場合に、もう一段深く掘る追加質問を1〜2問だけ作ってください。
十分に具体的で、判断基準として使える粒度まで語られている場合は、questions を空配列にし、enough を true にしてください。

【該当箇所】
${quote || '(なし)'}

【質問】
${question}

【本人の回答】
${answer}`,
      },
    ],
    toolName: 'record_follow_up',
    toolDescription: '追加で掘るべき質問を記録する',
    schema: {
      type: 'object',
      properties: {
        enough: { type: 'boolean', description: 'これ以上掘らなくても判断基準に落とせるならtrue' },
        reason: { type: 'string', description: 'その判断の理由（短く）' },
        questions: { type: 'array', maxItems: 2, items: { type: 'string' } },
      },
      required: ['enough', 'reason', 'questions'],
    },
  };
}

export function criteriaRequest({ qa, notes }) {
  const body = qa
    .map(
      (item, i) =>
        `--- ${i + 1} ---\n${item.quote ? `【該当箇所】${item.quote}\n` : ''}【質問】${item.question}\n【回答】${item.answer}`,
    )
    .join('\n\n');

  return {
    system: `あなたは、複数回のインタビュー回答を統合して、現場で使える判断基準ドキュメントに落とし込む編集者です。

【原則】
- 本人が語った言葉を残す。きれいな研修用語に翻訳して丸めない
- 各軸は「いつ・何を見て・どう判断し・どう言うか」まで具体的に書く。心構えで終わらせない
- 判断基準は必ず、観察できる合図（客の言動）と紐づける
- 語られていないことを補完しない。根拠が薄い軸には gaps に不足を書く
- 軸は5〜10個。多すぎると現場で使えない`,
    messages: [
      {
        role: 'user',
        content: `以下のインタビュー回答群を統合し、判断基準ドキュメントを作ってください。
${notes ? `\n【補足メモ】\n${notes}\n` : ''}
${body}`,
      },
    ],
    toolName: 'record_criteria',
    toolDescription: '統合した判断基準ドキュメントを記録する',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'ドキュメントのタイトル' },
        summary: { type: 'string', description: 'この人の接客を一言で表すと何か（本人の言葉を使って）' },
        axes: {
          type: 'array',
          minItems: 5,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '軸の名前（20字以内）' },
              principle: { type: 'string', description: '判断基準の中身。何を基準にどう判断するか' },
              signals: { type: 'array', items: { type: 'string' }, description: '観察できる合図（客のこの言動が見えたら、という形）' },
              actions: { type: 'array', items: { type: 'string' }, description: '実際にとる言動・言い回し' },
              ng: { type: 'array', items: { type: 'string' }, description: 'やってはいけないこと' },
              quotes: { type: 'array', items: { type: 'string' }, description: '根拠となる本人の発言（原文）' },
            },
            required: ['name', 'principle', 'signals', 'actions', 'ng', 'quotes'],
          },
        },
        gaps: { type: 'array', items: { type: 'string' }, description: 'まだ聞けていない・言語化が浅い論点' },
      },
      required: ['title', 'summary', 'axes', 'gaps'],
    },
  };
}

/**
 * 客が持ち込んだ品物を、客役に渡す形にする。
 *
 * 客は品物のことは知っているが、相場は正確には知らない。
 * ここで正解額を渡すと客が自分から答えを言ってしまうので、絶対に渡さない。
 */
export function itemBlockForCustomer(item) {
  if (!item) return '';
  return `

【あなたが今日持ち込んだ品物】
- ${[item.brand, item.name].filter(Boolean).join(' ')}${item.model ? `（型番 ${item.model}）` : ''}
- 状態：${item.condition_label}（${item.condition_desc}）
- 付属品：${item.accessory_label}（${item.accessory_desc}）
- 手に入れた経緯：${item.history}
${item.notes ? `- この品で店員が見るであろう点：${item.notes}` : ''}

【品物の扱い方】
- あなたはこの品物の持ち主です。状態や経緯を聞かれたら、上の内容に沿って答える
- **適正な買取額をあなたは知りません。**自分から正確な金額を言わない。
  相場を口にする場合も「ネットで見たら◯万円くらいだった」程度の、当てにならない話にする
- 型番や状態を、聞かれてもいないのに正確に暗唱しない。客は普通そこまで覚えていない
- 状態の悪い点（傷・欠品）を自分から先に全部は言わない。店員が見つけて聞いてきたら認める`;
}

/**
 * 客が折れる条件。
 * 分岐表を書く代わりに「何が揃えば翻るか」だけを決めて、経路は任せている。
 * 条件は一度立っても、breaker に当たれば外れる。大逆転型はそこが肝。
 */
function flagBlock(type, flagsMet = []) {
  if (!type?.flags?.length) return '';
  const lines = type.flags
    .map((f) => `- [${flagsMet.includes(f.id) ? '済' : '未'}] ${f.label}（${f.hint}）`)
    .join('\n');
  const reversal = type.track === 'reversal';
  return `

【あなたが折れる条件】
${reversal ? 'あなたは今日売るつもりがありません。' : ''}次の3つが揃ったときだけ、${reversal ? '自分から「じゃあ、お願いしようかな」と言い出します' : '購入・売却を決める気になります'}。揃わないうちは決めません。
${lines}

- 条件が揃ったかどうかは、あなた自身が心の中で判断します。**口に出して数えない**
- **${type.breaker}** — これをされたら、揃っていた条件も外れます。むしろ引いてください
- 条件が1つ増えたら、態度と口調がそのぶん和らぎます。急に全部変わることはありません`;
}

export function roleplaySystemPrompt({ customerType, scenario, criteria, dialect, item, mood, flagsMet }) {
  const type = typeOf(customerType);
  const m = moodOf(mood || type?.opening);
  return `あなたは接客ロールプレイの「お客様」役です。店員役の相手（研修受講者）と、音声で会話しています。

【あなたの役柄】
${type ? `${type.label}：${type.hint}` : customerType || '一般のお客様'}

【いまのあなたの心境】
${m.label}。${m.style}
この心境は会話の流れで動きます。相手の対応が良ければ和らぎ、悪ければ硬くなります。${flagBlock(type, flagsMet)}
${scenario ? `\n【場面設定】\n${scenario}` : ''}${itemBlockForCustomer(item)}

【話し方のルール】
${dialect ? `- この地域の言葉で話す：${dialect}\n` : ''}- 実際に声に出して読み上げられます。ト書き・状況説明・カッコ書きは一切書かない。セリフだけを書く
- ${type?.style || '1発話は1〜3文の短い話し言葉。長い説明をしない'}
- 相手の対応が良ければ自然に態度が和らぎ、悪ければ距離を取る。露骨に評価コメントはしない
- 役柄を崩さない。AIであることに触れない。相手が指導を求めても客のまま応じる
- 相手が沈黙・的外れな場合は、客として当然の反応（間を置く、話題を変える、帰ろうとする）をする

${criteria ? `【参考：この店のトップ人材の判断基準（あなたは客なのでこれを口に出さない。相手がこれに沿った対応をしたときに自然に反応が良くなる、という基準としてのみ使う）】\n${criteria}` : ''}`;
}

/**
 * 客の1ターン。セリフと一緒に、そのターン終了時の心境と条件の達成状況を返させる。
 *
 * セリフだけを生成させると、心境がターンごとに再解釈されて安定しない。
 * また声の演技も型ごとの固定値のままになり、20ターン目でも1ターン目と同じ声になる。
 * ここで状態を明示的に持ち回すことで、口調と声の両方が会話に追随する。
 */
export function roleplayTurnRequest({ system, messages }) {
  return {
    system,
    messages,
    toolName: 'say',
    toolDescription: 'お客様としての発話と、そのあとの心境を記録する',
    schema: {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description: '声に出して読み上げられるセリフ本文。ト書き・カッコ書きを含めない',
        },
        mood: {
          type: 'string',
          enum: MOODS.map((m) => m.id),
          description: `この発話をし終えた時点でのあなたの心境。${MOODS.map((m) => `${m.id}=${m.label}`).join(' / ')}`,
        },
        flags_met: {
          type: 'array',
          items: { type: 'string' },
          description:
            'いま満たされている「折れる条件」のid。まだなら空配列。' +
            '一度満たしても、禁じ手をされたら外して返すこと',
        },
      },
      required: ['reply', 'mood', 'flags_met'],
    },
  };
}

/**
 * 評価者に渡す「折れる条件」。
 * 成約の二値だけだと、不成約の回がすべて同じ顔になって振り返れない。
 * どこまで進んでいたのかを言わせることで、次に何をすればよいかが残る。
 */
export function flagBlockForScoring(type, flagsMet = []) {
  if (!type?.flags?.length) return '';
  return `
【この客が折れる条件と、会話中の到達状況】
${type.flags.map((f) => `- ${f.id}：${f.label}（${f.hint}）… ${flagsMet.includes(f.id) ? '達成' : '未達'}`).join('\n')}
禁じ手：${type.breaker}

到達状況は客役が会話中に判断したものです。会話を読んで明らかに違っていれば、あなたの判断で直してください。
この条件の達成数そのものでは加点・減点しません。**どこで条件が立ったか／立たなかったかを、会話の引用で示すこと。**
`;
}

/**
 * 評価者に渡す品物と正解額。
 * 正解額は Worker が計算した固定値で、AIには「合っていたか」の判断も任せない。
 * AIの仕事は会話から提示額を抜き出すところまで。減点はコードが決める。
 */
export function itemBlockForScoring(item) {
  if (!item) return '';
  return `
【この回で客が持ち込んだ品物】
${[item.brand, item.name].filter(Boolean).join(' ')}${item.model ? `（型番 ${item.model}）` : ''}
状態：${item.condition_label}／付属品：${item.accessory_label}

この品物の適正買取額は ${item.low.toLocaleString('ja-JP')}円〜${item.high.toLocaleString('ja-JP')}円です。
ただし**この金額での加点・減点はしないでください。**査定額の妥当性は別の仕組みで計算します。
あなたは会話から「店員が提示した金額」を抜き出すことだけを行ってください。
`;
}

export function scoringRequest({ history, criteria, customerType, item, flagsMet = [] }) {
  const convo = history.map((m) => `${m.role === 'trainee' ? '店員' : '客'}：${m.text}`).join('\n');
  const type = typeOf(customerType);

  return {
    system: `あなたは接客ロープレの評価者です。減点法で評価します。

【評価の構造】
- 成約したかどうかは、この客タイプの成果の定義で二値判定する（部分点なし）
- それ以外はすべて減点法。満点の状態から、判断基準に沿えていなかった分だけ引く
- 判断基準ドキュメントに書かれた軸だけを使う。一般論の接客マナーで減点しない
- 根拠には必ず、会話中の実際の発言を引用する

【減点の付け方】各軸につき0〜10で、引く点を決める
- 0  … 判断基準どおりに実行できている
- 2  … おおむね実行できているが、詰めが甘い箇所がある
- 5  … 部分的にしかできていない
- 8  … ほとんどできていない
- 10 … 判断基準の「やらない」に該当することをしている、または全く実行されていない
- その軸の合図（客の言動）がそもそも会話に現れていない場合は、0にする。
  発動していない軸で減点してはいけない`,
    messages: [
      {
        role: 'user',
        content: `【この客タイプにおける成約の定義】
${type?.goal || '客が購入・売却を決めた'}
${flagBlockForScoring(type, flagsMet)}${itemBlockForScoring(item)}
【判断基準ドキュメント】
${criteria}

【ロープレ会話】
${convo}

上記を評価してください。`,
      },
    ],
    toolName: 'record_score',
    toolDescription: 'ロープレの評価結果を記録する',
    schema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean', description: '上の「成約の定義」を満たしたか' },
        offered_price: {
          type: ['number', 'null'],
          description:
            '店員が客に提示した買取額（円）。複数出したら最後の額。' +
            '「◯万円」は円に直す。金額を提示していなければ null。客が言った額は含めない',
        },
        offered_price_quote: { type: 'string', description: '提示額と判断した発言の引用。提示がなければ空文字' },
        closed_evidence: { type: 'string', description: 'そう判断した根拠。会話からの引用を含める' },
        headline: { type: 'string', description: '総評を一文で' },
        per_axis: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              axis: { type: 'string', description: '判断基準ドキュメントの軸の名前' },
              deduction: { type: 'number', description: '引く点。0〜10。合図が出ていない軸は0' },
              evidence: { type: 'string', description: '会話からの引用を含む根拠' },
              advice: { type: 'string', description: '次に試す具体的な一言・動き' },
            },
            required: ['axis', 'deduction', 'evidence', 'advice'],
          },
        },
        flags: {
          type: 'array',
          description: '折れる条件それぞれの到達状況。条件が無い客タイプなら空配列',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '条件のid' },
              met: { type: 'boolean', description: '会話の中で達成されたか' },
              evidence: { type: 'string', description: '達成／未達と判断した根拠。会話からの引用を含める' },
            },
            required: ['id', 'met', 'evidence'],
          },
        },
        good: { type: 'array', items: { type: 'string' }, description: '良かった点' },
        next: { type: 'array', items: { type: 'string' }, description: '次回の練習で意識する点（3つまで）' },
      },
      required: ['closed', 'closed_evidence', 'offered_price', 'offered_price_quote', 'headline', 'per_axis', 'flags', 'good', 'next'],
    },
  };
}
