# Clarion

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
| 音声出力 | Aivis Cloud API ／ OpenAI TTS（差し替え可能） | 客のセリフを読み上げ |

ロープレの1ターンは `録音 → Worker → Whisper → Claude → TTS → {transcript, replyText, audioUrl}` を
1リクエストで返す。直列処理なので1ターン数秒。リアルタイム通話ではなく練習なので許容範囲、という判断。
`audioUrl` はdata URIで返る（フロント側でBlob URLに変換して再生）。

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
npx wrangler secret put AIVIS_API_KEY        # 音声合成にAivisを使う場合のみ（既定はopenaiなので不要）
npx wrangler secret put ACCESS_TOKENS   # 例: clientA:長いランダム文字列,clientB:別の文字列
npx wrangler deploy
```

`wrangler.jsonc` の `ALLOWED_ORIGINS` は、フロントを配信するGitHub PagesのURL（`https://<ユーザー名>.github.io`）に絞ってある。
オリジンが変わったらここを直して再デプロイする。
音声合成の選び方は次節。

ローカル開発は `cp .dev.vars.example .dev.vars` して値を埋め、`npm run dev`。
外部APIを叩かない疎通テストは `npm test`。

### 2. フロントを公開

リポジトリの Settings → Pages で、ブランチ `main` / フォルダ `/docs` を選ぶだけ。ビルド工程はない。

### 3. 端末側の設定

公開したページを開き、**設定**タブで Worker URL とアクセストークンを入れて「接続テスト」。
トークンは端末のlocalStorageにのみ保存される。iPad/iPhoneのSafariでの利用を想定。

## 音声合成（TTS）の差し替え

当初はにじボイスAPIを使っていたが、**2026年2月4日にサービス終了**したため差し替えた。
同じことが起きても1ファイルで済むよう、`worker/src/audio.js` の `PROVIDERS` にプロバイダを分離してある。

| プロバイダ | 設定 | 性格 |
| --- | --- | --- |
| `openai`（既定） | `OPENAI_API_KEY`（Whisperと共用） | 追加の契約が要らず、これだけで鳴る。`instructions` で客の演技を指示できる。日本語の自然さは国産勢に一歩劣る |
| `aivis` | `AIVIS_API_KEY` と `AIVIS_MODEL_UUID` | 日本語ネイティブ。感情表現あり、¥440/万文字。ACMLライセンスのモデルはクレジット表記不要 |
| `none` | — | 読み上げを止める。フロントは端末の `speechSynthesis` で代替する |

既定は `openai`。Whisper用に必ず要る `OPENAI_API_KEY` だけで鳴るので、音声のために別の契約をしなくてよい。
日本語の読み上げの質を上げたくなった時点で `TTS_PROVIDER` を `aivis` に変える。失敗したら音声なしで会話だけ続く。
客タイプごとの読み上げの演技指示は `worker/src/prompts.js` の `CUSTOMER_TYPES`（`voice` と `intensity`）にある。
不満客なら語気を強める、寡黙な客なら抑揚を抑える、といった調整はここ。

別のプロバイダを足すときは `PROVIDERS` に `{ enabled, voices, synthesize }` を持つエントリを1つ追加するだけでよい。

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
- **TTSベンダーへの依存**：にじボイスの終了で一度作り直している。特定の1社に直結させないこと。
  Aivisのモデルを使う場合、モデルごとのライセンス（ACML以外を選ぶとクレジット表記が要る場合がある）を確認する。
- **データの置き場所**：現状すべて端末のlocalStorage。顧客ごとにデータを分ける／判断基準を隠す段階になったら、
  Worker側にKVかD1を足してサーバ保存へ移す。認証はすでにクライアント別トークンで入っている。
- **コスト**：判断基準の統合と採点は精度優先で Opus、ロープレの1ターン生成はレイテンシ優先で Sonnet
  （`worker/src/llm.js` の `MODELS`）。音声合成は Aivis が¥440/万文字（月額¥1,980の無制限プランもあり）。

## プロンプトを直す場所

`worker/src/prompts.js` に集約してある。特に `INTERVIEW_SYSTEM`（誘導しない・一度に二つ聞かない・
専門用語を持ち込まない・抽象化させない）が、このツールの価値そのもの。現場で効かない質問が出たら、まずここを直す。
