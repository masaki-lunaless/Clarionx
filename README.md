# Clarion

接客のトップ人材の暗黙知を、本人の言葉のまま引き出して判断基準に落とし、AIロープレで再現する。

社内向けツール。「録る → AIが『なぜ』を聞く → 言語化ドキュメント化 → AIロープレ教材」の4段階のうち、
**②のファシリテーション（何を、どう聞くか）が唯一の差別化要素**という整理に基づき、質問生成のプロンプトを中核に据えている。

```
docs/     フロントエンド（GitHub Pages にそのまま置ける静的ページ。ビルド不要）
worker/   バックエンド（Cloudflare Worker。APIキーの隠蔽と STT→LLM→TTS の集約）
tools/    監視カメラ映像から音声を抽出する一括変換スクリプト
```

## 全体構成

| 層 | 使うもの | 役割 |
| --- | --- | --- |
| フロント | GitHub Pages（素のHTML/JS） | 3タブUI。データは端末のlocalStorageに保存 |
| バック | Cloudflare Worker | APIキー隠蔽、クライアント別トークン認証、1リクエストへの集約 |
| 言語 | Claude API | 転換点抽出・質問生成・判断基準統合・客のセリフ生成・採点 |
| 音声入力 | Whisper API（OpenAI） | MediaRecorderで録った音声をテキスト化 |
| 音声出力 | にじボイスAPI | 客のセリフを読み上げ |

ロープレの1ターンは `録音 → Worker → Whisper → Claude → にじボイス → {transcript, replyText, audioUrl}` を
1リクエストで返す。直列処理なので1ターン数秒。リアルタイム通話ではなく練習なので許容範囲、という判断。

## 使い方（3つのタブ）

1. **「なぜ」を聞く** — 接客の書き起こしを貼る（音声ファイルからの書き起こしも可）と、AIが転換点を3〜5個検出し、
   本人へのインタビュー質問を作る。回答を書き込み、浅ければ「もう一段掘る」で追加質問を生成する。
2. **判断基準にする** — 回答済みのQ&Aを選んで統合し、5〜10軸の判断基準ドキュメント（Markdown）にする。編集・保存可。
3. **練習する** — 客タイプと場面を選んでAI客と会話。話しかけると客が声で返す。終了すると、
   ②のドキュメントを唯一の評価軸として採点する（一般的な接客マナーでは加点減点しない）。

## セットアップ

### 1. Worker をデプロイ

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put NIJIVOICE_API_KEY
npx wrangler secret put ACCESS_TOKENS   # 例: clientA:長いランダム文字列,clientB:別の文字列
npx wrangler deploy
```

デプロイ後、`wrangler.jsonc` の `ALLOWED_ORIGINS` をGitHub PagesのURL（例 `https://xxxx.github.io`）に絞る。
`NIJIVOICE_VOICE_ACTOR_ID` に既定の声を入れておくと、フロントで選ばなくても読み上げが動く。

ローカル開発は `cp .dev.vars.example .dev.vars` して値を埋め、`npm run dev`。
外部APIを叩かない疎通テストは `npm test`。

### 2. フロントを公開

リポジトリの Settings → Pages で、ブランチ `main` / フォルダ `/docs` を選ぶだけ。ビルド工程はない。

### 3. 端末側の設定

公開したページを開き、**設定**タブで Worker URL とアクセストークンを入れて「接続テスト」。
トークンは端末のlocalStorageにのみ保存される。iPad/iPhoneのSafariでの利用を想定。

## 音声の準備（監視カメラ映像から）

```bash
./tools/extract-audio.sh ./recordings ./audio
```

映像は不要なので音声だけ抜く。16kHz・モノラルWAVなら70時間でも8GB程度。
Whisper APIの上限が1ファイル25MBなので、既定で15分ごとに分割する（`SEGMENT_SECONDS` で変更可）。

監視カメラのマイクは天井付け・無指向性で距離があるため、専用レコーダーより精度は落ちる。
書き起こしは目視で直してから①に流すこと。

## 運用上の注意

- **目的外利用の確認**：元々「防犯・監視」目的で録画された音声をAI研修データに転用する形になる。
  録画を保有する側での確認が済むまで、本番データを流さないこと。
- **にじボイスのクレジット表記**：商用利用時は「にじボイス」または「NIJI Voice」の表記が利用規約で必須。
  製品化する段階でフッターに入れる。
- **データの置き場所**：現状すべて端末のlocalStorage。顧客ごとにデータを分ける／判断基準を隠す段階になったら、
  Worker側にKVかD1を足してサーバ保存へ移す。認証はすでにクライアント別トークンで入っている。
- **コスト**：判断基準の統合と採点は精度優先で Opus、ロープレの1ターン生成はレイテンシ優先で Sonnet
  （`worker/src/llm.js` の `MODELS`）。にじボイスは無料枠が月1,000文字。

## プロンプトを直す場所

`worker/src/prompts.js` に集約してある。特に `INTERVIEW_SYSTEM`（誘導しない・一度に二つ聞かない・
専門用語を持ち込まない・抽象化させない）が、このツールの価値そのもの。現場で効かない質問が出たら、まずここを直す。
