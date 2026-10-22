/**
 * ぶんしんプレゼンス - Google Apps Script バックエンド (Code.gs)
 *
 * ■ 初回セットアップ
 *  1. スプレッドシートを作成 →「拡張機能 > Apps Script」でこのコードを貼り付け
 *  2. エディタで setup() を実行（シートとヘッダーを自動作成）
 *  3. プロジェクトの設定 > スクリプト プロパティ に以下を登録
 *       GEMINI_API_KEY      : (必須) Gemini API キー
 *       GEMINI_TEXT_MODEL   : (任意) 既定 gemini-2.5-flash
 *       GEMINI_TTS_MODEL    : (任意) 既定 gemini-2.5-flash-preview-tts
 *       AUDIO_FOLDER_ID     : (任意) 設定すると生成音声をWAVでDriveに保存（保存のみ。再生はブラウザへ直接返す）
 *       APP_URL             : (任意) メール本文に載せるアプリURL
 *       SHOW_TEMP_PASSWORD  : (任意) true で仮パスワードを画面にも表示（テスト用）
 *       ENABLE_LOG          : (任意) false で会話ログ保存を停止
 *       SPREADSHEET_ID      : (任意) スタンドアロンGASで使う場合のみ
 *  4. デプロイ > 新しいデプロイ > ウェブアプリ
 *       実行ユーザー：自分 / アクセスできるユーザー：全員
 *     → 発行された /exec のURLを config.js の GAS_URL に設定
 *
 * ■ スプレッドシートの推奨カラム構造（1行目がヘッダー）
 *  [Users]     email | nickname | passwordHash | salt | mustChange | failCount | lockedUntil | status | createdAt | lastLogin
 *              ・passwordHash : salt付き SHA-256 をストレッチングしたもの（平文は保存しません）
 *              ・mustChange   : TRUE の間は初回パスワード変更画面へ誘導
 *              ・status       : active / suspended（suspended でログイン不可）
 *  [Sessions]  token | email | createdAt | expiresAt
 *              ・token は SHA-256 ハッシュで保存（ブラウザ側だけが元の値を持つ）
 *  [Locations] id | name | description | video | videoMobile | poster | active | sortOrder
 *              ・config.js の LOCATION_SOURCE が 'sheet' / 'both' のときだけ使用
 *              ・Google Earth Studio の動画（MP4）は GitHub リポジトリの videos/ に置き、
 *                video / videoMobile / poster にはファイル名（例：tokyo-tower.mp4）を記入
 *                → フロント側で VIDEO_BASE_PATH（videos/）を付けて GitHub Pages から再生
 *              ・Google Drive の共有リンクは大きいファイルで警告画面が挟まり再生できないため非対応
 *  [Logs]      timestamp | email | type | text | gesture
 */

const CFG = {
  APP_NAME: 'ぶんしんプレゼンス',
  SESSION_HOURS: 24 * 14,
  MAX_FAIL: 5,
  LOCK_MINUTES: 15,
  HASH_ROUNDS: 300,
  CHAT_MAX_CHARS: 1000,
  TTS_MAX_CHARS: 500,
  RESET_INTERVAL_SEC: 60,
  DEFAULT_TEXT_MODEL: 'gemini-2.5-flash',
  DEFAULT_TTS_MODEL: 'gemini-2.5-flash-preview-tts'
};

const SHEETS = {
  Users:     ['email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'failCount', 'lockedUntil', 'status', 'createdAt', 'lastLogin'],
  Sessions:  ['token', 'email', 'createdAt', 'expiresAt'],
  Locations: ['id', 'name', 'description', 'video', 'videoMobile', 'poster', 'active', 'sortOrder'],
  Logs:      ['timestamp', 'email', 'type', 'text', 'gesture']
};

const GESTURES = ['nod', 'shake', 'look', 'wave', 'clap', 'tsukkomi', 'bow', 'think', 'joy', 'talk'];

const ROUTES = {
  register:       { fn: register_,       lock: true },
  login:          { fn: login_,          lock: true },
  changePassword: { fn: changePassword_, lock: true },
  resetPassword:  { fn: resetPassword_,  lock: true },
  logout:         { fn: logout_,         lock: true },
  verify:         { fn: verify_ },
  locations:      { fn: locations_ },
  chat:           { fn: chat_ },
  tts:            { fn: tts_ }
};

/* =========================================================
   エントリポイント
   ========================================================= */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'ping') return json_({ ok: true, app: CFG.APP_NAME, time: new Date().toISOString() });
  return json_({ ok: true, app: CFG.APP_NAME, message: 'API is running. Use POST.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  const route = ROUTES[body.action];
  if (!route) return json_({ ok: false, error: '不明な操作です: ' + body.action });

  const lock = route.lock ? LockService.getScriptLock() : null;
  try {
    if (lock && !lock.tryLock(15000)) throw new Error('混み合っています。少し待ってからお試しください');
    return json_(route.fn(body));
  } catch (err) {
    console.error(body.action, err);
    return json_({ ok: false, error: String(err && err.message || err), code: err && err.code || undefined });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

// GAS の ContentService は JSON を返すとき自動的に CORS 許可されます
// （フロントは Content-Type: text/plain で POST してプリフライトを回避）
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
   認証
   ========================================================= */
function register_(b) {
  const email = normEmail_(b.email);
  const nickname = String(b.nickname || '').trim().slice(0, 30);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  if (!nickname) throw new Error('ニックネームを入力してください');
  if (findUser_(email)) throw new Error('このメールアドレスは既に登録されています');

  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  const t = table_('Users');
  const data = {
    email: email,
    nickname: safe_(nickname),
    passwordHash: hash_(temp, salt),
    salt: salt,
    mustChange: true,
    failCount: 0,
    lockedUntil: '',
    status: 'active',
    createdAt: new Date(),
    lastLogin: ''
  };
  t.sh.appendRow(t.header.map(h => (h in data ? data[h] : '')));

  const sent = sendMail_(email,
    '【' + CFG.APP_NAME + '】仮パスワードのお知らせ',
    nickname + ' さん\n\n' + CFG.APP_NAME + ' へのご登録ありがとうございます。\n\n' +
    '仮パスワード：' + temp + '\n\n' +
    '初回ログイン後、新しいパスワードの設定をお願いします。\n' + appUrlLine_());

  const show = !sent || prop_('SHOW_TEMP_PASSWORD') === 'true';
  return {
    ok: true,
    message: sent ? '仮パスワードをメールで送りました。メールを確認してログインしてください。'
                  : 'メールを送れなかったため、仮パスワードを画面に表示します。',
    tempPassword: show ? temp : undefined
  };
}

function login_(b) {
  const u = findUser_(b.email);
  const pw = String(b.password || '');
  if (!u) throw new Error('メールアドレスまたはパスワードが違います');
  if (String(u.get('status')) === 'suspended') throw new Error('このアカウントは利用停止中です');

  const lockedUntil = u.get('lockedUntil');
  if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000);
    throw new Error('ログイン失敗が続いたためロック中です。' + mins + '分後にお試しください');
  }

  if (hash_(pw, u.get('salt')) !== u.get('passwordHash')) {
    const fc = Number(u.get('failCount') || 0) + 1;
    if (fc >= CFG.MAX_FAIL) {
      setFields_(u, { failCount: 0, lockedUntil: new Date(Date.now() + CFG.LOCK_MINUTES * 60000) });
      throw new Error('ログインに' + CFG.MAX_FAIL + '回失敗したため、' + CFG.LOCK_MINUTES + '分間ロックしました');
    }
    setFields_(u, { failCount: fc });
    throw new Error('メールアドレスまたはパスワードが違います（あと' + (CFG.MAX_FAIL - fc) + '回でロック）');
  }

  setFields_(u, { failCount: 0, lockedUntil: '', lastLogin: new Date() });
  cleanupSessions_(u.get('email'));
  const token = createSession_(u.get('email'));
  return { ok: true, token: token, user: publicUser_(u) };
}

function changePassword_(b) {
  const u = requireSession_(b.token);
  const cur = String(b.currentPassword || '');
  const nw = String(b.newPassword || '');
  if (hash_(cur, u.get('salt')) !== u.get('passwordHash')) throw new Error('いまのパスワードが違います');
  if (nw.length < 8 || !/[A-Za-z]/.test(nw) || !/[0-9]/.test(nw)) throw new Error('新しいパスワードは英字と数字を含む8文字以上にしてください');
  if (nw === cur) throw new Error('いまと違うパスワードにしてください');

  const salt = Utilities.getUuid();
  setFields_(u, { passwordHash: hash_(nw, salt), salt: salt, mustChange: false, failCount: 0, lockedUntil: '' });
  return { ok: true, message: 'パスワードを変更しました' };
}

function resetPassword_(b) {
  const email = normEmail_(b.email);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');

  // 連打防止
  const cache = CacheService.getScriptCache();
  const ck = 'reset_' + sha_(email).slice(0, 32);
  if (cache.get(ck)) throw new Error('少し時間をおいてから再度お試しください');
  cache.put(ck, '1', CFG.RESET_INTERVAL_SEC);

  const generic = '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。';
  const u = findUser_(email);
  if (!u || String(u.get('status')) === 'suspended') return { ok: true, message: generic };

  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  setFields_(u, { passwordHash: hash_(temp, salt), salt: salt, mustChange: true, failCount: 0, lockedUntil: '' });
  deleteSessionsByEmail_(email);

  const sent = sendMail_(email,
    '【' + CFG.APP_NAME + '】仮パスワード再発行のお知らせ',
    u.get('nickname') + ' さん\n\n仮パスワードを再発行しました。\n\n' +
    '仮パスワード：' + temp + '\n\n' +
    'ログイン後、新しいパスワードの設定をお願いします。\n' +
    'お心当たりがない場合は、このメールを破棄してください。\n' + appUrlLine_());

  const show = prop_('SHOW_TEMP_PASSWORD') === 'true';
  return { ok: true, message: sent ? generic : generic + '（メール送信に失敗した可能性があります）', tempPassword: show ? temp : undefined };
}

function logout_(b) {
  if (b.token) deleteSessionByToken_(b.token);
  return { ok: true };
}

function verify_(b) {
  const u = requireSession_(b.token);
  return { ok: true, user: publicUser_(u) };
}

/* =========================================================
   ロケーション（Google Earth Studio 動画）
   動画本体は GitHub Pages の videos/ から配信。ここではファイル名などの一覧だけ返す
   ========================================================= */
function locations_(b) {
  requireSession_(b.token);
  const t = table_('Locations');
  const list = t.values
    .map(r => rowObj_(t, r))
    .filter(o => o.id && o.name && toBool_(o.active, true))
    .sort((a, c) => Number(a.sortOrder || 0) - Number(c.sortOrder || 0))
    .map(o => ({
      id: String(o.id),
      name: String(o.name),
      description: String(o.description || ''),
      video: String(o.video || '').trim(),
      videoMobile: String(o.videoMobile || '').trim(),
      poster: String(o.poster || '').trim()
    }));
  return { ok: true, locations: list };
}

/* =========================================================
   Gemini：応答生成 / 言い換え
   ========================================================= */
function chat_(b) {
  const u = requireSession_(b.token);
  const text = String(b.text || '').trim().slice(0, CFG.CHAT_MAX_CHARS);
  if (!text) throw new Error('話す内容を入力してください');
  const mode = b.mode === 'polish' ? 'polish' : 'reply';
  const nickname = String(u.get('nickname') || 'わたし');
  const loc = b.location && b.location.name ? b.location : null;

  const gestureGuide =
    'gesture は内容に合う動きを1つ選ぶ: nod(うなずく) shake(首を振る) look(見回す) wave(手を振る) clap(拍手) ' +
    'tsukkomi(ツッコミ) bow(お辞儀) think(考える) joy(喜ぶ) talk(普通に話す)';

  let sys;
  if (mode === 'polish') {
    sys = [
      'あなたは遠隔操作アバター（分身ロボット）の発話アシスタントです。',
      '操作者が入力した文章を、分身がその場で声に出して話す自然な日本語の話し言葉に整えてください。',
      '意味や意図は変えず、丁寧で親しみやすく、1〜2文・80文字程度に収めます。絵文字や記号の読み上げにくい表現は使いません。',
      'reply には実際に声に出すセリフだけを書き、「〜の声で」「（笑顔で）」などの話し方の指示やト書きは入れません。',
      gestureGuide,
      '出力は JSON {"reply": 整えた発話, "gesture": 動き} のみ。'
    ].join('\n');
  } else {
    sys = [
      'あなたは「' + nickname + '」さんの分身アバターです。' + nickname + 'さんは遠く離れた場所から、この分身を通して現地の人と交流しています。',
      '入力は、現地の人の発言や会話の話題です。分身として、温かく親しみやすい話し言葉で返事をしてください。',
      '返事は声で読み上げるため、1〜3文・100文字程度。箇条書き・絵文字・URLは使いません。',
      'reply には実際に声に出すセリフだけを書き、「〜の声で」「（笑顔で）」などの話し方の指示やト書きは入れません。',
      '知らないことは推測で断定せず、「' + nickname + 'さんに確認しますね」のように伝えます。',
      loc ? ('いま案内している場所：' + loc.name + (loc.description ? '（' + String(loc.description).slice(0, 300) + '）' : '') + '。場所の案内を求められたら、この情報をもとに話してください。') : '',
      gestureGuide,
      '出力は JSON {"reply": 返事, "gesture": 動き} のみ。'
    ].filter(Boolean).join('\n');
  }

  const contents = [];
  if (mode === 'reply' && Array.isArray(b.history)) {
    b.history.slice(-10).forEach(h => {
      if (h && h.text) contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 1000) }] });
    });
  }
  contents.push({ role: 'user', parts: [{ text: text }] });

  const data = gemini_(prop_('GEMINI_TEXT_MODEL') || CFG.DEFAULT_TEXT_MODEL, {
    systemInstruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: {
      temperature: mode === 'polish' ? 0.4 : 0.8,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          reply: { type: 'STRING' },
          gesture: { type: 'STRING', enum: GESTURES }
        },
        required: ['reply', 'gesture']
      }
    }
  });

  const raw = extractText_(data);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    parsed = { reply: raw.replace(/```json|```/g, '').trim(), gesture: 'talk' };
  }
  const reply = cleanSpeech_(parsed.reply);
  if (!reply) throw new Error('AIの返事を作れませんでした。もう一度お試しください');
  const gesture = GESTURES.indexOf(parsed.gesture) >= 0 ? parsed.gesture : 'talk';

  log_(u.get('email'), 'chat:' + mode, text + ' → ' + reply, gesture);
  return { ok: true, reply: reply, gesture: gesture };
}

/* =========================================================
   Gemini TTS：音声合成
   ========================================================= */
function tts_(b) {
  const u = requireSession_(b.token);
  const text = cleanSpeech_(b.text).slice(0, CFG.TTS_MAX_CHARS);
  if (!text) throw new Error('読み上げる文章がありません');
  const voice = /^[A-Za-z]{2,20}$/.test(String(b.voice || '')) ? String(b.voice) : 'Kore';

  // 短い定型句（「はい！」等）はキャッシュから返す
  const cache = CacheService.getScriptCache();
  const ck = 'tts_' + sha_(voice + '|' + text).slice(0, 40);
  const hit = cache.get(ck);
  if (hit) {
    try { const c = JSON.parse(hit); return { ok: true, audio: c.a, sampleRate: c.r, mimeType: c.m, cached: true }; } catch (e) {}
  }

  const data = gemini_(prop_('GEMINI_TTS_MODEL') || CFG.DEFAULT_TTS_MODEL, {
    // 指示文を混ぜると「〜の声で」まで読み上げられるため、話す文章だけを渡す
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });

  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
  if (!audioPart) throw new Error('音声データを受け取れませんでした');

  const mime = audioPart.inlineData.mimeType || 'audio/L16;rate=24000';
  const m = mime.match(/rate=(\d+)/);
  const rate = m ? Number(m[1]) : 24000;
  const b64 = audioPart.inlineData.data;

  if (b64.length < 95000) {
    try { cache.put(ck, JSON.stringify({ a: b64, r: rate, m: mime }), 21600); } catch (e) {}
  }

  const result = { ok: true, audio: b64, sampleRate: rate, mimeType: mime };

  // 任意：生成音声を Drive に WAV で保存
  const folderId = prop_('AUDIO_FOLDER_ID');
  if (folderId) {
    try { result.driveFileId = saveWav_(b64, rate, folderId, u.get('email')); }
    catch (e) { console.warn('saveWav failed', e); }
  }
  return result;
}

function saveWav_(b64, rate, folderId, email) {
  const pcm = Utilities.base64Decode(b64);
  const header = wavHeader_(pcm.length, rate);
  const name = 'tts_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '_' + String(email).split('@')[0] + '.wav';
  const blob = Utilities.newBlob(header.concat(pcm), 'audio/wav', name);
  return DriveApp.getFolderById(folderId).createFile(blob).getId();
}

function wavHeader_(dataLen, rate) {
  const b = [];
  const str = s => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); };
  const u32 = v => { b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); };
  const u16 = v => { b.push(v & 255, (v >> 8) & 255); };
  str('RIFF'); u32(36 + dataLen); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16);
  str('data'); u32(dataLen);
  return b.map(x => (x > 127 ? x - 256 : x)); // GAS の byte[] は符号付き
}

/* =========================================================
   Gemini API 共通
   ========================================================= */
function gemini_(model, payload) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('サーバーに GEMINI_API_KEY が設定されていません');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (code !== 200) {
    const msg = (data.error && data.error.message) || res.getContentText().slice(0, 200);
    if (code === 429) throw new Error('AIの利用が混み合っています。少し待ってからお試しください');
    throw new Error('Gemini API エラー（' + code + '）：' + msg);
  }
  return data;
}

function extractText_(data) {
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
}

/* =========================================================
   セッション
   ========================================================= */
function createSession_(email) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const t = table_('Sessions');
  const now = new Date();
  const data = { token: sha_(token), email: email, createdAt: now, expiresAt: new Date(now.getTime() + CFG.SESSION_HOURS * 3600000) };
  t.sh.appendRow(t.header.map(h => (h in data ? data[h] : '')));
  return token;
}

function requireSession_(token) {
  if (!token) throw authErr_('ログインしてください');
  const th = sha_(String(token));
  const t = table_('Sessions');
  const ti = t.idx;
  let email = null;
  for (let i = 0; i < t.values.length; i++) {
    const r = t.values[i];
    if (r[ti.token] === th) {
      if (new Date(r[ti.expiresAt]).getTime() < Date.now()) throw authErr_('ログインの有効期限が切れました');
      email = r[ti.email];
      break;
    }
  }
  if (!email) throw authErr_('ログインの有効期限が切れました');
  const u = findUser_(email);
  if (!u) throw authErr_('ユーザーが見つかりません');
  if (String(u.get('status')) === 'suspended') throw authErr_('このアカウントは利用停止中です');
  return u;
}

function deleteSessionByToken_(token) {
  deleteSessionsWhere_(r => r.token === sha_(String(token)));
}

function deleteSessionsByEmail_(email) {
  const e = normEmail_(email);
  deleteSessionsWhere_(r => normEmail_(r.email) === e);
}

function cleanupSessions_(email) {
  const e = normEmail_(email);
  const now = Date.now();
  deleteSessionsWhere_(r => normEmail_(r.email) === e && new Date(r.expiresAt).getTime() < now);
}

function deleteSessionsWhere_(pred) {
  const t = table_('Sessions');
  for (let i = t.values.length - 1; i >= 0; i--) {
    if (pred(rowObj_(t, t.values[i]))) t.sh.deleteRow(i + 2);
  }
}

function authErr_(msg) {
  const e = new Error(msg);
  e.code = 'AUTH';
  return e;
}

/* =========================================================
   スプレッドシート ヘルパー
   ========================================================= */
function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。GASエディタで setup() を実行してください');
  return sh;
}

function table_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const header = (values.shift() || []).map(String);
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  return { sh: sh, header: header, idx: idx, values: values };
}

function rowObj_(t, r) {
  const o = {};
  t.header.forEach((h, i) => { o[h] = r[i]; });
  return o;
}

function findUser_(email) {
  const e = normEmail_(email);
  if (!e) return null;
  const t = table_('Users');
  for (let i = 0; i < t.values.length; i++) {
    const row = t.values[i];
    if (normEmail_(row[t.idx.email]) === e) {
      return { t: t, rowIndex: i + 2, row: row, get: k => row[t.idx[k]] };
    }
  }
  return null;
}

function setFields_(u, fields) {
  const t = u.t;
  Object.keys(fields).forEach(k => { if (k in t.idx) u.row[t.idx[k]] = fields[k]; });
  t.sh.getRange(u.rowIndex, 1, 1, t.header.length).setValues([u.row]);
}

function publicUser_(u) {
  return {
    email: String(u.get('email')),
    nickname: String(u.get('nickname') || ''),
    mustChange: toBool_(u.get('mustChange'), false)
  };
}

function log_(email, type, text, gesture) {
  if (prop_('ENABLE_LOG') === 'false') return;
  try {
    const sh = ss_().getSheetByName('Logs');
    if (sh) sh.appendRow([new Date(), email, type, safe_(String(text).slice(0, 2000)), gesture || '']);
  } catch (e) { console.warn('log failed', e); }
}

/* =========================================================
   汎用ヘルパー
   ========================================================= */

// 読み上げ用に整える：先頭の「〜の声で：」「（明るく）」などの話し方指示やカギ括弧を取り除く
function cleanSpeech_(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t
      // （明るく）【元気に】などのト書き
      .replace(/^[（(【\[][^）)】\]]{0,30}[）)】\]]\s*/, '')
      // 「明るい声で、ゆっくり話して：」など、コロンまでの話し方指示
      .replace(/^[^。！？!?\n「」:：]{0,60}(声|口調|トーン|調子|話し方|話して|読んで|読み上げ)[^。！？!?\n「」:：]{0,20}[：:]\s*/, '')
      // Say cheerfully: など英語の指示
      .replace(/^(Say|Speak|Read)[^:：]{0,60}[:：]\s*/i, '')
      .trim();
    if (t === before) break;
  }
  return t.replace(/^「([\s\S]*)」$/, '$1').trim();
}
function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function normEmail_(v) { return String(v || '').trim().toLowerCase(); }
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function toBool_(v, def) {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (s === '') return def;
  return s === 'true' || s === '1' || s === 'yes';
}

// セルに数式として解釈されないようにする
function safe_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function sha_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// salt付きSHA-256をストレッチング
function hash_(pw, salt) {
  let h = sha_(salt + ':' + pw);
  for (let i = 0; i < CFG.HASH_ROUNDS; i++) h = sha_(h + ':' + salt);
  return h;
}

// 紛らわしい文字（0/O, 1/l/I）を除いた仮パスワード
function tempPassword_() {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const pick = set => set.charAt(Math.floor(Math.random() * set.length));
  let p = pick(letters) + pick(digits);
  for (let i = 0; i < 8; i++) p += pick(all);
  return p.split('').sort(() => Math.random() - 0.5).join('');
}

function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: CFG.APP_NAME });
    return true;
  } catch (e) {
    console.error('mail failed', e);
    return false;
  }
}

function appUrlLine_() {
  const url = prop_('APP_URL');
  return url ? '\nログインはこちら：' + url + '\n' : '';
}

/* =========================================================
   セットアップ・テスト用（GASエディタから手動実行）
   ========================================================= */
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const header = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#EEF2F4');
      sh.setFrozenRows(1);
    }
  });
  const loc = ss.getSheetByName('Locations');
  if (loc.getLastRow() === 1) {
    loc.appendRow(['sky', 'そら（背景なし）', '背景動画なしの空のステージです。', '', '', '', true, 0]);
    loc.appendRow(['sample', 'サンプル会場', 'videos/ に置いたMP4のファイル名を video 列に入れ、active を TRUE にしてください。', 'sample.mp4', 'sample-sp.mp4', '', false, 10]);
  }
  Logger.log('セットアップ完了：' + Object.keys(SHEETS).join(', '));
}

function testGemini() {
  const d = gemini_(prop_('GEMINI_TEXT_MODEL') || CFG.DEFAULT_TEXT_MODEL, {
    contents: [{ parts: [{ text: '分身ロボットとして、ひとことあいさつしてください。' }] }]
  });
  Logger.log(extractText_(d));
}

function testTts() {
  const d = gemini_(prop_('GEMINI_TTS_MODEL') || CFG.DEFAULT_TTS_MODEL, {
    contents: [{ parts: [{ text: 'こんにちは、分身です。' }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
  });
  const p = d.candidates[0].content.parts.find(x => x.inlineData);
  Logger.log('mime=' + p.inlineData.mimeType + ' / base64 length=' + p.inlineData.data.length);
}
