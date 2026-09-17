// Persists the current run on this device so a returning player continues
// from the same score. Saved every few seconds while playing and on pause;
// cleared when the run is submitted.

const KEY = 'endless-modak.run.v1';

export class RunSave {
  static load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      return d && typeof d.score === 'number' ? d : null;
    } catch {
      return null;
    }
  }

  static save(game) {
    const s = game.score;
    const c = game.controller;
    const data = {
      version: 1,
      name: game.identity?.name || game.settings.get('playerName'),
      mode: game.mode,
      seed: game.seed,
      score: s.score,
      modaks: s.modaks,
      streak: s.streak,
      longestStreak: s.longestStreak,
      answered: s.answered,
      correct: s.correct,
      bonusEvents: s.bonusEvents.slice(),
      elapsed: s.playDurationSec,
      x: c.x,
      z: c.z,
      yaw: c.yaw,
      mounted: c.mounted,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }

  static clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}
