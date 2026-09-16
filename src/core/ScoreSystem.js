// Score, streaks and run statistics. The exact same arithmetic lives in
// leaderboard/validate.js so the server can re-derive the score from the
// submitted counts and reject anything that doesn't add up.

export const POINTS_PER_MODAK = 100;
export const STREAK_BONUSES = { 3: 50, 5: 150, 10: 500 };

export class ScoreSystem {
  constructor() {
    this.reset();
  }

  reset() {
    this.score = 0;
    this.modaks = 0;
    this.streak = 0;
    this.longestStreak = 0;
    this.answered = 0;
    this.correct = 0;
    this.bonusEvents = []; // streak lengths at which a bonus fired
    this.startTime = performance.now();
    this.lastBonus = 0;
  }

  /** @returns {number} bonus awarded this answer (0 if none). */
  onCorrect() {
    this.modaks++;
    this.answered++;
    this.correct++;
    this.streak++;
    if (this.streak > this.longestStreak) this.longestStreak = this.streak;
    this.score += POINTS_PER_MODAK;
    const bonus = STREAK_BONUSES[this.streak] || 0;
    if (bonus) {
      this.score += bonus;
      this.bonusEvents.push(this.streak);
    }
    this.lastBonus = bonus;
    return bonus;
  }

  onWrong() {
    this.answered++;
    this.streak = 0;
    this.lastBonus = 0;
  }

  get accuracy() {
    return this.answered === 0 ? 0 : this.correct / this.answered;
  }

  get playDurationSec() {
    return (performance.now() - this.startTime) / 1000;
  }

  /** Payload for leaderboard submission. */
  toSubmission(name, seed, mode = 'free') {
    return {
      name,
      mode,
      score: this.score,
      modaks_collected: this.modaks,
      accuracy_pct: Math.round(this.accuracy * 1000) / 10,
      longest_streak: this.longestStreak,
      play_duration: Math.round(this.playDurationSec),
      world_seed: seed,
      bonus_events: this.bonusEvents.slice(),
    };
  }
}
