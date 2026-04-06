/**
 * Action Dialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Zeigt dem Spieler alle wählbaren Aktionen + aktivierbare Disziplinkräfte.
 * Baut `intent.activePowers[]` statt alter `modifiers`-Objekte.
 */

import { ActionType }        from '../combat-engine.js';
import { DISCIPLINE_POWERS } from '../disciplines/discipline-powers.js';

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/action-dialog.html`;

// Angriffs-Aktionstypen für Template-Bedingung
const ATTACK_TYPES = new Set([
  ActionType.ATTACK_UNARMED,
  ActionType.ATTACK_LIGHT,
  ActionType.ATTACK_HEAVY,
  ActionType.ATTACK_RANGED,
  ActionType.ATTACK_AIMED,
  ActionType.ATTACK_MELEE,
]);

export class ActionDialog extends Application {
  /**
   * @param {Object} params
   * @param {Participant}   params.participant  Charakter, der wählt
   * @param {Participant[]} params.targets       Alle verfügbaren Ziele
   * @param {(intent: Intent) => void} params.onConfirm
   */
  constructor({ participant, targets, onConfirm, existingIntent = null }, options = {}) {
    super(options);
    this.participant = participant;
    this.targets     = targets;
    this.onConfirm   = onConfirm;

    const ex = existingIntent;
    this._intent = {
      actionType:     ex?.actionType     ?? ActionType.ATTACK_UNARMED,
      targetId:       ex?.targetId       ?? targets.find(t => t.side !== participant.side)?.id ?? null,
      activePowers:   ex?.activePowers   ? [...ex.activePowers] : [],
      disciplineUsed: ex?.disciplineUsed ?? null,
      specialAction:  ex?.specialAction  ?? '',
      weapon:         ex?.weapon         ?? null,
    };
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'vtm-action-dialog',
      title:     'Aktion wählen',
      template:  TEMPLATE,
      width:     440,
      height:    'auto',
      classes:   ['vtm-action-dialog'],
      resizable: false,
    });
  }

  getData() {
    const at = this._intent.actionType;

    // ── Aktivierbare und passive Kräfte trennen ──────────────────────────────
    const activatablePowers = [];
    const passivePowers     = [];

    for (const [discName, discData] of Object.entries(this.participant.disciplines ?? {})) {
      const rating      = typeof discData === 'object' ? (discData.rating ?? 0)      : (discData ?? 0);
      const knownPowers = typeof discData === 'object' ? (discData.knownPowers ?? []) : [];
      if (!rating) continue;

      for (const powerName of knownPowers) {
        const power = DISCIPLINE_POWERS[powerName];
        if (!power) continue;

        if (power.activation === 'passive') {
          passivePowers.push({
            name:       powerName,
            discipline: discName,
            level:      power.level,
            timing:     power.timing,
            notes:      power.notes,
          });
        } else {
          activatablePowers.push({
            name:       powerName,
            discipline: discName,
            level:      power.level,
            type:       power.type,
            activation: power.activation,
            notes:      power.notes,
            checked:    this._intent.activePowers.includes(powerName),
          });
        }
      }
    }

    return {
      participant:      this.participant,
      targets:          this.targets.filter(t => t.id !== this.participant.id),
      intent:           this._intent,

      // Template-Flags
      isAttack:         ATTACK_TYPES.has(at),
      isDefensive:      at === ActionType.DEFEND || at === ActionType.DODGE,
      isDiscipline:     at === ActionType.DISCIPLINE,
      isSpecial:        at === ActionType.SPECIAL,

      // Disziplinen (für altes Discipline-Picker-Feld, falls noch genutzt)
      hasDisciplines:   activatablePowers.length > 0 || passivePowers.length > 0,
      activatablePowers,
      passivePowers,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // ── Aktionstyp ────────────────────────────────────────────────────────────
    html.find('[name="actionType"]').on('change', ev => {
      this._intent.actionType    = ev.target.value;
      this._intent.disciplineUsed = null;
      this._intent.specialAction  = '';
      this.render(false);
    });

    // ── Ziel ──────────────────────────────────────────────────────────────────
    html.find('[name="targetId"]').on('change', ev => {
      this._intent.targetId = ev.target.value || null;
    });

    // ── Disziplinkraft aktivieren/deaktivieren ────────────────────────────────
    html.find('[name="activePower"]').on('change', ev => {
      const name = ev.target.value;
      if (ev.target.checked) {
        if (!this._intent.activePowers.includes(name)) {
          this._intent.activePowers.push(name);
        }
      } else {
        this._intent.activePowers = this._intent.activePowers.filter(p => p !== name);
      }
    });

    // ── Discipline-Picker (für DISCIPLINE-Aktion) ─────────────────────────────
    html.find('[name="disciplineUsed"]').on('change', ev => {
      this._intent.disciplineUsed = ev.target.value || null;
    });

    // ── Waffe (freies Textfeld) ───────────────────────────────────────────────
    html.find('[name="weaponName"]').on('input', ev => {
      this._intent.weapon = this._intent.weapon ?? {};
      this._intent.weapon.name = ev.target.value;
    });
    html.find('[name="weaponDamageBonus"]').on('change', ev => {
      this._intent.weapon = this._intent.weapon ?? {};
      this._intent.weapon.damageBonus = parseInt(ev.target.value) || 0;
    });
    html.find('[name="weaponDamageType"]').on('change', ev => {
      this._intent.weapon = this._intent.weapon ?? {};
      this._intent.weapon.damageType = ev.target.value || null;
    });

    // ── Sonderaktion ──────────────────────────────────────────────────────────
    html.find('[name="specialAction"]').on('input', ev => {
      this._intent.specialAction = ev.target.value;
    });

    // ── Buttons ───────────────────────────────────────────────────────────────
    html.find('[data-action="confirm"]').on('click', () => this._confirmIntent());
    html.find('[data-action="cancel"]').on('click',  () => this.close());
  }

  _confirmIntent() {
    if (this._intent.actionType === ActionType.DISCIPLINE && !this._intent.disciplineUsed) {
      ui.notifications?.warn('Bitte eine Disziplin wählen.');
      return;
    }
    if (this._intent.actionType === ActionType.SPECIAL && !this._intent.specialAction?.trim()) {
      ui.notifications?.warn('Bitte die Sonderaktion beschreiben.');
      return;
    }

    // Bereinige leere Waffeneinträge
    const weapon = this._intent.weapon;
    const cleanWeapon = (weapon?.name?.trim())
      ? { name: weapon.name.trim(), damageBonus: weapon.damageBonus ?? 0, damageType: weapon.damageType ?? null }
      : null;

    this.onConfirm({
      ...this._intent,
      activePowers: [...this._intent.activePowers],
      weapon:       cleanWeapon,
    });
    this.close();
  }
}
