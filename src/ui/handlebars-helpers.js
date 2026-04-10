/**
 * Handlebars Helpers
 * Registered once during module init.
 * All helpers are pure functions — no Foundry dependencies beyond registration.
 */

import { ActionType } from '../combat-engine.js';

const ACTION_LABELS = {
  attack_unarmed:         'Unbewaffnet (Str)',
  attack_unarmed_finesse: 'Unbewaffnet (Dex)',
  attack_light:           'Leichte Waffe',
  attack_heavy:           'Schwere Waffe',
  attack_ranged:          'Fernkampf',
  attack_aimed:           'Gezielt',
  attack_melee:           'Nahkampf',
  dominate_compel:        'Compel',
  defend:                 'Parieren',
  dodge:                  'Ausweichen',
  special:                'Sonderaktion',
  pass:                   'Passen',
};

export function registerHelpers() {
  // Handlebars.registerHelper is a global in Foundry
  const H = Handlebars;

  // Equality check — registered as value helper so it works both as
  // subexpression {{#if (eq a b)}} AND standalone {{eq a b}}.
  // Do NOT register as block helper — wod5e uses eq as a subexpression helper,
  // and registering it as a block helper (options.fn/options.inverse) breaks all wod5e sheets.
  H.registerHelper('eq',  (a, b) => a === b);
  H.registerHelper('gt',  (a, b) => a >  b);
  H.registerHelper('lt',  (a, b) => a <  b);

  // Human-readable action label
  H.registerHelper('intentLabel', (actionType) => {
    return ACTION_LABELS[actionType] ?? actionType ?? '—';
  });

  // Find a participant name from the session (passed via context)
  // Usage: {{targetName intent.targetId}} — falls back to the raw ID
  H.registerHelper('targetName', function (targetId) {
    if (!targetId) return '';
    // Try to find in Handlebars context (data root)
    const participants = this?.participants ?? [];
    const found = participants.find(p => p.id === targetId);
    return found ? found.name : targetId;
  });

  // Build an array of N items for pip loops
  H.registerHelper('healthPips', (max) => {
    return Array.from({ length: Number(max) || 10 }, (_, i) => i);
  });

  H.registerHelper('hungerPips', () => {
    return Array.from({ length: 5 }, (_, i) => i);
  });

  // Determine pip fill state for health/willpower tracks
  // Returns 'vtm-pip-superficial', 'vtm-pip-aggravated', or '' (empty)
  // track = { max, superficial, aggravated }
  H.registerHelper('trackPipClass', (track, index) => {
    const max = Number(track?.max ?? 0);
    const agg = Number(track?.aggravated  ?? 0);
    const sup = Number(track?.superficial ?? 0);
    const emptyCount = Math.max(0, max - agg - sup);
    if (index < emptyCount)              return '';
    if (index < emptyCount + sup)        return 'vtm-pip-superficial';
    return 'vtm-pip-aggravated';
  });

  /**
   * Rendert eine Reihe von WoD5e-Würfelboxen als HTML.
   * Normale Würfel = schwarz, Hungerwürfel = rot.
   * Symbole: ☥ Erfolg · ★ Krit · ☠ Totenkopf (Hunger-1) · · Misserfolg
   * Verwendung: {{{diceBoxes normalRolls hungerRolls}}}
   */
  H.registerHelper('diceBoxes', (normalRolls, hungerRolls) => {
    const parts = [];

    const box = (value, isHunger) => {
      let cls, symbol;
      if (value === 10) {
        cls = 'crit';   symbol = '★';
      } else if (value >= 6) {
        cls = 'success'; symbol = '☥';
      } else if (isHunger && value === 1) {
        cls = 'bestial'; symbol = '☠';
      } else {
        cls = 'fail';   symbol = '·';
      }
      const type = isHunger ? 'hunger' : 'normal';
      return `<span class="vtm-log-die vtm-log-die-${type} vtm-log-die-${cls}" title="${value}">${symbol}</span>`;
    };

    for (const v of (normalRolls ?? [])) parts.push(box(v, false));
    for (const v of (hungerRolls ?? [])) parts.push(box(v, true));

    return new Handlebars.SafeString(
      `<span class="vtm-log-dice">${parts.join('')}</span>`
    );
  });

  /**
   * Baut eine lesbare Schadensformel aus den bereits im Log-Eintrag vorhandenen Werten.
   * Keine Neuberechnung — nur Darstellung vorhandener Daten.
   * Beispiele:
   *   "4 Netto → ÷2 sup = 2"
   *   "3 Netto + 2 Waffe → ÷2 sup = 3"
   *   "5 Netto + 1 Waffe = 6 agg"
   *   "geblockt"
   */
  H.registerHelper('damageFormula', (entry) => {
    if (!entry || !entry.attackRoll) return '';
    const net         = entry.netSuccesses      ?? 0;
    const raw         = entry.rawDamage         ?? 0;
    const actual      = entry.damage            ?? 0;
    const type        = entry.damageType        ?? '';
    const prowessBonus = entry.prowessDamageBonus ?? 0;

    if (net === 0 || raw === 0) return 'geblockt';

    // raw = net + prowessBonus + weaponBonus
    const weaponBonus = Math.max(0, raw - net - prowessBonus);
    const parts = [`${net} Netto`];
    if (prowessBonus > 0) parts.push(`+ ${prowessBonus} Prowess`);
    if (weaponBonus  > 0) parts.push(`+ ${weaponBonus} Waffe`);

    let formula = parts.join(' ');

    if (actual < raw) {
      if (type === 'superficial') {
        formula += ' ÷2 (Vampir)';
      } else {
        formula += ` −${raw - actual} Red.`;
      }
    }

    formula += ` = ${actual}`;

    if (type === 'aggravated') formula += ' agg';
    else                       formula += ' sup';

    return formula;
  });

  // Legacy — kept for any other usage
  H.registerHelper('pipClass', (currentValue, index) => {
    return index < Number(currentValue) ? 'filled' : '';
  });

  H.registerHelper('hungerPipClass', (hunger, index) => {
    return index < Number(hunger) ? 'filled' : '';
  });

  // Status → CSS class
  H.registerHelper('statusClass', (statusEffects) => {
    if (!statusEffects?.length) return '';
    const priority = ['torpor', 'disabled', 'impaired', 'dominated'];
    for (const s of priority) {
      if (statusEffects.includes(s)) return `vtm-status-${s}`;
    }
    return '';
  });
}
