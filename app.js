/**
 * ぶんしんプレゼンス - app.js
 * 画面遷移 / 認証 / アバター制御 / Gemini・TTS連携
 */
(() => {
  'use strict';

  const C = window.APP_CONFIG || {};
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const PREFIX      = C.STORAGE_PREFIX || 'bunshin';
  const SESSION_KEY = PREFIX + '_session';
  const PREF_KEY    = PREFIX + '_prefs';

  const GESTURE_MS = {
    nod: 1100, shake: 1100, look: 2200, wave: 1800, clap: 1600,
    tsukkomi: 900, bow: 1600, think: 2400, joy: 1500, talk: 900
  };

  const MODE_HINTS = {
    echo:   '入力した言葉を、そのまま分身が話します。',
    polish: '入力をAIが自然な話し言葉に整えてから話します。',
    reply:  '相手の発言や話題を入力すると、AIが分身として返事を考えて話します。'
  };

  const state = {
    session: null,
    prefs: {
      mode: 'echo',
      ttsEngine: C.TTS_ENGINE || 'gemini',
      voice: C.DEFAULT_VOICE || 'Kore',
      speakOnReaction: true,
      autoSendVoice: false,
      showVideo: true,
      locationId: ''
    },
    history: [],
    locations: [],
    locationsLoaded: false,
    audioCtx: null,
    analyser: null,
    source: null,
    lipRaf: 0,
    mouthLevel: 0,
    speakToken: 0,
    bubbleTimer: 0,
    recog: null,
    listening: false,
    videoErrorShown: false,
    mobileVideoFailed: false
  };

  /* =========================================================
     ユーティリティ
     ========================================================= */
  function storageGet(key) {
    try { return localStorage.getItem(key) || sessionStorage.getItem(key); } catch (e) { return null; }
  }

  function toast(msg, type = '') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 5000 : 3200);
  }

  function setLoading(on, text) {
    $('#loading').hidden = !on;
    if (text) $('#loading-text').textContent = text;
  }

  function setMsg(el, text, ok = false) {
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }

  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function pwChecks(pw, confirm) {
    return {
      len: pw.length >= 8,
      alpha: /[A-Za-z]/.test(pw),
      num: /[0-9]/.test(pw),
      match: pw.length > 0 && pw === confirm
    };
  }

  /* =========================================================
     API
     ========================================================= */
  async function api(action, data = {}, opts = {}) {
    if (!C.GAS_URL || C.GAS_URL.includes('XXXX')) {
      throw new Error('config.js の GAS_URL を設定してください');
    }
    const body = Object.assign({ action }, data);
    if (opts.auth) body.token = state.session && state.session.token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || C.API_TIMEOUT_MS || 30000);
    let res;
    try {
      // text/plain で送るとプリフライトが発生せず、GASでもCORSエラーになりません
      res = await fetch(C.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: ctrl.signal
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '応答に時間がかかりすぎました。もう一度お試しください' : '通信できませんでした。ネット接続を確認してください');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('サーバーエラー（' + res.status + '）');

    let json;
    try { json = await res.json(); } catch (e) { throw new Error('サーバーの応答を読み取れませんでした（GASのデプロイ設定を確認してください）'); }

    if (!json.ok) {
      const err = new Error(json.error || 'エラーが発生しました');
      if (json.code === 'AUTH') { err.isAuth = true; handleExpired(); }
      throw err;
    }
    return json;
  }

  /* =========================================================
     セッション
     ========================================================= */
  function saveSession(s, remember) {
    state.session = s;
    try {
      const str = JSON.stringify(s);
      if (remember) { localStorage.setItem(SESSION_KEY, str); sessionStorage.removeItem(SESSION_KEY); }
      else { sessionStorage.setItem(SESSION_KEY, str); localStorage.removeItem(SESSION_KEY); }
    } catch (e) { /* プライベートモード等 */ }
  }

  function loadSession() {
    try { return JSON.parse(storageGet(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }

  function updateSession(patch) {
    let remember = false;
    try { remember = !!localStorage.getItem(SESSION_KEY); } catch (e) {}
    saveSession(Object.assign({}, state.session, patch), remember);
  }

  function clearSession() {
    state.session = null;
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function handleExpired() {
    if (!state.session) return;
    stopSpeaking();
    clearSession();
    showScreen('screen-login');
    toast('ログインの有効期限が切れました。もう一度ログインしてください', 'warn');
  }

  /* =========================================================
     設定（端末に保存）
     ========================================================= */
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      if (p) Object.assign(state.prefs, p);
    } catch (e) {}
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs)); } catch (e) {}
  }

  /* =========================================================
     画面・モーダル
     ========================================================= */
  function showScreen(id) {
    $$('.screen').forEach(s => { s.hidden = s.id !== id; });
    window.scrollTo(0, 0);
  }

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    const first = m.querySelector('input');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeModal(m) {
    m.hidden = true;
    m.querySelectorAll('form').forEach(f => f.reset());
    m.querySelectorAll('.form-msg').forEach(el => setMsg(el, ''));
    m.querySelectorAll('.result-box').forEach(el => { el.hidden = true; });
    m.querySelectorAll('.pw-toggle.is-shown').forEach(b => b.click());
  }

  /* パスワード表示切替ボタンを自動で付与 */
  function setupPwToggles() {
    const eye = '<svg class="ico-show" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOff = '<svg class="ico-hide" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    $$('.pw-field').forEach(field => {
      const input = field.querySelector('input');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toggle';
      btn.setAttribute('aria-label', 'パスワードを表示');
      btn.innerHTML = eye + eyeOff;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('is-shown', show);
        btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      });
      field.appendChild(btn);
    });
  }

  /* =========================================================
     認証フロー
     ========================================================= */
  async function onLogin(e) {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    const remember = $('#login-remember').checked;
    const msg = $('#login-msg');
    setMsg(msg, '');
    if (!isEmail(email)) return setMsg(msg, 'メールアドレスを正しく入力してください');
    if (!password) return setMsg(msg, 'パスワードを入力してください');

    setLoading(true, 'ログインしています…');
    try {
      const r = await api('login', { email, password });
      saveSession({ token: r.token, email: r.user.email, nickname: r.user.nickname, mustChange: r.user.mustChange }, remember);
      $('#form-login').reset();
      $('#login-remember').checked = remember;
      routeAfterLogin();
    } catch (err) {
      setMsg(msg, err.message);
    } finally {
      setLoading(false);
    }
  }

  function routeAfterLogin() {
    if (state.session.mustChange) {
      showScreen('screen-change');
      updateRules();
    } else {
      enterMain();
    }
  }

  function updateRules() {
    const checks = pwChecks($('#cp-new').value, $('#cp-confirm').value);
    $$('#cp-rules li').forEach(li => li.classList.toggle('ok', !!checks[li.dataset.rule]));
  }

  async function onChangePassword(e) {
    e.preventDefault();
    const cur = $('#cp-current').value;
    const nw = $('#cp-new').value;
    const cf = $('#cp-confirm').value;
    const msg = $('#cp-msg');
    setMsg(msg, '');
    if (!cur) return setMsg(msg, 'いまのパスワード（仮パスワード）を入力してください');
    const c = pwChecks(nw, cf);
    if (!c.len || !c.alpha || !c.num) return setMsg(msg, '新しいパスワードは英字と数字を含む8文字以上にしてください');
    if (!c.match) return setMsg(msg, '確認用のパスワードが一致しません');
    if (nw === cur) return setMsg(msg, '仮パスワードとは違うパスワードにしてください');

    setLoading(true, 'パスワードを変更しています…');
    try {
      await api('changePassword', { currentPassword: cur, newPassword: nw }, { auth: true });
      updateSession({ mustChange: false });
      $('#form-change').reset();
      updateRules();
      toast('パスワードを変更しました', 'ok');
      enterMain();
    } catch (err) {
      if (!err.isAuth) setMsg(msg, err.message);
    } finally {
      setLoading(false);
    }
  }

  async function onRegister(e) {
    e.preventDefault();
    const email = $('#reg-email').value.trim();
    const nickname = $('#reg-nickname').value.trim();
    const msg = $('#reg-msg');
    setMsg(msg, '');
    $('#reg-result').hidden = true;
    if (!isEmail(email)) return setMsg(msg, 'メールアドレスを正しく入力してください');
    if (!nickname) return setMsg(msg, 'ニックネームを入力してください');

    setLoading(true, '登録しています…');
    try {
      const r = await api('register', { email, nickname });
      setMsg(msg, r.message, true);
      if (r.tempPassword) {
        $('#reg-temp').textContent = r.tempPassword;
        $('#reg-result').hidden = false;
      }
      $('#login-email').value = email;
    } catch (err) {
      setMsg(msg, err.message);
    } finally {
      setLoading(false);
    }
  }

  async function onReset(e) {
    e.preventDefault();
    const email = $('#reset-email').value.trim();
    const msg = $('#reset-msg');
    setMsg(msg, '');
    if (!isEmail(email)) return setMsg(msg, 'メールアドレスを正しく入力してください');

    setLoading(true, '再発行しています…');
    try {
      const r = await api('resetPassword', { email });
      setMsg(msg, r.message, true);
      if (r.tempPassword) setMsg(msg, r.message + ' 仮パスワード：' + r.tempPassword, true);
      $('#login-email').value = email;
    } catch (err) {
      setMsg(msg, err.message);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    stopSpeaking();
    if (state.listening && state.recog) state.recog.stop();
    const had = state.session;
    clearSession();
    if (had) {
      // サーバー側のセッションも破棄（失敗しても画面は戻す）
      fetch(C.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'logout', token: had.token })
      }).catch(() => {});
    }
    state.history = [];
    $('#log-list').innerHTML = '';
    showScreen('screen-login');
    toast('ログアウトしました');
  }

  /* =========================================================
     メイン画面
     ========================================================= */
  function enterMain() {
    showScreen('screen-main');
    $('#user-name').textContent = (state.session.nickname || state.session.email) + ' さんの分身';
    applyPrefsToUI();
    if (!state.locationsLoaded) loadLocations();
    setStatus('待機中', 'idle');
  }

  function renderReactions() {
    const box = $('#reactions');
    box.innerHTML = '';
    (C.REACTIONS || []).forEach(r => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reaction';
      b.innerHTML = '<span class="pebble" aria-hidden="true"></span><span class="lbl"></span>';
      b.querySelector('.pebble').textContent = r.emoji || '●';
      b.querySelector('.lbl').textContent = r.label;
      b.addEventListener('click', () => onReaction(r, b));
      box.appendChild(b);
    });
  }

  function onReaction(r, btn) {
    ensureAudio();
    btn.classList.add('fired');
    setTimeout(() => btn.classList.remove('fired'), 400);
    Avatar.play(r.gesture);
    if (state.prefs.speakOnReaction && r.say) {
      addLog('avatar', r.say, 'リアクション');
      speak(r.say, null);
    } else {
      addLog('avatar', '（' + r.label + '）', 'リアクション');
    }
  }

  function applyPrefsToUI() {
    $$('#mode-switch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === state.prefs.mode)));
    $('#mode-hint').textContent = MODE_HINTS[state.prefs.mode] || '';
    $('#say-input').placeholder = state.prefs.mode === 'reply'
      ? '相手の発言や話題を入力（例：駅までどう行けばいい？）'
      : '分身に話させたいことを入力';

    $('#set-engine').value = state.prefs.ttsEngine;
    $('#set-voice').value = state.prefs.voice;
    $('#set-voice').disabled = state.prefs.ttsEngine !== 'gemini';
    $('#set-speak-reaction').checked = !!state.prefs.speakOnReaction;
    $('#set-auto-send').checked = !!state.prefs.autoSendVoice;
    $('#set-show-video').checked = !!state.prefs.showVideo;
    $('#stage').classList.toggle('no-video', !state.prefs.showVideo || !currentLocationUrl());
  }

  /* ---------- ロケーション（Google Earth Studio 動画） ----------
     動画はリポジトリの videos/ に置いた MP4 を GitHub Pages から配信します。
     Google Drive の共有リンクは大きいファイルで警告画面が挟まり
     <video> で再生できないため使いません。
  ---------------------------------------------------------------- */

  // ファイル名だけなら VIDEO_BASE_PATH を前に付ける
  function resolveMedia(path) {
    path = String(path || '').trim();
    if (!path) return '';
    if (/^(https?:)?\/\//i.test(path) || path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) {
      if (/drive\.google\.com|drive\.usercontent\.google\.com/i.test(path)) {
        console.warn('Google Drive の動画は再生できない場合があります。videos/ フォルダに置いてください:', path);
      }
      return path;
    }
    const base = C.VIDEO_BASE_PATH || 'videos/';
    return base.replace(/\/?$/, '/') + path.replace(/^\/+/, '');
  }

  function normalizeLocation(loc) {
    return {
      id: String(loc.id || ''),
      name: String(loc.name || loc.id || ''),
      description: String(loc.description || ''),
      videoUrl: resolveMedia(loc.video || loc.videoUrl),
      videoMobileUrl: resolveMedia(loc.videoMobile),
      posterUrl: resolveMedia(loc.poster || loc.posterUrl)
    };
  }

  async function loadLocations() {
    const source = C.LOCATION_SOURCE || 'config';
    let list = [];

    if (source === 'config' || source === 'both') {
      list = list.concat(C.LOCATIONS || []);
    }
    if (source === 'sheet' || source === 'both') {
      try {
        const r = await api('locations', {}, { auth: true });
        list = list.concat(r.locations || []);
      } catch (e) {
        if (e.isAuth) return;
        console.warn('locations:', e);
        toast('スプレッドシートのロケーションを読み込めませんでした', 'warn');
      }
    }

    // 正規化・ID重複は先勝ち
    const seen = {};
    list = list.map(normalizeLocation).filter(l => {
      if (!l.id || seen[l.id]) return false;
      seen[l.id] = true;
      return true;
    });
    if (!list.length) list = [normalizeLocation({ id: 'sky', name: 'そら（背景なし）', video: '' })];

    state.locations = list;
    state.locationsLoaded = true;

    const sel = $('#location-select');
    sel.innerHTML = '';
    list.forEach(loc => {
      const o = document.createElement('option');
      o.value = loc.id;
      o.textContent = loc.name;
      sel.appendChild(o);
    });
    const initial = list.find(l => l.id === state.prefs.locationId) ? state.prefs.locationId : list[0].id;
    sel.value = initial;
    setLocation(initial);
  }

  function currentLocation() {
    return state.locations.find(l => l.id === state.prefs.locationId) || null;
  }

  // スマホ・通信量節約モードでは軽量版を優先
  function preferMobileVideo() {
    const narrow = window.matchMedia('(max-width: ' + (C.MOBILE_MAX_WIDTH || 768) + 'px)').matches;
    const saveData = !!(navigator.connection && navigator.connection.saveData);
    return narrow || saveData;
  }

  function currentLocationUrl() {
    const l = currentLocation();
    if (!l) return '';
    if (l.videoMobileUrl && preferMobileVideo() && !state.mobileVideoFailed) return l.videoMobileUrl;
    return l.videoUrl || l.videoMobileUrl || '';
  }

  function setLocation(id) {
    state.prefs.locationId = id;
    savePrefs();
    state.mobileVideoFailed = false;
    state.videoErrorShown = false;
    const loc = currentLocation();
    $('#stage-caption').textContent = loc ? loc.name : 'そら';
    $('#location-desc').textContent = loc && loc.description ? loc.description : '';
    applyVideo();
  }

  function applyVideo() {
    const video = $('#bg-video');
    const stage = $('#stage');
    const url = currentLocationUrl();
    const loc = currentLocation();
    if (!state.prefs.showVideo || !url) {
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('poster');
      video.load();
      stage.classList.add('no-video');
      return;
    }
    stage.classList.remove('no-video');
    if (loc && loc.posterUrl) video.poster = loc.posterUrl; else video.removeAttribute('poster');
    if (video.getAttribute('src') !== url) {
      video.src = url;
      video.load();
    }
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* 自動再生がブロックされた場合は次の操作で再開 */ });
  }

  function onVideoError() {
    const video = $('#bg-video');
    const src = video.getAttribute('src');
    if (!src) return;
    const loc = currentLocation();
    // 軽量版が無い・壊れている場合は通常版で再試行
    if (loc && src === loc.videoMobileUrl && loc.videoUrl && loc.videoUrl !== src && !state.mobileVideoFailed) {
      state.mobileVideoFailed = true;
      applyVideo();
      return;
    }
    $('#stage').classList.add('no-video');
    if (!state.videoErrorShown) {
      state.videoErrorShown = true;
      toast('背景動画「' + decodeURIComponent(src) + '」を読み込めませんでした。ファイル名と videos/ への配置を確認してください', 'warn');
    }
  }

  /* =========================================================
     アバター
     ========================================================= */
  const Avatar = {
    timer: 0,
    play(g) {
      const el = $('#avatar');
      if (!el || !g || !GESTURE_MS[g]) return;
      Object.keys(GESTURE_MS).forEach(k => el.classList.remove('g-' + k));
      void el.getBoundingClientRect(); // アニメーションを最初から再生
      el.classList.add('g-' + g);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => el.classList.remove('g-' + g), GESTURE_MS[g] + 50);
    },
    talking(on) {
      $('#avatar').classList.toggle('is-talking', on);
    },
    mouth(level) {
      state.mouthLevel = state.mouthLevel * 0.55 + level * 0.45;
      const v = state.mouthLevel;
      const m = $('#av-mouth');
      if (!m) return;
      m.style.transform = 'scale(' + (1 + v * 0.5).toFixed(3) + ',' + (1 + v * 3.6).toFixed(3) + ')';
      m.style.opacity = (0.55 + v * 0.45).toFixed(2);
    },
    resetMouth() {
      state.mouthLevel = 0;
      const m = $('#av-mouth');
      if (m) { m.style.transform = ''; m.style.opacity = ''; }
    }
  };

  function setStatus(text, st = 'idle') {
    const el = $('#stage-status');
    el.textContent = text;
    el.dataset.state = st;
  }

  function showBubble(text) {
    clearTimeout(state.bubbleTimer);
    $('#bubble-text').textContent = text;
    $('#bubble').hidden = false;
    const b = $('#bubble');
    b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  }
  function hideBubbleLater(ms = 3500) {
    clearTimeout(state.bubbleTimer);
    state.bubbleTimer = setTimeout(() => { $('#bubble').hidden = true; }, ms);
  }

  /* =========================================================
     音声（TTS / リップシンク）
     ========================================================= */
  // iOS対策：ユーザー操作の直後に同期的に呼ぶ
  function ensureAudio() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      state.audioCtx = new AC();
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 512;
      state.analyser.connect(state.audioCtx.destination);
    }
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    // 背景動画が自動再生でブロックされていたらここで再開
    const v = $('#bg-video');
    if (v && v.paused && v.getAttribute('src') && state.prefs.showVideo) v.play().catch(() => {});
    return state.audioCtx;
  }

  function stopSpeaking() {
    state.speakToken++;
    cancelAnimationFrame(state.lipRaf);
    if (state.source) { try { state.source.stop(); } catch (e) {} state.source = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    Avatar.talking(false);
    Avatar.resetMouth();
    setStatus('待機中', 'idle');
  }

  async function speak(text, gesture) {
    text = String(text || '').trim();
    if (!text) return;
    stopSpeaking();
    const token = state.speakToken;

    showBubble(text);
    if (gesture) Avatar.play(gesture);

    try {
      if (state.prefs.ttsEngine === 'gemini') {
        try {
          setStatus('声を準備中…', 'thinking');
          const r = await api('tts', {
            text: text.slice(0, C.TTS_MAX_CHARS || 400),
            voice: state.prefs.voice
          }, { auth: true, timeout: C.AI_TIMEOUT_MS || 60000 });
          if (token !== state.speakToken) return;
          await playPcm(r.audio, r.sampleRate || 24000, token);
          return;
        } catch (e) {
          if (token !== state.speakToken || e.isAuth) return;
          console.warn('Gemini TTS:', e);
          toast('Gemini TTSが使えなかったため、ブラウザの音声で話します', 'warn');
        }
      }
      await speakBrowser(text, token);
    } finally {
      if (token === state.speakToken) {
        cancelAnimationFrame(state.lipRaf);
        Avatar.talking(false);
        Avatar.resetMouth();
        setStatus('待機中', 'idle');
        hideBubbleLater();
      }
    }
  }

  // Gemini TTS は 16bit リニアPCM（モノラル）を base64 で返す
  function playPcm(b64, rate, token) {
    const ctx = ensureAudio();
    if (!ctx) return Promise.resolve();
    const bin = atob(b64);
    const len = Math.floor(bin.length / 2);
    const buf = ctx.createBuffer(1, len, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      if (v >= 32768) v -= 65536;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(state.analyser);
    state.source = src;

    return new Promise(resolve => {
      src.onended = () => { if (state.source === src) state.source = null; resolve(); };
      setStatus('発話中', 'speaking');
      Avatar.talking(true);
      src.start();
      lipFromAnalyser(token);
    });
  }

  function lipFromAnalyser(token) {
    const data = new Uint8Array(state.analyser.fftSize);
    const loop = () => {
      if (token !== state.speakToken) return;
      state.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      Avatar.mouth(Math.min(1, rms * 5));
      state.lipRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  function pickJaVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return voices.find(v => v.lang === 'ja-JP' && /Google|Kyoko|O-ren|Nanami/i.test(v.name))
        || voices.find(v => v.lang && v.lang.startsWith('ja')) || null;
  }

  function speakBrowser(text, token) {
    return new Promise(resolve => {
      const fakeLip = () => {
        const t0 = performance.now();
        const loop = () => {
          if (token !== state.speakToken) return;
          const t = (performance.now() - t0) / 1000;
          const lvl = 0.2 + 0.6 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.abs(Math.sin(t * 3.7)));
          Avatar.mouth(lvl);
          state.lipRaf = requestAnimationFrame(loop);
        };
        loop();
      };

      setStatus('発話中', 'speaking');
      Avatar.talking(true);

      if (!('speechSynthesis' in window)) {
        fakeLip();
        setTimeout(resolve, Math.min(8000, 600 + text.length * 130));
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = C.BROWSER_TTS_RATE || 1.05;
      u.pitch = C.BROWSER_TTS_PITCH || 1.15;
      const v = pickJaVoice();
      if (v) u.voice = v;
      let done = false;
      const finish = () => { if (done) return; done = true; cancelAnimationFrame(state.lipRaf); resolve(); };
      u.onstart = fakeLip;
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
      // 一部ブラウザで onend が来ない対策
      setTimeout(finish, 2000 + text.length * 400);
    });
  }

  /* =========================================================
     話す（送信）
     ========================================================= */
  function guessGesture(text) {
    const rules = [
      [/ありがと|感謝|お世話/, 'bow'],
      [/こんにち|こんばん|おはよ|やっほ|はじめまして|またね|さよなら|バイバイ/, 'wave'],
      [/すご|おめでと|最高|拍手|パチパチ/, 'clap'],
      [/やった|うれし|嬉し|わーい/, 'joy'],
      [/なんでやねん|なんでや|ちゃうやろ/, 'tsukkomi'],
      [/いいえ|ちがう|違う|だめ|ダメ|無理/, 'shake'],
      [/^はい|そうです|なるほど|了解|わかりました|うん/, 'nod'],
      [/うーん|どうしよ|かな[？?]?$|迷/, 'think'],
      [/どこ|あっち|こっち|見て|ご覧/, 'look']
    ];
    for (const [re, g] of rules) if (re.test(text)) return g;
    return 'talk';
  }

  function setSendBusy(on) {
    $('#btn-send').disabled = on;
  }

  async function onSend() {
    const input = $('#say-input');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    ensureAudio();
    input.value = '';
    autoResize();

    const mode = state.prefs.mode;
    if (mode === 'echo') {
      addLog('avatar', text, '代弁');
      speak(text, guessGesture(text));
      return;
    }

    addLog('me', text, mode === 'polish' ? '入力' : '相手・話題');
    setSendBusy(true);
    stopSpeaking();
    setStatus('考え中…', 'thinking');
    Avatar.play('think');
    const loc = currentLocation();
    try {
      const r = await api('chat', {
        text,
        mode,
        history: mode === 'reply' ? state.history.slice(-10) : [],
        location: loc ? { name: loc.name, description: loc.description || '' } : null
      }, { auth: true, timeout: C.AI_TIMEOUT_MS || 60000 });

      if (mode === 'reply') {
        state.history.push({ role: 'user', text }, { role: 'model', text: r.reply });
        if (state.history.length > 20) state.history = state.history.slice(-20);
      }
      addLog('avatar', r.reply, mode === 'polish' ? 'AIが整えた言葉' : 'AIの返事');
      speak(r.reply, r.gesture);
    } catch (err) {
      if (!err.isAuth) toast(err.message, 'error');
      setStatus('待機中', 'idle');
    } finally {
      setSendBusy(false);
    }
  }

  function autoResize() {
    const t = $('#say-input');
    t.style.height = 'auto';
    t.style.height = Math.min(160, t.scrollHeight + 2) + 'px';
  }

  /* ---------- 会話ログ ---------- */
  function addLog(who, text, tag) {
    const list = $('#log-list');
    const li = document.createElement('li');
    li.className = 'log-item ' + (who === 'me' ? 'me' : 'avatar');
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const whoLabel = who === 'me' ? 'あなた' : '分身';
    li.innerHTML = '<span class="who"></span><span class="txt"></span>';
    li.querySelector('.who').textContent = whoLabel + (tag ? '（' + tag + '）' : '') + ' ' + time;
    li.querySelector('.txt').textContent = text;
    list.appendChild(li);
    while (list.children.length > 100) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- 音声入力 ---------- */
  function setupMic() {
    const btn = $('#btn-mic');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      btn.title = 'このブラウザは音声入力に対応していません';
      return;
    }
    const r = new SR();
    r.lang = 'ja-JP';
    r.interimResults = true;
    r.continuous = false;
    let finalText = '';

    r.onstart = () => {
      state.listening = true;
      finalText = '';
      btn.classList.add('listening');
      setStatus('聞いています…', 'listening');
    };
    r.onresult = ev => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t; else interim += t;
      }
      $('#say-input').value = finalText + interim;
      autoResize();
    };
    r.onerror = ev => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('マイクの使用が許可されていません。ブラウザの設定を確認してください', 'error');
      else if (ev.error === 'no-speech') toast('声が聞き取れませんでした', 'warn');
    };
    r.onend = () => {
      state.listening = false;
      btn.classList.remove('listening');
      if ($('#stage-status').dataset.state === 'listening') setStatus('待機中', 'idle');
      if (state.prefs.autoSendVoice && $('#say-input').value.trim()) onSend();
    };
    state.recog = r;

    btn.addEventListener('click', () => {
      ensureAudio();
      if (state.listening) { r.stop(); return; }
      try { r.start(); } catch (e) { /* 二重起動 */ }
    });
  }

  /* =========================================================
     イベント登録
     ========================================================= */
  function bindEvents() {
    $('#form-login').addEventListener('submit', onLogin);
    $('#form-change').addEventListener('submit', onChangePassword);
    $('#form-register').addEventListener('submit', onRegister);
    $('#form-reset').addEventListener('submit', onReset);
    ['#cp-new', '#cp-confirm'].forEach(s => $(s).addEventListener('input', updateRules));

    $('#btn-logout').addEventListener('click', logout);
    $('#btn-change-logout').addEventListener('click', logout);

    $$('[data-open]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.open)));
    $$('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); });
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $$('.modal').forEach(m => { if (!m.hidden) closeModal(m); });
    });

    $('#btn-copy-temp').addEventListener('click', async () => {
      const t = $('#reg-temp').textContent;
      try { await navigator.clipboard.writeText(t); toast('コピーしました', 'ok'); }
      catch (e) { toast('コピーできませんでした。手で控えてください', 'warn'); }
    });

    // 話す
    $('#btn-send').addEventListener('click', onSend);
    $('#say-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        onSend();
      }
    });
    $('#say-input').addEventListener('input', autoResize);

    $$('#mode-switch button').forEach(b => b.addEventListener('click', () => {
      state.prefs.mode = b.dataset.mode;
      savePrefs();
      applyPrefsToUI();
    }));

    // ロケーション
    $('#location-select').addEventListener('change', e => { ensureAudio(); setLocation(e.target.value); });
    $('#bg-video').addEventListener('error', onVideoError);
    // 画面の向き・幅が変わったら PC用/スマホ用 を選び直す
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.locationsLoaded && !$('#screen-main').hidden && currentLocationUrl() !== $('#bg-video').getAttribute('src')) applyVideo();
      }, 400);
    });

    // ステージ操作
    $('#btn-stop').addEventListener('click', () => { stopSpeaking(); hideBubbleLater(300); });
    $('#btn-fullscreen').addEventListener('click', () => {
      const st = $('#stage');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (st.requestFullscreen) st.requestFullscreen().catch(() => toast('全画面にできませんでした', 'warn'));
      else toast('この端末は全画面表示に対応していません', 'warn');
    });

    // 設定
    $('#set-engine').addEventListener('change', e => { state.prefs.ttsEngine = e.target.value; savePrefs(); applyPrefsToUI(); });
    $('#set-voice').addEventListener('change', e => { state.prefs.voice = e.target.value; savePrefs(); });
    $('#set-speak-reaction').addEventListener('change', e => { state.prefs.speakOnReaction = e.target.checked; savePrefs(); });
    $('#set-auto-send').addEventListener('change', e => { state.prefs.autoSendVoice = e.target.checked; savePrefs(); });
    $('#set-show-video').addEventListener('change', e => { state.prefs.showVideo = e.target.checked; savePrefs(); applyVideo(); });

    $('#btn-clear-log').addEventListener('click', () => {
      $('#log-list').innerHTML = '';
      state.history = [];
      toast('会話のきろくを消しました');
    });

    // 声リストの読み込みが遅いブラウザ対策
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => {};
  }

  function fillVoiceSelect() {
    const sel = $('#set-voice');
    sel.innerHTML = '';
    (C.GEMINI_VOICES || [{ id: 'Kore', label: 'Kore' }]).forEach(v => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      sel.appendChild(o);
    });
  }

  /* =========================================================
     起動
     ========================================================= */
  async function init() {
    const name = C.APP_NAME || 'ぶんしんプレゼンス';
    document.title = name;
    $$('[data-app-name]').forEach(el => { el.textContent = name; });
    $('#app-version').textContent = C.VERSION || '';

    loadPrefs();
    setupPwToggles();
    fillVoiceSelect();
    renderReactions();
    bindEvents();
    setupMic();

    if (!C.GAS_URL || C.GAS_URL.includes('XXXX')) $('#config-warning').hidden = false;

    const s = loadSession();
    if (s && s.token) {
      state.session = s;
      setLoading(true, 'ログイン状態を確認中…');
      try {
        const r = await api('verify', {}, { auth: true });
        updateSession({ email: r.user.email, nickname: r.user.nickname, mustChange: r.user.mustChange });
        routeAfterLogin();
      } catch (e) {
        if (!e.isAuth) {
          clearSession();
          showScreen('screen-login');
          setMsg($('#login-msg'), e.message);
        }
      } finally {
        setLoading(false);
      }
    } else {
      showScreen('screen-login');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
