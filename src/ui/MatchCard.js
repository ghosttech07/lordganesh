// Match-the-pairs overlay. Tap an item on the left, then its partner on the
// right; tap a made pair to undo it. Wrong pairs are shown against the
// correct ones with the explanation and the usual 5 s cooldown.

export class MatchCard {
  constructor(root, i18n, audio) {
    this.i18n = i18n;
    this.audio = audio;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay soft hidden';
    this.overlay.innerHTML = `
      <div class="card qcard">
        <div class="qmeta"><span class="cat"></span><span class="diff"></span></div>
        <p class="qtext"></p>
        <div class="match"><div class="col left"></div><div class="col right"></div></div>
        <div class="result hidden"><div class="verdict"></div><div class="why"></div></div>
        <div class="actions">
          <span class="cooldown"></span>
          <button class="btn-ghost undo"></button>
          <button class="btn-primary submit"></button>
          <button class="btn-primary next hidden"></button>
        </div>
      </div>`;
    root.appendChild(this.overlay);
    const q = (sel) => this.overlay.querySelector(sel);
    this.catEl = q('.cat'); this.diffEl = q('.diff'); this.textEl = q('.qtext');
    this.leftEl = q('.left'); this.rightEl = q('.right');
    this.resultEl = q('.result'); this.verdictEl = q('.verdict'); this.whyEl = q('.why');
    this.undoBtn = q('.undo'); this.submitBtn = q('.submit'); this.nextBtn = q('.next'); this.cooldownEl = q('.cooldown');
    this.undoBtn.addEventListener('click', () => { if (!this.locked && this.pairs.length) { this.pairs.pop(); this._render(); } });
    this.submitBtn.addEventListener('click', () => this._submit());
    this.nextBtn.addEventListener('click', () => this._continue());
    this.open = false; this.locked = false; this.cooldown = 0;
    this.onAnswer = null; this.onClose = null;
    this._keyHandler = (e) => { if (this.open && this.locked && (e.key === 'Enter' || e.key === ' ') && this.cooldown <= 0) { e.preventDefault(); this._continue(); } };
  }

  show(p) {
    this.p = p;
    this.locked = false; this.cooldown = 0;
    this.pairs = [];       // [leftIdx, rightIdx]
    this.selLeft = -1;
    const t = this.i18n;
    this.catEl.textContent = p.title;
    this.diffEl.textContent = t.diff(p.diff);
    this.textEl.textContent = t.t('matchPrompt');
    this.undoBtn.textContent = t.t('undo');
    this.submitBtn.textContent = t.t('submit');
    this.nextBtn.textContent = t.t('nextQuestion');
    this.resultEl.classList.add('hidden'); this.nextBtn.classList.add('hidden');
    this.submitBtn.classList.remove('hidden'); this.undoBtn.classList.remove('hidden');
    this.cooldownEl.textContent = '';
    this._render();
    this.overlay.classList.remove('hidden');
    this.open = true;
    window.addEventListener('keydown', this._keyHandler);
  }

  hide() {
    this.overlay.classList.add('hidden');
    this.open = false;
    window.removeEventListener('keydown', this._keyHandler);
  }

  _pairOf(side, idx) {
    return this.pairs.findIndex((pr) => pr[side] === idx);
  }

  _render() {
    this.leftEl.innerHTML = '';
    this.rightEl.innerHTML = '';
    const colors = ['#f2c14e', '#7fd0ff', '#9be29b', '#ff9c8a'];
    this.p.left.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      const k = this._pairOf(0, i);
      if (k >= 0) { b.classList.add('placed'); b.style.borderColor = colors[k]; }
      if (this.selLeft === i) b.classList.add('sel');
      b.textContent = text;
      b.disabled = this.locked;
      b.addEventListener('click', () => { if (this.locked) return; const kk = this._pairOf(0, i); if (kk >= 0) { this.pairs.splice(kk, 1); this.selLeft = -1; } else this.selLeft = this.selLeft === i ? -1 : i; this._render(); });
      this.leftEl.appendChild(b);
    });
    this.p.right.forEach((text, j) => {
      const b = document.createElement('button');
      b.className = 'chip';
      const k = this._pairOf(1, j);
      if (k >= 0) { b.classList.add('placed'); b.style.borderColor = colors[k]; }
      b.textContent = text;
      b.disabled = this.locked;
      b.addEventListener('click', () => {
        if (this.locked) return;
        const kk = this._pairOf(1, j);
        if (kk >= 0) { this.pairs.splice(kk, 1); this._render(); return; }
        if (this.selLeft < 0) return;
        this.pairs.push([this.selLeft, j]);
        this.selLeft = -1;
        this.audio?.uiTick();
        this._render();
      });
      this.rightEl.appendChild(b);
    });
    this.submitBtn.disabled = this.locked || this.pairs.length !== this.p.left.length;
  }

  _submit() {
    if (this.locked || this.pairs.length !== this.p.left.length) return;
    this.locked = true;
    // Correct when every left item is paired with its own partner.
    const correct = this.pairs.every(([l, r]) => this.p.right[r] === this.p.answerFor[l]);
    const t = this.i18n;
    this.resultEl.classList.remove('hidden');
    if (correct) { this.verdictEl.textContent = t.t('correct'); this.verdictEl.className = 'verdict'; this.cooldown = 0; }
    else {
      const key = this.p.left.map((l, i) => `${l} → ${this.p.answerFor[i]}`).join(' · ');
      this.verdictEl.textContent = `${t.t('tryAgain')} — ${t.t('correctAnswer')}: ${key}`;
      this.verdictEl.className = 'verdict bad';
      this.cooldown = 5;
    }
    this.whyEl.textContent = this.p.why;
    this.submitBtn.classList.add('hidden'); this.undoBtn.classList.add('hidden');
    this.nextBtn.classList.remove('hidden'); this.nextBtn.disabled = this.cooldown > 0;
    this.result = correct;
    this._render();
    this.onAnswer?.(correct, this.pairs.map(([l, r]) => `${this.p.left[l]} → ${this.p.right[r]}`));
  }

  _continue() { if (this.cooldown > 0) return; this.hide(); this.onClose?.(this.result); }
  gamepadConfirm() { if (this.open && this.locked && this.cooldown <= 0) this._continue(); }

  update(dt) {
    if (!this.open || !this.locked || this.cooldown <= 0) return;
    this.cooldown -= dt;
    const s = Math.max(0, this.cooldown);
    this.cooldownEl.textContent = s > 0 ? `${s.toFixed(1)}s` : '';
    if (s <= 0) { this.nextBtn.disabled = false; this.cooldownEl.textContent = ''; }
  }
}
