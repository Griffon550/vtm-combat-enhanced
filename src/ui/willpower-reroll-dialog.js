/**
 * Willpower Re-roll Dialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Zeigt dem Spieler nach einem Wurf die Möglichkeit, bis zu 3 normale Würfel
 * (keine Hunger-Würfel) durch Ausgeben von 1 Willpower neu zu würfeln.
 *
 * rerollInfo = {
 *   participantId:  string,
 *   name:           string,
 *   img:            string,
 *   normalRolls:    number[],
 *   hungerRolls:    number[],
 *   willpowerValue: number,   // verbleibende Willpower-Punkte
 *   willpowerMax:   number,
 * }
 *
 * onDecide callback: ({ spent: boolean, indices: number[] })
 *   spent   = true wenn Willpower ausgegeben wird
 *   indices = Indizes in normalRolls die neu gewürfelt werden sollen (max 3)
 */

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/willpower-reroll-dialog.html`;

function dieSymbol(value, isHunger) {
  if (value === 10)               return { cls: 'crit',    symbol: '★' };
  if (value >= 6)                 return { cls: 'success', symbol: '☥' };
  if (isHunger && value === 1)    return { cls: 'bestial', symbol: '☠' };
  return                                 { cls: 'fail',    symbol: '·' };
}

export class WillpowerRerollDialog extends Application {
  /**
   * @param {Object}   params
   * @param {Object}   params.rerollInfo
   * @param {Function} params.onDecide  callback({ spent, indices })
   */
  constructor({ rerollInfo, onDecide }, options = {}) {
    super(options);
    this.rerollInfo = rerollInfo;
    this._onDecide  = onDecide;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title:     'Willpower — Neu würfeln?',
      template:  TEMPLATE,
      width:     480,
      height:    'auto',
      classes:   ['vtm-willpower-reroll'],
      resizable: false,
    });
  }

  getData() {
    const { normalRolls, hungerRolls, opponentInfo } = this.rerollInfo;

    const opponentDice = opponentInfo ? [
      ...opponentInfo.normalRolls.map(v => ({ value: v, isHunger: false, ...dieSymbol(v, false) })),
      ...(opponentInfo.hungerRolls ?? []).map(v => ({ value: v, isHunger: true,  ...dieSymbol(v, true)  })),
    ] : null;

    return {
      rerollInfo:   this.rerollInfo,
      normalDice:   normalRolls.map((v, i) => ({ value: v, index: i, ...dieSymbol(v, false) })),
      hungerDice:   hungerRolls.map((v, i) => ({ value: v, index: i, ...dieSymbol(v, true)  })),
      hasNormalDice: normalRolls.length > 0,
      opponentName:  opponentInfo?.name ?? null,
      opponentDice,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Maximal 3 Checkboxen auswählen
    html.find('[name="reroll-die"]').on('change', () => {
      const checked = html.find('[name="reroll-die"]:checked');
      if (checked.length > 3) {
        // letztes gecheckte rückgängig machen
        html.find('[name="reroll-die"]:checked').last().prop('checked', false);
      }
      this._updateSpendButton(html);
    });

    html.find('[data-action="spend"]').on('click', () => {
      const indices = html.find('[name="reroll-die"]:checked')
        .map((_, el) => parseInt(el.value)).get();
      if (indices.length === 0) {
        ui.notifications?.warn('Bitte mindestens einen Würfel auswählen.');
        return;
      }
      this._decide({ spent: true, indices });
    });

    html.find('[data-action="keep"]').on('click', () => {
      this._decide({ spent: false, indices: [] });
    });
  }

  _updateSpendButton(html) {
    const count = html.find('[name="reroll-die"]:checked').length;
    const btn   = html.find('[data-action="spend"]');
    btn.prop('disabled', count === 0);
    btn.find('.vtm-reroll-count').text(count > 0 ? ` (${count})` : '');
  }

  _decide(decision) {
    if (!this._onDecide) return;
    const fn = this._onDecide;
    this._onDecide = null;
    fn(decision);
    this.close();
  }

  async close(options = {}) {
    if (this._onDecide) {
      const fn = this._onDecide;
      this._onDecide = null;
      fn({ spent: false, indices: [] });
    }
    return super.close(options);
  }

  /**
   * Promise-Wrapper: öffnet den Dialog, wartet auf Entscheidung.
   * @param {Object} rerollInfo
   * @returns {Promise<{ spent: boolean, indices: number[] }>}
   */
  static open(rerollInfo) {
    return new Promise((resolve) => {
      new WillpowerRerollDialog({ rerollInfo, onDecide: resolve }).render(true);
    });
  }
}
