/**
 * VTM Combat Enhanced — Logger
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure JavaScript, zero Foundry dependencies.
 * Enabled via the "Debug Logging" module setting in Foundry.
 *
 * Usage:
 *   import { Log } from './logger.js';
 *   Log.debug('some message');
 *   Log.roll('Angriff Klaus', 5, 1, diceResult);
 *   Log.pool('Angriffspool', breakdown);
 *   Log.group('Runde 1 Auflösung');
 *   Log.groupEnd();
 */

const PREFIX = 'vtm-combat';

class VTMLogger {
  constructor() {
    this._debug = false;
  }

  setDebug(enabled) {
    this._debug = !!enabled;
    if (enabled) console.info(`${PREFIX} | ✔ Debug-Logging aktiviert — alle Würfe und Berechnungen werden protokolliert.`);
  }

  get isDebug() { return this._debug; }

  // ─── Basic levels ──────────────────────────────────────────────────────────

  debug(...args) { if (this._debug) console.debug(`${PREFIX} |`, ...args); }
  info (...args) { console.info  (`${PREFIX} |`, ...args); }
  warn (...args) { console.warn  (`${PREFIX} |`, ...args); }
  error(...args) { console.error (`${PREFIX} |`, ...args); }

  // ─── Grouping ──────────────────────────────────────────────────────────────

  /** Open a collapsible console group (no-op if debug is off). */
  group(label) {
    if (this._debug) console.group(`${PREFIX} | ${label}`);
  }

  /** Open a pre-collapsed console group (no-op if debug is off). */
  groupCollapsed(label) {
    if (this._debug) console.groupCollapsed(`${PREFIX} | ${label}`);
  }

  groupEnd() {
    if (this._debug) console.groupEnd();
  }

  // ─── Structured helpers ────────────────────────────────────────────────────

  /**
   * Log a dice pool breakdown.
   *
   * @param {string} label    e.g. 'Angriffspool' or 'Verteidigungspool'
   * @param {Object} bd       Breakdown from _getAttackPool / _getDefensePool
   */
  pool(label, bd) {
    if (!this._debug) return;
    const parts = [];
    if (bd.attrName  != null) parts.push(`${bd.attrName}(${bd.attrVal ?? '?'})`);
    if (bd.skillName != null) parts.push(`${bd.skillName}(${bd.skillVal ?? 0})`);
    if (bd.impaired       > 0) parts.push(`-${bd.impaired} IMPAIRED`);
    if (bd.rangedPenalty  > 0) parts.push(`-${bd.rangedPenalty} Fernkampf`);
    if (bd.fleetnessDice  > 0) parts.push(`+${bd.fleetnessDice} Fleetness`);
    if (bd.multiDefPenalty > 0) parts.push(`-${bd.multiDefPenalty} MultiDef`);
    if ((bd.splitCount ?? 0) > 1) parts.push(`÷${bd.splitCount} Split`);
    if ((bd.autoSuccesses ?? 0) > 0) parts.push(`+${bd.autoSuccesses} AutoErfolge`);
    console.debug(
      `${PREFIX} |    📊 ${label}: ${parts.join(' + ')} = ${bd.total} Würfel` +
      ` (${bd.hungerDice ?? 0} Hunger)`
    );
  }

  /**
   * Log a V5 dice result with readable die faces.
   *
   * @param {string}     label    e.g. 'Klaus Angriff'
   * @param {number}     pool     total dice rolled
   * @param {number}     hunger   hunger dice count
   * @param {DiceResult} result   from dice-engine evaluate/roll
   */
  roll(label, pool, hunger, result) {
    if (!this._debug) return;

    const normal  = result.normalRolls ?? [];
    const hungerD = result.hungerRolls ?? [];

    // Format dice faces — hunger dice get a * suffix; hunger 1 gets !, hunger 10 gets ⚡
    const fmtNormal = normal.map(d => d >= 6 ? `\x1b[32m${d}\x1b[0m` : String(d));
    const fmtHunger = hungerD.map(d => {
      if (d === 1)  return '1!*';
      if (d === 10) return '10⚡*';
      return `${d >= 6 ? d + '✓' : d}*`;
    });

    // Plain-text versions for readability
    const plainNormal = normal.map(d => d === 10 ? '10' : String(d));
    const plainHunger = hungerD.map(d => {
      if (d === 1)  return '1!';
      if (d === 10) return '10⚡';
      return `${d}*`;
    });
    const allDice = [...plainNormal, ...plainHunger].join(', ');

    const flags = [];
    if ((result.critPairs ?? 0) > 0)  flags.push(`${result.critPairs}× Krit (+${result.critPairs * 2})`);
    if (result.messyCritical)          flags.push('⚠ Messy Critical');
    if (result.bestialFailure)         flags.push('💀 Bestial Failure');
    const flagStr = flags.length ? `  ← ${flags.join(' | ')}` : '';

    console.debug(
      `${PREFIX} |    🎲 ${label}: Pool ${pool} (${hunger}× Hunger)` +
      ` → ${result.successes} Erfolge  [${allDice}]${flagStr}`
    );
  }

  /**
   * Log the outcome of an interaction (net successes, damage).
   *
   * @param {string} attackerName
   * @param {string|null} defenderName
   * @param {number} atkSuccesses
   * @param {number} defSuccesses
   * @param {number} netSuccesses
   * @param {number} rawDamage
   * @param {number} actualDamage
   * @param {string|null} damageType
   */
  outcome(attackerName, defenderName, atkSuccesses, defSuccesses, netSuccesses, rawDamage, actualDamage, damageType) {
    if (!this._debug) return;
    const vsStr = defenderName ? ` vs. ${defenderName}` : '';
    const dmgStr = actualDamage > 0
      ? `  →  Schaden: ${rawDamage} roh → ${actualDamage} ${damageType ?? ''}`
      : '  →  kein Schaden';
    console.debug(
      `${PREFIX} |    📋 ${attackerName}${vsStr}: ${atkSuccesses} - ${defSuccesses} = ${netSuccesses} Netto${dmgStr}`
    );
  }

  /**
   * Log a raw WOD5E roll request (what was sent to the WOD5E API).
   * Called in combat-modal.js before _wod5eRoll.
   */
  wod5eRequest(title, basicDice, advancedDice) {
    if (!this._debug) return;
    console.debug(
      `${PREFIX} |    🌀 WOD5E-Würfelaufruf: "${title}" — ${basicDice} Normal + ${advancedDice} Hunger`
    );
  }

  /**
   * Log the raw dice values returned by WOD5E.
   */
  wod5eResult(title, normalRolls, hungerRolls) {
    if (!this._debug) return;
    const plain = [...normalRolls.map(String), ...hungerRolls.map(d => `${d}*`)].join(', ');
    console.debug(`${PREFIX} |    ✅ WOD5E-Ergebnis: "${title}" — [${plain}]`);
  }
}

export const Log = new VTMLogger();
