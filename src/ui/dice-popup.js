/**
 * Dice Roll Popup
 * Zeigt nach jeder Resolution die Würfelergebnisse visuell an.
 */

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/dice-popup.html`;

export class DiceRollPopup extends Application {
  /**
   * @param {CombatResult[]} results
   * @param {Map<string,Participant>} participants
   */
  constructor(results, participants, options = {}) {
    super(options);
    this.results      = results;
    this.participants = participants;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'vtm-dice-popup',
      title:     'Würfelergebnisse',
      template:  TEMPLATE,
      width:     560,
      height:    'auto',
      classes:   ['vtm-dice-popup'],
    });
  }

  getData() {
    // Filtere nur Angriffe (haben dice rolls)
    const rolls = this.results
      .filter(r => r.attackRoll)
      .map(r => ({
        ...r,
        attackerName: r.attackerName ?? this.participants.get(r.attackerId)?.name ?? r.attackerId,
        defenderName: r.defenderName ?? (r.defenderId ? this.participants.get(r.defenderId)?.name : null),
        atkNormalDice: (r.attackRoll.normalRolls ?? []).map(v => ({
          value: v,
          cls:   this._dieClass(v, false),
        })),
        atkHungerDice: (r.attackRoll.hungerRolls ?? []).map(v => ({
          value: v,
          cls:   this._dieClass(v, true),
        })),
        defNormalDice: r.defenseRoll
          ? (r.defenseRoll.normalRolls ?? []).map(v => ({ value: v, cls: this._dieClass(v, false) }))
          : [],
        defHungerDice: r.defenseRoll
          ? (r.defenseRoll.hungerRolls ?? []).map(v => ({ value: v, cls: this._dieClass(v, true) }))
          : [],
        hasDefense:    !!r.defenseRoll,
        poolLine:      this._poolLine(r.breakdown?.attack),
        defPoolLine:   this._poolLine(r.breakdown?.defense),
        dmgLabel:      r.damageType === 'aggravated' ? 'aggraviiert' : 'oberflächlich',
        isAggravated:  r.damageType === 'aggravated',
        isMessy:       r.attackRoll.messyCritical,
        isBestial:     r.attackRoll.bestialFailure,
      }));

    return { rolls };
  }

  _dieClass(value, isHunger) {
    const n = Number(value);
    if (n === 10) return isHunger ? 'die-hunger-crit' : 'die-crit';
    if (n === 1  && isHunger) return 'die-bestial';
    if (n >= 6)  return 'die-success';
    return 'die-fail';
  }

  _poolLine(breakdown) {
    if (!breakdown) return '';
    const parts = [
      `${breakdown.attrName}(${breakdown.attrVal})`,
      `${breakdown.skillName}(${breakdown.skillVal})`,
    ];
    if (breakdown.potence)  parts.push(`Potenz(${breakdown.potence})`);
    if (breakdown.celerity) parts.push(`Celerity(1)`);
    return `${parts.join(' + ')} = ${breakdown.total} Würfel (${breakdown.hungerDice}× Hunger)`;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="close-popup"]').on('click', () => this.close());
  }
}
