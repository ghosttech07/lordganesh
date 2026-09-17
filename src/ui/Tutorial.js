// "How to play" — a short paged overlay. Shown automatically the first time a
// player starts a run on this device, and any time from the main or pause menu.

const ICONS = ['🕉️', '🐭', '🍬', '🏠', '🏆', '🏔️'];

export class Tutorial {
  constructor(root, i18n) {
    this.i18n = i18n;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay hidden';
    root.appendChild(this.overlay);
    this.page = 0;
    this.onDone = null;
  }

  show(onDone) {
    this.onDone = onDone;
    this.page = 0;
    this._render();
    this.overlay.classList.remove('hidden');
  }

  hide() {
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
  }

  _render() {
    const t = this.i18n;
    const pages = t.t('tut');
    const [title, body] = pages[this.page];
    const last = this.page === pages.length - 1;
    this.overlay.innerHTML = `
      <div class="card tutorial">
        <div class="tut-icon">${ICONS[this.page] || '✨'}</div>
        <h1>${title}</h1>
        <p class="tut-body">${body}</p>
        <div class="tut-dots">${pages.map((_, i) => `<i class="${i === this.page ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row" style="justify-content:space-between">
          <button class="btn-ghost skip">${t.t('skip')}</button>
          <button class="btn-primary next">${last ? t.t('begin') : t.t('next')}</button>
        </div>
      </div>`;
    this.overlay.querySelector('.skip').addEventListener('click', () => this._finish());
    this.overlay.querySelector('.next').addEventListener('click', () => {
      if (last) this._finish();
      else {
        this.page++;
        this._render();
      }
    });
  }

  _finish() {
    this.hide();
    this.onDone?.();
  }
}
