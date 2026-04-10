/**
 * Action Dialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Zeigt dem Spieler alle wählbaren Aktionen.
 */

import { ActionType } from '../combat-engine.js';

// Blood Surge Bonus-Würfel je Blutpotenz (Index = Blutpotenz 0–10)
const SURGE_BONUS = [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];

// Aktionstyp → [Attributschlüssel, Skillschlüssel] für Pool-Vorschau
const POOL_MAP = {
  attack_unarmed:         ['strength',    'brawl'],
  attack_unarmed_finesse: ['dexterity',   'brawl'],
  attack_light:           ['dexterity',   'melee'],
  attack_heavy:           ['strength',    'melee'],
  attack_ranged:          ['dexterity',   'firearms'],
  attack_aimed:           ['wits',        'firearms'],
  attack_melee:           ['strength',    'melee'],
  // Dominate-Compel nutzt disciplines-Rang, nicht skills → Sonderbehandlung in getData()
};

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/action-dialog.html`;

// Angriffs-Aktionstypen für Template-Bedingung
const ATTACK_TYPES = new Set([
  ActionType.ATTACK_UNARMED,
  ActionType.ATTACK_UNARMED_FINESSE,
  ActionType.ATTACK_LIGHT,
  ActionType.ATTACK_HEAVY,
  ActionType.ATTACK_RANGED,
  ActionType.ATTACK_AIMED,
  ActionType.ATTACK_MELEE,
  ActionType.DOMINATE_COMPEL,
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
    // Standardziel: erster Gegner der anderen Seite
    const defaultTarget = targets.find(t => t.side !== participant.side);

    this._intent = {
      actionType:    ex?.actionType  ?? ActionType.ATTACK_UNARMED,
      targetIds:     ex?.targetIds   ? [...ex.targetIds]
                   : (ex?.targetId   ? [ex.targetId]
                   : (defaultTarget  ? [defaultTarget.id] : [])),
      targetId:      null, // wird on-the-fly aus targetIds[0] abgeleitet
      activePowers:  [],
      specialAction: ex?.specialAction ?? '',
      compelCommand: ex?.compelCommand ?? '',
      weapon:        ex?.weapon ?? null,
      bloodSurge:    ex?.bloodSurge ?? false,
      poolModifier:  ex?.poolModifier ?? 0,
    };
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'vtm-action-dialog',
      title:     'Aktion wählen',
      template:  TEMPLATE,
      width:     620,
      height:    'auto',
      classes:   ['vtm-action-dialog'],
      resizable: false,
    });
  }

  getData() {
    const at = this._intent.actionType;

    // ── Pool-Vorschau ─────────────────────────────────────────────────────────
    const isAtk      = ATTACK_TYPES.has(at);
    const isCompel   = at === ActionType.DOMINATE_COMPEL;
    const isDefense  = at === ActionType.DEFEND || at === ActionType.DODGE;
    const poolKeys   = POOL_MAP[at];
    let poolTotal    = 0;
    let poolPerTarget = 0;

    const isVampire    = this.participant.bloodPotency !== null && this.participant.bloodPotency !== undefined;
    const bloodPotency = isVampire ? (this.participant.bloodPotency ?? 0) : 0;
    const surgeDice    = isVampire ? (SURGE_BONUS[Math.min(bloodPotency, 10)] ?? 1) : 0;

    const modifier = this._intent.poolModifier ?? 0;

    const surge = (isVampire && this._intent.bloodSurge) ? surgeDice : 0;

    if (isCompel) {
      const p        = this.participant;
      const charisma = p.attributes?.charisma          ?? 1;
      const dominate = p.disciplines?.dominate?.rating ?? 0;
      poolTotal      = Math.max(1, charisma + dominate + surge + modifier);
    } else if (isAtk && poolKeys) {
      const p        = this.participant;
      const attrVal  = p.attributes?.[poolKeys[0]] ?? 1;
      const skillVal = p.skills?.[poolKeys[1]]     ?? 0;
      poolTotal      = Math.max(1, attrVal + skillVal + surge + modifier);
    } else if (isDefense) {
      const p   = this.participant;
      const dex = p.attributes?.dexterity ?? 1;
      let skillVal = 0;
      if (at === ActionType.DEFEND) {
        skillVal = Math.max(p.skills?.melee ?? 0, p.skills?.brawl ?? 0);
      } else {
        skillVal = p.skills?.athletics ?? 0;
      }
      poolTotal = Math.max(1, dex + skillVal + surge + modifier);
    }

    const numTargets   = this._intent.targetIds.length || 1;
    const basePerTarget = isAtk ? Math.max(1, Math.floor(poolTotal / numTargets)) : 0;
    const remainder     = isAtk ? poolTotal % numTargets : 0;
    // Wenn Rest > 0: erste Ziele bekommen einen Würfel mehr
    poolPerTarget       = basePerTarget;
    this._poolRemainder = remainder; // für Template-Anzeige

    const eligibleTargets = this.targets
      .filter(t => t.id !== this.participant.id)
      .map(t => ({
        ...t,
        checked: this._intent.targetIds.includes(t.id),
      }));

    return {
      participant: { ...this.participant, hasCompel: (this.participant.disciplinePowers ?? []).includes('Compel') },
      targets:     eligibleTargets,
      intent:      this._intent,

      // Template-Flags
      isAttack:      isAtk,
      isDefensive:   at === ActionType.DEFEND || at === ActionType.DODGE,
      isSpecial:     at === ActionType.SPECIAL,
      isCompel:      isCompel,
      showBloodSurge: isVampire && (isAtk || isCompel || isDefense),

      // Blood Surge
      isVampire,
      bloodPotency,
      surgeDice,
      bloodSurge: this._intent.bloodSurge,

      // Pool-Vorschau
      poolTotal,
      poolPerTarget,
      poolPerTargetMax: remainder > 0 ? poolPerTarget + 1 : poolPerTarget,
      numTargets,
      showSplit:    isAtk && numTargets > 1,
      splitHasRest: isAtk && numTargets > 1 && remainder > 0,

      // Freier Modifikator
      poolModifier: modifier,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // ── Aktionstyp ────────────────────────────────────────────────────────────
    html.find('[name="actionType"]').on('change', ev => {
      this._intent.actionType   = ev.target.value;
      this._intent.specialAction = '';
      this.render(true);
    });

    // ── Ziele (Checkboxen) ────────────────────────────────────────────────────
    html.find('[name="targetId"]').on('change', ev => {
      const id = ev.target.value;
      if (ev.target.checked) {
        if (!this._intent.targetIds.includes(id)) this._intent.targetIds.push(id);
      } else {
        this._intent.targetIds = this._intent.targetIds.filter(t => t !== id);
      }
      this.render(false); // Pool-Vorschau aktualisieren
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

    // ── Blood Surge ────────────────────────────────────────────────────────────
    html.find('[name="bloodSurge"]').on('change', ev => {
      this._intent.bloodSurge = ev.target.checked;
      this.render(false);
    });

    // ── Sonderaktion ──────────────────────────────────────────────────────────
    html.find('[name="specialAction"]').on('input', ev => {
      this._intent.specialAction = ev.target.value;
    });

    // ── Compel-Befehl ─────────────────────────────────────────────────────────
    html.find('[name="compelCommand"]').on('input', ev => {
      this._intent.compelCommand = ev.target.value;
    });

    // ── Freier Pool-Modifikator ───────────────────────────────────────────────
    html.find('[name="poolModifier"]').on('change', ev => {
      this._intent.poolModifier = parseInt(ev.target.value) || 0;
      this.render(false);
    });

    // ── Buttons ───────────────────────────────────────────────────────────────
    html.find('[data-action="confirm"]').on('click', () => this._confirmIntent());
    html.find('[data-action="cancel"]').on('click',  () => this.close());
  }

  _confirmIntent() {
    if (this._intent.actionType === ActionType.SPECIAL && !this._intent.specialAction?.trim()) {
      ui.notifications?.warn('Bitte die Sonderaktion beschreiben.');
      return;
    }
    // Waffe übernehmen wenn Name ODER Schadensbonus angegeben
    const weapon = this._intent.weapon;
    const hasWeapon = weapon?.name?.trim() || (weapon?.damageBonus ?? 0) > 0 || weapon?.damageType;
    const cleanWeapon = hasWeapon
      ? { name: (weapon.name ?? '').trim() || 'Waffe', damageBonus: weapon.damageBonus ?? 0, damageType: weapon.damageType ?? null }
      : null;

    this.onConfirm({
      ...this._intent,
      targetId:     this._intent.targetIds[0] ?? null,
      targetIds:    [...this._intent.targetIds],
      activePowers: [],
      weapon:       cleanWeapon,
      bloodSurge:   this._intent.bloodSurge,
      compelCommand: this._intent.compelCommand ?? '',
      poolModifier:  this._intent.poolModifier  ?? 0,
    });
    this.close();
  }
}
