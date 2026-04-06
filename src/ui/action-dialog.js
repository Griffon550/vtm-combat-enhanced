/**
 * Action Dialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Popup that lets a player choose their intent for the current round.
 * Extends Foundry's Application — only runs inside Foundry.
 */

import { ActionType } from '../combat-engine.js';

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/action-dialog.html`;

export class ActionDialog extends Application {
  /**
   * @param {Object} params
   * @param {Participant}   params.participant  The actor choosing an action
   * @param {Participant[]} params.targets       All possible targets
   * @param {(intent: Intent) => void} params.onConfirm  Called with the chosen intent
   */
  constructor({ participant, targets, onConfirm }, options = {}) {
    super(options);
    this.participant = participant;
    this.targets     = targets;
    this.onConfirm   = onConfirm;

    // Draft intent — mutated as the user interacts with the form
    this._intent = {
      actionType:     ActionType.ATTACK_MELEE,
      targetId:       targets.find(t => t.side !== participant.side)?.id ?? targets[0]?.id ?? null,
      modifiers:      {},
      disciplineUsed: null,
      specialAction:  '',
      weapon: {
        name:        '',
        damageBonus: 0,
        damageType:  null, // null = default, 'aggravated' = override
      },
    };
  }

  // ─── Foundry Application overrides ────────────────────────────────────────

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:       'vtm-action-dialog',
      title:    'Choose Action',
      template: TEMPLATE,
      width:    420,
      height:   'auto',
      classes:  ['vtm-action-dialog'],
      resizable: false,
    });
  }

  getData() {
    const hasDisciplines = Object.values(this.participant.disciplines ?? {}).some(v => v > 0);

    return {
      participant: this.participant,
      targets:     this.targets.filter(t => t.id !== this.participant.id),
      intent:      this._intent,
      actionTypes: ActionType,

      // Only show disciplines the character actually has
      disciplines: Object.entries(this.participant.disciplines ?? {})
        .filter(([, v]) => v > 0)
        .map(([key, value]) => ({
          key,
          value,
          label: key.charAt(0).toUpperCase() + key.slice(1),
        })),

      hasDisciplines,

      // Derived flags for template conditionals
      isAttack:     this._intent.actionType === ActionType.ATTACK_MELEE ||
                    this._intent.actionType === ActionType.ATTACK_RANGED,
      isDiscipline: this._intent.actionType === ActionType.DISCIPLINE,
      isSpecial:    this._intent.actionType === ActionType.SPECIAL,
      isDefensive:  this._intent.actionType === ActionType.DEFEND ||
                    this._intent.actionType === ActionType.DODGE,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // ── Action type selection ──────────────────────────────────────────────
    html.find('[name="actionType"]').on('change', ev => {
      this._intent.actionType = ev.target.value;
      // Reset discipline / special when switching types
      this._intent.disciplineUsed = null;
      this._intent.specialAction  = '';
      this.render(false);
    });

    // ── Target selection ───────────────────────────────────────────────────
    html.find('[name="targetId"]').on('change', ev => {
      this._intent.targetId = ev.target.value || null;
    });

    // ── Discipline picker ──────────────────────────────────────────────────
    html.find('[name="disciplineUsed"]').on('change', ev => {
      this._intent.disciplineUsed = ev.target.value || null;
    });

    // ── Modifiers ──────────────────────────────────────────────────────────
    html.find('[name="celerity"]').on('change', ev => {
      this._intent.modifiers.celerity = ev.target.checked;
    });

    html.find('[name="potence"]').on('change', ev => {
      this._intent.modifiers.potence = parseInt(ev.target.value) || 0;
    });

    html.find('[name="fortitude"]').on('change', ev => {
      this._intent.modifiers.fortitude = parseInt(ev.target.value) || 0;
    });

    // ── Special action text ────────────────────────────────────────────────
    html.find('[name="specialAction"]').on('input', ev => {
      this._intent.specialAction = ev.target.value;
    });

    html.find('[name="weaponName"]').on('input', ev => {
      this._intent.weapon.name = ev.target.value;
    });
    html.find('[name="weaponDamageBonus"]').on('change', ev => {
      this._intent.weapon.damageBonus = parseInt(ev.target.value) || 0;
    });
    html.find('[name="weaponDamageType"]').on('change', ev => {
      this._intent.weapon.damageType = ev.target.value || null;
    });

    // ── Buttons ────────────────────────────────────────────────────────────
    html.find('[data-action="confirm"]').on('click', () => {
      this._confirmIntent();
    });

    html.find('[data-action="cancel"]').on('click', () => {
      this.close();
    });
  }

  _confirmIntent() {
    // Basic validation
    if (this._intent.actionType === ActionType.DISCIPLINE && !this._intent.disciplineUsed) {
      ui.notifications?.warn('Please choose a discipline.');
      return;
    }
    if (this._intent.actionType === ActionType.SPECIAL && !this._intent.specialAction?.trim()) {
      ui.notifications?.warn('Please describe the special action.');
      return;
    }

    this.onConfirm({ ...this._intent, modifiers: { ...this._intent.modifiers } });
    this.close();
  }
}
