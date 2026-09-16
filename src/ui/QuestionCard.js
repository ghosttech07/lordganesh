// The question overlay. World stays visible behind a soft blur. On a wrong
// answer the correct option is highlighted and the explanation is shown — the
// teaching moment — with a 5 s cooldown before the player can continue.

const KEYS = ['1', '2', '3', '4'];

export class QuestionCard {
  constructor(root, i18n, audio) {
    this.i18n = i18n;
    this.audio = audio;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay soft hidden';
    this.overlay.innerHTML = `
      <div class="card qcard">
        <div class="qmeta"><span class="cat"></span><span class="diff"></span></div>
        <p class="qtext"></p>
        <div class="options"></div>
        <div class="result hidden">
          <div class="verdict"></div>
          <div class="why"></div>
        </div>
        <div class="actions">
          <span class="cooldown"></span>
          <button class="btn-primary next hidden"></button>
        </div>
      </div>`;
    root.appendChild(this.overlay);
    this.catEl = this.overlay.querySelector('.cat');
    this.diffEl = this.overlay.querySelector('.diff');
    this.textEl = this.overlay.querySelector('.qtext');
    this.optionsEl = this.overlay.querySelector('.options');
    this.resultEl = this.overlay.querySelector('.result');
    this.verdictEl = this.overlay.querySelector('.verdict');
    this.whyEl = this.overlay.querySelector('.why');
    this.nextBtn = this.overlay.querySelector('.next');
    this.cooldownEl = this.overlay.querySelector('.cooldown');

    this.optionBtns = [];
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.innerHTML = `<span class="key">${KEYS[i]}</span><span class="txt"></span>`;
      b.addEventListener('click', () => this._choose(i));
      this.optionsEl.appendChild(b);
      this.optionBtns.push(b);
    }
    this.nextBtn.addEventListener('click', () => this._continue());

    this.open = false;
    this.locked = false;
    this.cooldown = 0;
    this.presentation = null;
    this.onAnswer = null;   // (correct:boolean, chosenIndex) → void
    this.onClose = null;    // () → void
    this._keyHandler = (e) => this._onKey(e);
  }

  show(presentation) {
    this.presentation = presentation;
    this.locked = false;
    this.cooldown = 0;
    const t = this.i18n;
    this.catEl.textContent = t.cat(presentation.cat);
    this.diffEl.textContent = t.diff(presentation.diff);
    this.textEl.textContent = presentation.text;
    for (let i = 0; i < 4; i++) {
      const b = this.optionBtns[i];
      b.querySelector('.txt').textContent = presentation.options[i];
      b.className = 'opt';
      b.disabled = false;
    }
    this.resultEl.classList.add('hidden');
    this.nextBtn.classList.add('hidden');
    this.cooldownEl.textContent = '';
    this.overlay.classList.remove('hidden');
    this.open = true;
    window.addEventListener('keydown', this._keyHandler);
  }

  hide() {
    this.overlay.classList.add('hidden');
    this.open = false;
    window.removeEventListener('keydown', this._keyHandler);
  }

  _onKey(e) {
    if (!this.open) return;
    if (!this.locked) {
      const idx = KEYS.indexOf(e.key);
      if (idx >= 0) this._choose(idx);
    } else if ((e.key === 'Enter' || e.key === ' ') && this.cooldown <= 0) {
      e.preventDefault();
      this._continue();
    }
  }

  /** Gamepad: confirm continues when unlocked; option buttons via d-pad not needed. */
  gamepadConfirm() {
    if (this.open && this.locked && this.cooldown <= 0) this._continue();
  }

  _choose(i) {
    if (this.locked) return;
    this.locked = true;
    const p = this.presentation;
    const correct = i === p.correctIndex;
    for (let k = 0; k < 4; k++) this.optionBtns[k].disabled = true;
    this.optionBtns[p.correctIndex].classList.add('correct');
    if (!correct) this.optionBtns[i].classList.add('wrong');

    const t = this.i18n;
    this.resultEl.classList.remove('hidden');
    if (correct) {
      this.verdictEl.textContent = t.t('correct');
      this.verdictEl.className = 'verdict';
      this.cooldown = 0;
    } else {
      this.verdictEl.textContent = `${t.t('tryAgain')} — ${t.t('correctAnswer')}: ${p.options[p.correctIndex]}`;
      this.verdictEl.className = 'verdict bad';
      this.cooldown = 5;
    }
    this.whyEl.textContent = p.explanation;
    this.nextBtn.textContent = t.t('nextQuestion');
    this.nextBtn.classList.remove('hidden');
    this.nextBtn.disabled = this.cooldown > 0;
    this.result = correct;
    this.onAnswer?.(correct, i);
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
