// Main / pause / settings / leaderboard / review / summary screens. Each is a
// function that renders into one overlay element; only one screen is open at
// a time. All text is pulled from I18n at render time so language switches
// take effect immediately.

import { QUALITY_PRESETS } from '../core/Settings.js';
import { LANGUAGES } from './i18n.js';

export class Menus {
  constructor(root, i18n, settings, leaderboard, audio) {
    this.i18n = i18n;
    this.settings = settings;
    this.leaderboard = leaderboard;
    this.audio = audio;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay hidden';
    root.appendChild(this.overlay);
    this.screen = null;
    this.stack = [];
    this.handlers = {}; // play, resume, quit, endRun, settingsChanged
    this.lbBoard = 'daily';
    this.lbFriends = false;
    this.lbHunt = false; // show every player by default; 'Hunt only' narrows
    this.deviceInfo = null;
    this.questionSystem = null;
    this.score = null;
    this.seed = 0;
    this.identity = null;
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  get isOpen() {
    return this.screen !== null;
  }

  close() {
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
    this.screen = null;
    this.stack.length = 0;
  }

  _render(name, html) {
    this.screen = name;
    this.overlay.innerHTML = html;
    this.overlay.classList.remove('hidden');
    return this.overlay;
  }

  _push(name) {
    if (this.screen) this.stack.push(this.screen);
    this._open(name);
  }
  _back() {
    const prev = this.stack.pop();
    if (prev) this._open(prev);
    else this.close();
  }
  _open(name) {
    if (name === 'main') this.showMain();
    else if (name === 'pause') this.showPause();
    else if (name === 'settings') this.showSettings();
    else if (name === 'leaderboard') this.showLeaderboard();
    else if (name === 'review') this.showReview();
  }

  showMain() {
    const t = this.i18n;
    const name = this.identity?.claimed ? this.identity.name : this.settings.get('playerName');
    const el = this._render(
      'main',
      `<div class="card">
        <h1>${t.t('title')}</h1>
        <p class="sub">${t.t('subtitle')}</p>
        <div class="field"><label>${t.t('playerName')}</label>
          <input type="text" class="name" maxlength="24" placeholder="${t.t('namePlaceholder')}" value="${name.replace(/"/g, '&quot;')}">
          <div class="meta namestatus" style="margin-top:4px">${this.identity?.claimed && this.identity.name === name ? t.t('nameYours') : this.leaderboard.backend === 'local' ? t.t('uniqueLocalNote') : ''}</div>
        </div>
        <div class="stack" style="margin-top:16px">
          <button class="btn-primary hunt">${t.t('hunt')}</button>
          <div class="meta" style="margin:-4px 0 4px">${t.t('huntDesc')}</div>
          <button class="btn-ghost play">${t.t('freeJourney')}</button>
          <div class="row">
            <button class="btn-ghost lb">${t.t('leaderboard')}</button>
            <button class="btn-ghost st">${t.t('settings')}</button>
          </div>
        </div>
        <div class="meta">${t.t('dailyWorld')} · ${t.t('seed')} <code>${this.seed}</code><br>${t.t('controlsHelp')}</div>
      </div>`
    );
    const input = el.querySelector('.name');
    const status = el.querySelector('.namestatus');
    input.addEventListener('input', () => this.settings.set('playerName', input.value.trim()));
    // Claim the name (globally unique) before a run can start.
    const start = async (mode) => {
      const want = input.value.trim() || 'Bhakta';
      if (!this.identity) return this.handlers.play?.(mode);
      status.textContent = t.t('checking');
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      const res = await this.identity.claim(want);
      for (const b of el.querySelectorAll('button')) b.disabled = false;
      if (res.ok) {
        this.settings.set('playerName', res.name);
        this.handlers.play?.(mode);
        return;
      }
      if (res.reason === 'taken') {
        const base = want.replace(/\d+$/, '').trim() || 'Bhakta';
        const sug = [1, 2, 3].map(() => `${base}${Math.floor(100 + Math.random() * 900)}`);
        status.innerHTML = `${t.t('nameTaken')} ${sug.map((x) => `<a href="#" class="sug" style="color:var(--gold);margin-left:6px">${escapeHtml(x)}</a>`).join('')}`;
        status.querySelectorAll('.sug').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); input.value = a.textContent; status.textContent = ''; }));
        input.focus();
      } else if (res.reason === 'invalid') {
        status.textContent = t.t('nameInvalid');
        input.focus();
      } else {
        // Offline: let them play; the score is queued and the name claimed on retry.
        status.textContent = t.t('nameOffline');
        this.settings.set('playerName', want);
        setTimeout(() => this.handlers.play?.(mode), 900);
      }
    };
    el.querySelector('.play').addEventListener('click', () => start('free'));
    el.querySelector('.hunt').addEventListener('click', () => start('hunt'));
    el.querySelector('.lb').addEventListener('click', () => this._push('leaderboard'));
    el.querySelector('.st').addEventListener('click', () => this._push('settings'));
  }

  showPause() {
    const t = this.i18n;
    const el = this._render(
      'pause',
      `<div class="card">
        <h1>${t.t('paused')}</h1>
        <div class="stack">
          <button class="btn-primary resume">${t.t('resume')}</button>
          <div class="row">
            <button class="btn-ghost lb">${t.t('leaderboard')}</button>
            <button class="btn-ghost rv">${t.t('review')}</button>
            <button class="btn-ghost st">${t.t('settings')}</button>
          </div>
          <div class="divider"></div>
          <button class="btn-ghost end">${t.t('endRun')}</button>
        </div>
      </div>`
    );
    el.querySelector('.resume').addEventListener('click', () => this.handlers.resume?.());
    el.querySelector('.lb').addEventListener('click', () => this._push('leaderboard'));
    el.querySelector('.rv').addEventListener('click', () => this._push('review'));
    el.querySelector('.st').addEventListener('click', () => this._push('settings'));
    el.querySelector('.end').addEventListener('click', () => this.handlers.endRun?.());
  }

  showSettings() {
    const t = this.i18n;
    const s = this.settings;
    const q = s.get('quality');
    const el = this._render(
      'settings',
      `<div class="card wide">
        <h1>${t.t('settings')}</h1>
        <div class="grid2">
          <div class="stack">
            <h2>${t.t('graphics')}</h2>
            <div class="field"><label>${t.t('quality')}</label>
              <select class="quality">
                <option value="auto"${q === 'auto' ? ' selected' : ''}>${t.t('auto')}${this.deviceInfo ? ` (${QUALITY_PRESETS[this.deviceInfo.tier].name})` : ''}</option>
                ${Object.entries(QUALITY_PRESETS).map(([k, v]) => `<option value="${k}"${q === k ? ' selected' : ''}>${v.name}</option>`).join('')}
              </select></div>
            <div class="field"><label>${t.t('renderer')}</label>
              <select class="renderer">
                <option value="webgl"${s.get('renderer') === 'webgl' ? ' selected' : ''}>WebGL 2</option>
                <option value="webgpu"${s.get('renderer') === 'webgpu' ? ' selected' : ''}${this.deviceInfo?.hasWebGPU ? '' : ' disabled'}>WebGPU (experimental)</option>
              </select></div>
            <div class="field"><div class="check"><input type="checkbox" class="debug"${s.get('debug') ? ' checked' : ''}><label>${t.t('debug')}</label></div></div>
            <h2>${t.t('language')}</h2>
            <div class="field"><select class="lang">
              ${LANGUAGES.map((l) => `<option value="${l.code}"${this.i18n.lang === l.code ? ' selected' : ''}>${l.label}</option>`).join('')}
            </select></div>
          </div>
          <div class="stack">
            <h2>${t.t('audio')}</h2>
            ${['masterVolume:master', 'musicVolume:music', 'sfxVolume:sfx', 'ambientVolume:ambient']
              .map((p) => {
                const [key, label] = p.split(':');
                return `<div class="field"><label>${t.t(label)}</label><input type="range" min="0" max="1" step="0.01" data-key="${key}" value="${s.get(key)}"></div>`;
              })
              .join('')}
            <h2>${t.t('controls')}</h2>
            <div class="field"><label>${t.t('mouseSens')}</label><input type="range" min="0.2" max="3" step="0.05" data-key="mouseSensitivity" value="${s.get('mouseSensitivity')}"></div>
            <div class="field"><label>${t.t('padSens')}</label><input type="range" min="0.2" max="3" step="0.05" data-key="gamepadSensitivity" value="${s.get('gamepadSensitivity')}"></div>
            <div class="field"><div class="check"><input type="checkbox" class="invert"${s.get('invertY') ? ' checked' : ''}><label>${t.t('invertY')}</label></div></div>
            <div class="field"><label>${t.t('mooshikaSize')}</label><input type="range" min="0.4" max="1.2" step="0.02" data-key="mooshikaScale" value="${s.get('mooshikaScale')}"></div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="row"><button class="btn-ghost back">${t.t('back')}</button></div>
        ${this.deviceInfo ? `<div class="meta">GPU: ${this.deviceInfo.gpu || 'unknown'} · cores ${this.deviceInfo.cores} · dpr ${this.deviceInfo.dpr}</div>` : ''}
      </div>`
    );
    el.querySelector('.quality').addEventListener('change', (e) => {
      s.set('quality', e.target.value);
      this.handlers.settingsChanged?.('quality');
    });
    el.querySelector('.renderer').addEventListener('change', (e) => {
      s.set('renderer', e.target.value);
      this.handlers.settingsChanged?.('renderer');
    });
    el.querySelector('.debug').addEventListener('change', (e) => {
      s.set('debug', e.target.checked);
      this.handlers.settingsChanged?.('debug');
    });
    el.querySelector('.lang').addEventListener('change', (e) => {
      this.i18n.setLanguage(e.target.value);
      this.showSettings();
    });
    el.querySelectorAll('input[type=range]').forEach((r) => {
      r.addEventListener('input', () => {
        s.set(r.dataset.key, parseFloat(r.value));
        this.handlers.settingsChanged?.(r.dataset.key);
      });
    });
    el.querySelector('.invert').addEventListener('change', (e) => {
      s.set('invertY', e.target.checked);
      this.handlers.settingsChanged?.('invertY');
    });
    el.querySelector('.back').addEventListener('click', () => this._back());
  }

  async showLeaderboard() {
    const t = this.i18n;
    const el = this._render(
      'leaderboard',
      `<div class="card wide">
        <h1>${t.t('leaderboard')}</h1>
        <div class="tabs">
          ${['daily', 'weekly', 'alltime'].map((b) => `<button class="btn-ghost tab${this.lbBoard === b ? ' active' : ''}" data-board="${b}">${t.t(b === 'alltime' ? 'allTime' : b)}</button>`).join('')}
          <button class="btn-ghost friends${this.lbFriends ? ' active' : ''}">${t.t('friends')}</button>
          <button class="btn-ghost huntonly${this.lbHunt ? ' active' : ''}">${t.t('huntOnly')}</button>
        </div>
        <div class="row" style="margin-bottom:12px">
          <input type="text" class="friend" placeholder="${t.t('addFriend')}" style="flex:1;background:rgba(0,0,0,0.3);border:1px solid rgba(251,243,228,0.2);color:var(--cream);padding:9px 12px;border-radius:10px">
          <button class="btn-ghost addf">+</button>
        </div>
        <div class="lb-wrap"><div class="meta">${t.t('loading')}</div></div>
        <div class="meta rank"></div>
        <div class="divider"></div>
        <div class="row"><button class="btn-ghost back">${t.t('back')}</button><span class="meta" style="margin:0 0 0 auto">${this.leaderboard.backend === 'supabase' ? 'Supabase' : 'Local'}</span></div>
      </div>`
    );
    el.querySelectorAll('.tab').forEach((b) =>
      b.addEventListener('click', () => {
        this.lbBoard = b.dataset.board;
        this.showLeaderboard();
      })
    );
    el.querySelector('.friends').addEventListener('click', () => {
      this.lbFriends = !this.lbFriends;
      this.showLeaderboard();
    });
    el.querySelector('.huntonly').addEventListener('click', () => {
      this.lbHunt = !this.lbHunt;
      this.showLeaderboard();
    });
    el.querySelector('.addf').addEventListener('click', () => {
      const v = el.querySelector('.friend').value.trim();
      if (v) {
        this.leaderboard.addFriend(v);
        this.lbFriends = true;
        this.showLeaderboard();
      }
    });
    el.querySelector('.back').addEventListener('click', () => this._back());

    const me = this.settings.get('playerName');
    let data;
    try {
      data = await this.leaderboard.fetch(this.lbBoard, { friendsOnly: this.lbFriends, playerName: me, mode: this.lbHunt ? 'hunt' : null });
    } catch (err) {
      el.querySelector('.lb-wrap').innerHTML = `<div class="meta">${String(err.message || err)}</div>`;
      return;
    }
    if (this.screen !== 'leaderboard') return;
    const wrap = el.querySelector('.lb-wrap');
    if (data.rows.length === 0) {
      wrap.innerHTML = `<div class="meta">${t.t('noScores')}</div>`;
    } else {
      wrap.innerHTML = `<table class="lb"><thead><tr>
        <th>${t.t('rank')}</th><th>${t.t('name')}</th><th>${t.t('mode')}</th><th style="text-align:right">${t.t('score')}</th><th style="text-align:right">${t.t('modaks')}</th><th style="text-align:right">${t.t('accuracy')}</th><th style="text-align:right">${t.t('streak')}</th><th style="text-align:right">${t.t('duration')}</th>
        </tr></thead><tbody>
        ${data.rows
          .map(
            (r, i) => `<tr class="${r.name === me ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.mode === 'hunt' ? '🏆' : '·'}</td><td class="num">${r.score}</td><td class="num">${r.modaks_collected}</td><td class="num">${r.accuracy_pct}%</td><td class="num">${r.longest_streak}</td><td class="num">${fmtDuration(r.play_duration)}</td></tr>`
          )
          .join('')}
        </tbody></table>`;
    }
    el.querySelector('.rank').textContent = data.playerRank > 0 ? `${t.t('yourRank')}: #${data.playerRank} / ${data.total}` : '';
  }

  showReview() {
    const t = this.i18n;
    const missed = this.questionSystem ? this.questionSystem.missed : [];
    const el = this._render(
      'review',
      `<div class="card wide">
        <h1>${t.t('review')}</h1>
        <div class="lb-wrap">
        ${
          missed.length === 0
            ? `<div class="meta">${t.t('noMissed')}</div>`
            : missed
                .map(
                  (m) => `<div class="review-item">
                    <div class="q">${escapeHtml(m.q.q)}</div>
                    <div class="a">${t.t('youAnswered')}: <span class="you">${escapeHtml(m.chosen)}</span> · ${t.t('correctAnswer')}: <b>${escapeHtml(m.q.o[m.q.a])}</b></div>
                    <div class="why">${escapeHtml(m.q.why)}</div>
                  </div>`
                )
                .join('')
        }
        </div>
        <div class="divider"></div>
        <div class="row"><button class="btn-ghost back">${t.t('back')}</button></div>
      </div>`
    );
    el.querySelector('.back').addEventListener('click', () => this._back());
  }

  showSummary(score, submitResult, mode = 'free') {
    const t = this.i18n;
    if (mode === 'hunt') this.lbHunt = true;
    const el = this._render(
      'summary',
      `<div class="card">
        <h1>${t.t('runSummary')}</h1>
        <div class="grid2" style="margin-bottom:8px">
          <div><div class="meta" style="margin:0">${t.t('score')}</div><div style="font-family:var(--display);font-size:40px;color:var(--gold)">${score.score}</div></div>
          <div class="stack" style="gap:4px;font-size:14px">
            <div>${t.t('modaks')}: <b>${score.modaks}</b></div>
            <div>${t.t('accuracy')}: <b>${Math.round(score.accuracy * 100)}%</b></div>
            <div>${t.t('best')} ${t.t('streak').toLowerCase()}: <b>${score.longestStreak}</b></div>
            <div>${t.t('duration')}: <b>${fmtDuration(score.playDurationSec)}</b></div>
          </div>
        </div>
        <div class="meta">${submitResult.ok ? t.t('submitted') : submitResult.queued ? t.t('queued') : `${t.t('rejected')}: ${escapeHtml(submitResult.reason || '')}`}</div>
        <div class="divider"></div>
        <div class="stack">
          <button class="btn-primary again">${t.t('playAgain')}</button>
          <div class="row">
            <button class="btn-ghost lb">${t.t('leaderboard')}</button>
            <button class="btn-ghost rv">${t.t('review')}</button>
          </div>
        </div>
      </div>`
    );
    el.querySelector('.again').addEventListener('click', () => this.handlers.play?.(mode));
    el.querySelector('.lb').addEventListener('click', () => this._push('leaderboard'));
    el.querySelector('.rv').addEventListener('click', () => this._push('review'));
  }

  toast(msg, ms = 2200) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    this.overlay.parentElement.appendChild(d);
    setTimeout(() => d.remove(), ms);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
