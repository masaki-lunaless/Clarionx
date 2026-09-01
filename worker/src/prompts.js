// Clarionの中核。①③④はコモディティ、②のファシリテーション設計だけが差別化要素、
// という整理に従い、質問生成のプロンプトを最も厚く書いてある。

// voice: 読み上げの演技指示（OpenAI TTSのinstructions）、intensity: 感情の強さ（Aivisのemotional_intensity）
export const CUSTOMER_TYPES = [
  { id: 'undecided', label: '迷い客', hint: '欲しい気持ちはあるが決め手がなく、質問が多い。急かされると引く。',
    voice: '日本語で、迷いながら話す客。語尾を伸ばし気味に、考え込む間を取って', intensity: 1 },
  { id: 'price', label: '価格重視', hint: '真っ先に値段を聞く。他店比較を口にする。値引きを引き出そうとする。',
    voice: '日本語で、値段の話になると少し前のめりになる客。早口で、探るような調子で', intensity: 1.1 },
  { id: 'silent', label: '寡黙', hint: '相槌は打つが自分からは話さない。短い返事しか返さない。見ているだけ、と言いがち。',
    voice: '日本語で、口数の少ない客。抑揚を抑えて、そっけなく短く', intensity: 0.6 },
  { id: 'expert', label: '知識豊富', hint: '下調べ済み。スペックや相場を把握しており、店員を試す質問をする。',
    voice: '日本語で、知識のある客。落ち着いた低めの調子で、試すように', intensity: 0.9 },
  { id: 'complaint', label: '不満・クレーム気味', hint: '過去の対応や査定額に納得がいっていない。最初は語気が強い。',
    voice: '日本語で、納得していない客。語気を強めて、苛立ちをにじませて', intensity: 1.5 },
  { id: 'kaitori', label: '買取相談', hint: '売るつもりはあるが金額次第。他店の査定額を持っている。思い入れのある品。',
    voice: '日本語で、手放すか迷っている客。少し名残惜しそうに、慎重に', intensity: 1.1 },
  { id: 'accompanied', label: '同伴者あり', hint: '家族や友人と一緒。決定権が本人だけにない。同伴者の一言で気持ちが動く。',
    voice: '日本語で、連れの様子をうかがいながら話す客。会話の相手が二人いるような調子で', intensity: 1 },
];

/** 客タイプごとの読み上げ演技指示。プロバイダ差はaudio.js側で吸収する。 */
export function voiceDirection(customerType) {
  const type = CUSTOMER_TYPES.find((t) => t.id === customerType);
  return {
    instructions: type?.voice || '日本語で、店頭にいる一般のお客様として自然に',
    intensity: type?.intensity ?? 1,
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

export function roleplaySystemPrompt({ customerType, scenario, criteria }) {
  const type = CUSTOMER_TYPES.find((t) => t.id === customerType);
  return `あなたは接客ロールプレイの「お客様」役です。店員役の相手（研修受講者）と、音声で会話しています。

【あなたの役柄】
${type ? `${type.label}：${type.hint}` : customerType || '一般のお客様'}
${scenario ? `\n【場面設定】\n${scenario}` : ''}

【話し方のルール】
- 実際に声に出して読み上げられます。ト書き・状況説明・カッコ書きは一切書かない。セリフだけを書く
- 1発話は1〜3文の短い話し言葉。長い説明をしない
- 相手の対応が良ければ自然に態度が和らぎ、悪ければ距離を取る。露骨に評価コメントはしない
- 役柄を崩さない。AIであることに触れない。相手が指導を求めても客のまま応じる
- 相手が沈黙・的外れな場合は、客として当然の反応（間を置く、話題を変える、帰ろうとする）をする

${criteria ? `【参考：この店のトップ人材の判断基準（あなたは客なのでこれを口に出さない。相手がこれに沿った対応をしたときに自然に反応が良くなる、という基準としてのみ使う）】\n${criteria}` : ''}`;
}

export function scoringRequest({ history, criteria }) {
  const convo = history
    .map((m) => `${m.role === 'trainee' ? '店員' : '客'}：${m.text}`)
    .join('\n');

  return {
    system: `あなたは接客ロープレの評価者です。トップ人材の判断基準ドキュメントを唯一の評価軸として採点します。
一般論の接客マナーで加点減点しないでください。ドキュメントに書かれた軸だけを使います。
根拠には必ず、会話中の実際の発言を引用してください。`,
    messages: [
      {
        role: 'user',
        content: `【判断基準ドキュメント】\n${criteria}\n\n【ロープレ会話】\n${convo}\n\n上記を採点してください。`,
      },
    ],
    toolName: 'record_score',
    toolDescription: 'ロープレの採点結果を記録する',
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number', description: '総合点（100点満点）' },
        headline: { type: 'string', description: '総評を一文で' },
        per_axis: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              axis: { type: 'string' },
              score: { type: 'number', description: '5点満点' },
              evidence: { type: 'string', description: '会話からの引用を含む根拠' },
              advice: { type: 'string', description: '次に試す具体的な一言・動き' },
            },
            required: ['axis', 'score', 'evidence', 'advice'],
          },
        },
        good: { type: 'array', items: { type: 'string' }, description: '良かった点' },
        next: { type: 'array', items: { type: 'string' }, description: '次回の練習で意識する点（3つまで）' },
      },
      required: ['total', 'headline', 'per_axis', 'good', 'next'],
    },
  };
}
