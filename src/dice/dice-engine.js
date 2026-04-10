/**
 * VTM V5 Dice Engine
 * Pure JavaScript — no Foundry dependencies.
 * Can be imported and tested in Node/browser without Foundry.
 *
 * Rules summary (V5 core):
 *   Regular die  : 1-5 = failure, 6-9 = success, 10 = success + potential crit
 *   Hunger die   : same, BUT 1 = Bestial Failure marker, 10 = Messy Critical marker
 *   Crit pairing : every two 10s in the full pool grant +2 bonus successes (net +4 per pair)
 *   Messy Crit   : crit pair formed AND at least one 10 came from a Hunger die
 *   Bestial Fail : at least one Hunger die shows 1 AND total successes = 0
 */

// ─── Low-level random ────────────────────────────────────────────────────────

/**
 * Default random source: Math.random. Override for deterministic testing.
 * @type {() => number} returns 0 (exclusive) to 1 (exclusive)
 */
let _randomFn = () => Math.random();

/**
 * Replace the random source for testing.
 * @param {() => number} fn
 */
export function setRandomFn(fn) {
  _randomFn = fn;
}

/** Roll a single d10 (1–10). */
function d10() {
  return Math.floor(_randomFn() * 10) + 1;
}

// ─── Core roll ───────────────────────────────────────────────────────────────

/**
 * Roll a V5 dice pool.
 *
 * @param {number} poolSize   - Total number of dice
 * @param {number} hungerDice - How many of those dice are Hunger dice (≤ poolSize)
 * @returns {DiceResult}
 *
 * @typedef {Object} DiceResult
 * @property {number[]} normalRolls    - Individual values of normal dice
 * @property {number[]} hungerRolls    - Individual values of hunger dice
 * @property {number}   successes      - Total successes (including crit bonuses)
 * @property {number}   critPairs      - Number of crit pairs
 * @property {boolean}  messyCritical  - Crit pair involved a Hunger 10
 * @property {boolean}  bestialFailure - Hunger 1 present AND 0 successes
 */
export function roll(poolSize, hungerDice = 0) {
  hungerDice = Math.max(0, Math.min(hungerDice, poolSize));
  const normalCount = poolSize - hungerDice;

  const normalRolls = Array.from({ length: normalCount }, d10);
  const hungerRolls = Array.from({ length: hungerDice }, d10);

  return evaluate(normalRolls, hungerRolls);
}

/**
 * Evaluate pre-rolled dice values. Useful for tests with fixed inputs.
 *
 * @param {number[]} normalRolls
 * @param {number[]} hungerRolls
 * @returns {DiceResult}
 */
export function evaluate(normalRolls, hungerRolls) {
  let rawSuccesses = 0;
  let normalTens = 0;
  let hungerTens = 0;
  let hasBeastialOne = false;

  for (const r of normalRolls) {
    if (r >= 6) rawSuccesses++;
    if (r === 10) normalTens++;
  }

  for (const r of hungerRolls) {
    if (r >= 6) rawSuccesses++;
    if (r === 10) hungerTens++;
    if (r === 1) hasBeastialOne = true;
  }

  const totalTens = normalTens + hungerTens;
  const critPairs = Math.floor(totalTens / 2);

  // Each pair adds 2 bonus successes on top of the 2 already counted from the 10s themselves
  const successes = rawSuccesses + critPairs * 2;

  const messyCritical = critPairs > 0 && hungerTens > 0;
  const bestialFailure = hasBeastialOne && successes === 0;

  return {
    normalRolls,
    hungerRolls,
    successes,
    critPairs,
    messyCritical,
    bestialFailure,
    // Convenience: all rolls together
    allRolls: [...normalRolls, ...hungerRolls],
  };
}

// ─── Opposed roll ─────────────────────────────────────────────────────────────

/**
 * Opposed roll: attacker vs. defender.
 *
 * @param {number} attackPool
 * @param {number} attackHunger
 * @param {number} defensePool
 * @param {number} defenseHunger
 * @returns {OpposedResult}
 *
 * @typedef {Object} OpposedResult
 * @property {DiceResult} attacker
 * @property {DiceResult} defender
 * @property {number}     netSuccesses  - attacker.successes - defender.successes (min 0)
 * @property {boolean}    attackerWins
 */
export function opposed(attackPool, attackHunger, defensePool, defenseHunger) {
  const attacker = roll(attackPool, attackHunger);
  const defender = roll(defensePool, defenseHunger);
  const net = attacker.successes - defender.successes;

  return {
    attacker,
    defender,
    netSuccesses: Math.max(0, net),
    attackerWins: net > 0,
  };
}

// ─── Willpower re-roll ────────────────────────────────────────────────────────

/**
 * Re-roll specific normal dice in an existing DiceResult.
 * Hunger dice are never touched.
 *
 * @param {DiceResult} result   - The original roll
 * @param {number[]}   indices  - Up to 3 indices into result.normalRolls
 * @returns {DiceResult}        - New result with the selected dice re-rolled
 */
export function rerollNormal(result, indices) {
  const newNormal = [...result.normalRolls];
  for (const i of indices.slice(0, 3)) {
    if (i >= 0 && i < newNormal.length) newNormal[i] = d10();
  }
  return evaluate(newNormal, result.hungerRolls);
}

// ─── Namespace export (matches import style used elsewhere) ───────────────────

/** Convenience namespace so callers can do: DiceEngine.roll() */
export const DiceEngine = { roll, evaluate, opposed, rerollNormal, setRandomFn };
export default DiceEngine;
