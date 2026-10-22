/**
 * ぶんしんプレゼンス - 設定ファイル
 * GAS の URL やバージョンはここだけ変更すればOKです。
 */
window.APP_CONFIG = {
  // アプリ名・バージョン（画面右下に表示）
  APP_NAME: 'ぶんしんプレゼンス',
  VERSION: 'v1.0.0',

  // GAS ウェブアプリのURL（デプロイ後に発行される /exec のURL）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbxFZ-rEfbstBGCbtrr-2LVPb5ZYxDzWZzxmUyKIKbkJCNLAx4dKquH3s3nmu1SWNv-V/exec',

  // localStorage / sessionStorage のキー接頭辞
  STORAGE_PREFIX: 'bunshin',

  // API タイムアウト（ミリ秒）
  API_TIMEOUT_MS: 30000,
  AI_TIMEOUT_MS: 60000,

  // 音声合成
  //  'gemini'  : Gemini TTS（GAS経由）。失敗時はブラウザ音声に自動切替
  //  'browser' : ブラウザ内蔵の音声合成（Web Speech API）
  TTS_ENGINE: 'gemini',
  DEFAULT_VOICE: 'Kore',
  TTS_MAX_CHARS: 400,
  BROWSER_TTS_RATE: 1.05,
  BROWSER_TTS_PITCH: 1.15,

  // Gemini TTS の声の候補
  GEMINI_VOICES: [
    { id: 'Kore',    label: 'Kore（落ち着いた声）' },
    { id: 'Aoede',   label: 'Aoede（さわやかな声）' },
    { id: 'Leda',    label: 'Leda（若々しい声）' },
    { id: 'Zephyr',  label: 'Zephyr（明るい声）' },
    { id: 'Puck',    label: 'Puck（元気な声）' },
    { id: 'Charon',  label: 'Charon（低めの声）' },
    { id: 'Fenrir',  label: 'Fenrir（力強い声）' },
    { id: 'Orus',    label: 'Orus（しっかりした声）' }
  ],

  // クイックリアクション（OriHime風ボタン）
  //  gesture: nod / shake / clap / tsukkomi / wave / look / bow / think / joy
  //  say    : 押したときに話す言葉（空なら動きだけ）
  REACTIONS: [
    { label: 'はい',         emoji: '🙆', say: 'はい！',               gesture: 'nod' },
    { label: 'いいえ',       emoji: '🙅', say: 'いいえ。',             gesture: 'shake' },
    { label: '拍手',         emoji: '👏', say: 'パチパチパチ！',        gesture: 'clap' },
    { label: 'なんでやねん', emoji: '🤚', say: 'なんでやねん！',        gesture: 'tsukkomi' },
    { label: '手を振る',     emoji: '👋', say: 'やっほー！',            gesture: 'wave' },
    { label: '見回す',       emoji: '👀', say: '',                     gesture: 'look' },
    { label: 'ありがとう',   emoji: '🙇', say: 'ありがとうございます！', gesture: 'bow' },
    { label: 'うーん',       emoji: '🤔', say: 'うーん…',              gesture: 'think' },
    { label: 'やったー',     emoji: '🙌', say: 'やったー！',            gesture: 'joy' }
  ],

  /* ---------------------------------------------------------
     背景動画（Google Earth Studio）
     リポジトリの videos/ フォルダに置いた MP4 を GitHub Pages から直接配信します。
       ・1ファイル 100MB 未満（GitHubの上限。50MB未満を推奨）
       ・Git LFS は使わない（GitHub Pages では LFS のファイルを配信できません）
       ・ファイル名は半角英数字・ハイフンのみ（例：tokyo-tower.mp4）
     --------------------------------------------------------- */
  VIDEO_BASE_PATH: 'videos/',

  // ロケーションの読み込み元
  //  'config' : 下の LOCATIONS だけを使う（おすすめ。GASへの問い合わせなし）
  //  'sheet'  : スプレッドシートの Locations シートを使う
  //  'both'   : LOCATIONS の後ろにシートの分を追加
  LOCATION_SOURCE: 'config',

  // この幅以下の画面、または通信量節約モードでは videoMobile（軽量版）を使う
  MOBILE_MAX_WIDTH: 768,

  // video / videoMobile / poster はファイル名だけ書けば VIDEO_BASE_PATH が前に付きます
  // （https:// から始まるURLや / から始まるパスはそのまま使います）
  LOCATIONS: [
    { id: 'sky', name: 'そら（背景なし）', description: '背景動画なしの空のステージです。', video: '' }

    // ▼ 動画を置いたらコメントを外して使います
    // ,{
    //   id: 'tokyo-tower',
    //   name: '東京タワー上空',
    //   description: '東京タワーの周りを一周する空撮です。正面には増上寺、奥には東京湾が見えます。',
    //   video: 'tokyo-tower.mp4',        // PC用（1920x1080 目安）
    //   videoMobile: 'tokyo-tower-sp.mp4', // スマホ用（1280x720 目安・省略可）
    //   poster: 'tokyo-tower.jpg'        // 読み込み中に表示する画像（省略可）
    // }
  ]
};
