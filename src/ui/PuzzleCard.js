// Arrange-in-order puzzle overlay. Tap chips to build the sequence; tap a
// placed chip to send it back. Wrong order shows the correct sequence and the
// explanation with the same 5 s cooldown as a wrong question.

export class PuzzleCard {
  constructor(root, i18n, audio) {
    this.i18n = i18n;
    this.audio = audio;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay soft hidden';
    this.overlay.innerHTML = `
      <div class="card qcard">
        <div class="qmeta"><span class="cat"></span><span class="diff"></span></div>
        <p class="qtext"></p>
        <div class="seq-answer"></div>
        <div class="seq-pool"></div>
        <div class="result hidden">
          <div class="verdict"></div>
          <div class="why"></div>
        </div>
        <div class="actions">
          <span class="cooldown"></span>
          <button class="btn-ghost undo"></button>
          <button class="btn-primary submit"></button>
          <button class="btn-primary next hidden"></button>
        </div>
      </div>`;
    root.appendChild(this.overlay);
    this.catEl = this.overlay.querySelector('.cat');
    this.diffEl = this.overlay.querySelector('.diff');
    this.textEl = this.overlay.querySelector('.qtext');
    this.answerEl = this.overlay.querySelector('.seq-answer');
    this.poolEl = this.overlay.querySelector('.seq-pool');
    this.resultEl = this.overlay.querySelector('.result');
    this.verdictEl = this.overlay.querySelector('.verdict');
    this.whyEl = this.overlay.querySelector('.why');
    this.undoBtn = this.overlay.querySelector('.undo');
    this.submitBtn = this.overlay.querySelector('.submit');
    this.nextBtn = this.overlay.querySelector('.next');
    this.cooldownEl = this.overlay.querySelector('.cooldown');
    this.undoBtn.addEventListener('click', () => this._undo());
    this.submitBtn.addEventListener('click', () => this._submit());
    this.nextBtn.addEventListener('click', () => this._continue());
    this.open = false;
    this.locked = false;
    this.cooldown = 0;
    this.onAnswer = null;
    this.onClose = null;
    this._keyHandler = (e) => this._onKey(e);
  }

  show(p) {
    this.p = p;
    this.locked = false;
    this.cooldown = 0;
    this.placed = [];
    const t = this.i18n;
    this.catEl.textContent = p.title;
    this.diffEl.textContent = t.diff(p.diff);
    this.textEl.textContent = p.prompt;
    this.undoBtn.textContent = t.t('undo');
    this.submitBtn.textContent = t.t('submit');
    this.nextBtn.textContent = t.t('nextQuestion');
    this.resultEl.classList.add('hidden');
    this.nextBtn.classList.add('hidden');
    this.submitBtn.classList.remove('hidden');
    this.undoBtn.classList.remove('hidden');
    this.submitBtn.disabled = true;
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

  _render() {
    this.answerEl.innerHTML = '';
    this.poolEl.innerHTML = '';
    this.placed.forEach((idx, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip placed';
      chip.innerHTML = `<span class="n">${i + 1}</span>${this.p.shuffled[idx]}`;
      chip.disabled = this.locked;
      chip.addEventListener('click', () => this._remove(i));
      this.answerEl.appendChild(chip);
    });
    for (let k = this.placed.length; k < this.p.shuffled.length; k++) {
      const slot = document.createElement('div');
      slot.className = 'chip slot';
      slot.textContent = `${k + 1}`;
      this.answerEl.appendChild(slot);
    }
    this.p.shuffled.forEach((text, idx) => {
      if (this.placed.includes(idx)) return;
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = text;
      chip.disabled = this.locked;
      chip.addEventListener('click', () => this._pick(idx));
      this.poolEl.appendChild(chip);
    });
    this.submitBtn.disabled = this.locked || this.placed.length !== this.p.shuffled.length;
  }

  _pick(idx) {
    if (this.locked) return;
    this.placed.push(idx);
    this.audio?.uiTick();
    this._render();
  }
  _remove(i) {
    if (this.locked) return;
    this.placed.splice(i, 1);
    this._render();
  }
  _undo() {
    if (this.locked || this.placed.length === 0) return;
    this.placed.pop();
    this._render();
  }

  _onKey(e) {
    if (!this.open) return;
    if (!this.locked) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= this.p.shuffled.length) {
        // Number keys pick the n-th remaining pool chip.
        const remaining = this.p.shuffled.map((_, i) => i).filter((i) => !this.placed.includes(i));
        if (remaining[n - 1] !== undefined) this._pick(remaining[n - 1]);
      } else if (e.key === 'Backspace') this._undo();
      else if (e.key === 'Enter' && !this.submitBtn.disabled) this._submit();
    } else if ((e.key === 'Enter' || e.key === ' ') && this.cooldown <= 0) {
      e.preventDefault();
      this._continue();
    }
  }

  gamepadConfirm() {
    if (this.open && this.locked && this.cooldown <= 0) this._continue();
  }

  _submit() {
    if (this.locked || this.placed.length !== this.p.shuffled.length) return;
    this.locked = true;
    const answer = this.placed.map((i) => this.p.shuffled[i]);
    const correct = answer.every((v, i) => v === this.p.items[i]);
    const t = this.i18n;
    this.resultEl.classList.remove('hidden');
    if (correct) {
      this.verdictEl.textContent = t.t('correct');
      this.verdictEl.className = 'verdict';
      this.cooldown = 0;
    } else {
      this.verdictEl.textContent = `${t.t('tryAgain')} — ${t.t('correctAnswer')}: ${this.p.items.join(' → ')}`;
      this.verdictEl.className = 'verdict bad';
      this.cooldown = 5;
    }
    this.whyEl.textContent = this.p.why;
    this.submitBtn.classList.add('hidden');
    this.undoBtn.classList.add('hidden');
    this.nextBtn.classList.remove('hidden');
    this.nextBtn.disabled = this.cooldown > 0;
    this.result = correct;
    this._render();
    this.onAnswer?.(correct, answer);
  }

  _continue() {
    if (this.cooldown > 0) return;
    this.hide();
    this.onClose?.(this.result);
  }

  update(dt) {
    if (!this.open || !this.locked) return;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      const s = Math.max(0, this.cooldown);
      this.cooldownEl.textContent = s > 0 ? `${s.toFixed(1)}s` : '';
      if (s <= 0) {
        this.nextBtn.disabled = false;
        this.cooldownEl.textContent = '';
      }
    }
  }
}
