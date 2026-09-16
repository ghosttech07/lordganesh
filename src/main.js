import { Game } from './Game.js';

const game = new Game(document.getElementById('game'), document.getElementById('ui'));
game.boot().catch((err) => {
  console.error(err);
  const d = document.createElement('div');
  d.className = 'loading';
  d.innerHTML = `<div class="msg" style="max-width:520px;text-align:center;line-height:1.6">Could not start the game.<br><code>${String(err.message || err)}</code><br><br>WebGL 2 is required.</div>`;
  document.getElementById('ui').appendChild(d);
});
window.__game = game;
