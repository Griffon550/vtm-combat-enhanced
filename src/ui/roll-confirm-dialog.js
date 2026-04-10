/**
 * Roll Confirm Dialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Zeigt dem Spieler eine Aktionsübersicht bevor gewürfelt wird.
 * Buttons: Würfeln · Zurückhalten · Abbrechen
 *
 * Verwendung:
 *   const decision = await RollConfirmDialog.open(rollInfo);
 *   // decision: 'roll' | 'hold' | 'abort'
 *
 * rollInfo = {
 *   participantId: string,
 *   name:          string,
 *   img:           string,
 *   actionLabel:   string,
 *   targetLabel:   string,    // kommagetrennte Zielnamen
 *   isAttack:      boolean,
 *   normalDice:    number,
 *   hungerDice:    number,
 *   totalDice:     number,
 *   splitNote:     string,    // z.B. "Pool 8 ÷ 2 Ziele"
 *   narrativeHint: string,    // für nicht-Angriffe
 *   isHeld:        boolean,   // zweite Runde → kein "Zurückhalten"-Button
 * }
 */

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/roll-confirm-dialog.html`;

export class RollConfirmDialog extends Application {
  /**
   * @param {Object} params
   * @param {Object}   params.rollInfo
   * @param {Function} params.onDecide  callback('roll'|'hold'|'abort')
   */
  constructor({ rollInfo, onDecide }, options = {}) {
    super(options);
    this.rollInfo  = rollInfo;
    this._onDecide = onDecide;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      // Kein festes 'id' — Foundry generiert pro Instanz eine eindeutige App-ID.
      // Eine feste ID würde bei mehreren aufeinanderfolgenden Dialogen (z.B. Multi-Target)
      // dazu führen, dass der zweite render(true) die alte Instanz reaktiviert,
      // deren _onDecide bereits null ist → Promise löst nie auf.
      title:     'Würfeln bestätigen',
      template:  TEMPLATE,
      width:     460,
      height:    'auto',
      classes:   ['vtm-roll-confirm'],
      resizable: false,
    });
  }

  getData() {
    return {
      rollInfo: this.rollInfo,
      isHeld:   this.rollInfo.isHeld ?? false,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="roll"]').on('click',  () => this._decide('roll'));
    html.find('[data-action="hold"]').on('click',  () => this._decide('hold'));
    html.find('[data-action="abort"]').on('click', () => this._decide('abort'));
  }

  _decide(decision) {
    if (!this._onDecide) return;
    const fn = this._onDecide;
    this._onDecide = null; // prevent double-call on close
    fn(decision);
    this.close();
  }

  // Schließen ohne Entscheidung → gilt als Abbrechen
  async close(options = {}) {
    if (this._onDecide) {
      const fn = this._onDecide;
      this._onDecide = null;
      fn('abort');
    }
    return super.close(options);
  }

  /**
   * Promise-Wrapper: öffnet den Dialog, wartet auf Entscheidung.
   * @param {Object} rollInfo
   * @returns {Promise<'roll'|'hold'|'abort'>}
   */
  static open(rollInfo) {
    return new Promise((resolve) => {
      new RollConfirmDialog({ rollInfo, onDecide: resolve }).render(true);
    });
  }
}
