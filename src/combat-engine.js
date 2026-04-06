/**
 * VTM Combat Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure JavaScript — zero Foundry dependencies.
 * Import in Node/browser tests without any mock setup.
 *
 * Architecture:
 *   CombatSession  — session state machine (participants, phase, log)
 *   resolveAll()   — runs the full Resolution phase
 *   _resolveAttack / _resolveDiscipline — per-action resolution
 *
 * Dependency injection:
 *   Every method that needs dice accepts an optional `diceOverride` parameter:
 *     { roll: (pool, hunger) => DiceResult }
 *   Pass a stub in tests to get deterministic results.
 */

import { DiceEngine } from './dice/dice-engine.js';

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const CombatPhase = Object.freeze({
  SETUP:        'setup',
  INTENT:       'intent',
  RESOLUTION:   'resolution',
  STATE_UPDATE: 'state_update',
  DONE:         'done',
});

export const ActionType = Object.freeze({
  ATTACK_MELEE:  'attack_melee',
  ATTACK_RANGED: 'attack_ranged',
  DEFEND:        'defend',
  DODGE:         'dodge',
  DISCIPLINE:    'discipline',
  SPECIAL:       'special',
  PASS:          'pass',
});

export const DamageType = Object.freeze({
  SUPERFICIAL: 'superficial',
  AGGRAVATED:  'aggravated',
});

export const StatusEffect = Object.freeze({
  IMPAIRED:  'impaired',
  TORPOR:    'torpor',
  DISABLED:  'disabled',
  DOMINATED: 'dominated',  // 1-round effect from Dominate
});

// ─── Participant factory ───────────────────────────────────────────────────────

/**
 * Create a plain participant object from raw data.
 * All fields have safe defaults so the engine never throws on missing props.
 *
 * @param {Partial<ParticipantData>} data
 * @param {'players'|'enemies'} side
 * @returns {Participant}
 *
 * @typedef {Object} Participant
 * @property {string}                    id
 * @property {string}                    name
 * @property {string}                    img
 * @property {'players'|'enemies'}       side
 * @property {{ value:number, max:number }} health
 * @property {{ value:number, max:number }} willpower
 * @property {number}                    hunger
 * @property {number}                    initiative
 * @property {string[]}                  statusEffects
 * @property {Object.<string,number>}    disciplines
 * @property {Object.<string,number>}    attributes
 * @property {Object.<string,number>}    skills
 * @property {Intent|null}               intent
 */
export function createParticipant(data, side = 'players') {
  return {
    id:           data.id   ?? `actor-${Math.random().toString(36).slice(2)}`,
    name:         data.name ?? 'Unknown',
    img:          data.img  ?? '',
    side,
    health:       { value: 10, max: 10, ...data.health },
    willpower:    { value: 3,  max: 6,  ...data.willpower },
    hunger:       data.hunger        ?? 0,
    initiative:   data.initiative    ?? 0,
    statusEffects: Array.from(data.statusEffects ?? []),
    disciplines:  { celerity: 0, potence: 0, fortitude: 0, dominate: 0, ...data.disciplines },
    attributes:   { strength: 2, dexterity: 2, stamina: 2, charisma: 2, manipulation: 2, ...data.attributes },
    skills:       { brawl: 0, melee: 0, firearms: 0, athletics: 0, ...data.skills },
    intent:       null,
  };
}

// ─── CombatSession ────────────────────────────────────────────────────────────

export class CombatSession {
  constructor() {
    this.id    = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.phase = CombatPhase.SETUP;
    this.round = 0;

    /** @type {Map<string, Participant>} */
    this.participants = new Map();

    /** @type {CombatResult[]} */
    this.log = [];

    /**
     * Optional change listener. Called after every state mutation.
     * @type {((state: SessionState) => void)|null}
     */
    this.onUpdate = null;
  }

  // ─── Participant management ────────────────────────────────────────────────

  /**
   * @param {Partial<ParticipantData>} data
   * @param {'players'|'enemies'} side
   * @returns {Participant}
   */
  addParticipant(data, side) {
    const p = createParticipant(data, side);
    this.participants.set(p.id, p);
    this._notify();
    return p;
  }

  removeParticipant(id) {
    this.participants.delete(id);
    this._notify();
  }

  /** @returns {Participant|undefined} */
  getParticipant(id) {
    return this.participants.get(id);
  }

  /**
   * @param {'players'|'enemies'|null} side
   * @returns {Participant[]}
   */
  getParticipants(side = null) {
    const all = Array.from(this.participants.values());
    return side ? all.filter(p => p.side === side) : all;
  }

  /**
   * Returns active (non-incapacitated) participants sorted by initiative desc.
   * @returns {Participant[]}
   */
  getInitiativeOrder() {
    return Array.from(this.participants.values())
      .filter(p => !this._isIncapacitated(p))
      .sort((a, b) => b.initiative - a.initiative);
  }

  // ─── Initiative ────────────────────────────────────────────────────────────

  /**
   * Roll initiative for one participant.
   * Formula: Dexterity + 1d10
   *
   * @param {string} id
   * @param {{ d10?: () => number }} opts  override random for tests
   * @returns {{ participantId, dexterity, roll, total }}
   */
  rollInitiative(id, opts = {}) {
    const p = this._require(id);
    const dex  = p.attributes.dexterity ?? 2;
    const roll = opts.d10 ? opts.d10() : (Math.floor(Math.random() * 10) + 1);
    p.initiative = dex + roll;
    this._notify();
    return { participantId: id, dexterity: dex, roll, total: p.initiative };
  }

  /** Roll initiative for every participant. */
  rollAllInitiative(opts = {}) {
    return Array.from(this.participants.keys()).map(id => this.rollInitiative(id, opts));
  }

  // ─── Phase transitions ────────────────────────────────────────────────────

  setPhase(phase) {
    this.phase = phase;
    this._notify();
  }

  /** Begin the Intent phase and clear all previous intents. */
  startIntentPhase() {
    for (const p of this.participants.values()) p.intent = null;
    this.setPhase(CombatPhase.INTENT);
  }

  /** @returns {boolean} true when every active participant has an intent */
  allIntentsSet() {
    const active = Array.from(this.participants.values())
      .filter(p => !this._isIncapacitated(p));
    return active.length > 0 && active.every(p => p.intent !== null);
  }

  // ─── Intent ────────────────────────────────────────────────────────────────

  /**
   * Set the intent for a participant.
   *
   * @param {string} participantId
   * @param {Partial<Intent>} intent
   * @throws if called outside the INTENT phase
   *
   * @typedef {Object} Intent
   * @property {string}      actorId
   * @property {string}      actionType
   * @property {string|null} targetId
   * @property {Object}      modifiers    e.g. { celerity: true, potence: 2 }
   * @property {string|null} disciplineUsed
   * @property {string|null} specialAction
   */
  setIntent(participantId, intent) {
    if (this.phase !== CombatPhase.INTENT) {
      throw new Error('Cannot set intent outside of the Intent phase.');
    }
    const p = this._require(participantId);
    p.intent = {
      actorId:        participantId,
      actionType:     intent.actionType     ?? ActionType.PASS,
      targetId:       intent.targetId       ?? null,
      modifiers:      intent.modifiers      ?? {},
      disciplineUsed: intent.disciplineUsed ?? null,
      specialAction:  intent.specialAction  ?? null,
    };
    this._notify();
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  startResolutionPhase() {
    this.round++;
    this.setPhase(CombatPhase.RESOLUTION);
  }

  /**
   * Resolve all pending intents in initiative order.
   *
   * @param {{ roll: (pool:number, hunger:number) => DiceResult }|null} diceOverride
   *   Inject deterministic dice for unit tests.
   * @returns {CombatResult[]}
   *
   * @typedef {Object} CombatResult
   * @property {string}         attackerId
   * @property {string|null}    defenderId
   * @property {string}         actionType
   * @property {DiceResult|null} attackRoll
   * @property {DiceResult|null} defenseRoll
   * @property {number}         netSuccesses
   * @property {number}         rawDamage
   * @property {number}         damage          applied damage after modifiers
   * @property {string|null}    damageType
   * @property {string[]}       effects         status effect messages
   * @property {string}         narrative
   */
  resolveAll(diceOverride = null) {
    const results = [];
    const order   = this.getInitiativeOrder();

    for (const actor of order) {
      if (!actor.intent || actor.intent.actionType === ActionType.PASS) continue;
      if (this._isIncapacitated(actor)) continue;

      const result = this._resolveOne(actor, diceOverride);
      if (result) {
        results.push(result);
        this.log.push(result);
      }
    }

    this.setPhase(CombatPhase.STATE_UPDATE);
    return results;
  }

  /** Resolve a single actor's intent. */
  _resolveOne(actor, dice) {
    const { actionType } = actor.intent;

    if (actionType === ActionType.DEFEND || actionType === ActionType.DODGE) {
      // Reactive — resolved inside the attacker's turn.
      return null;
    }

    switch (actionType) {
      case ActionType.ATTACK_MELEE:
      case ActionType.ATTACK_RANGED:
        return this._resolveAttack(actor, dice);
      case ActionType.DISCIPLINE:
        return this._resolveDiscipline(actor);
      case ActionType.SPECIAL:
        return this._resolveSpecial(actor);
      default:
        return null;
    }
  }

  // ─── Attack resolution ────────────────────────────────────────────────────

  _resolveAttack(attacker, dice) {
    const intent   = attacker.intent;
    const isMelee  = intent.actionType === ActionType.ATTACK_MELEE;
    const target   = intent.targetId ? this.participants.get(intent.targetId) : null;

    // ── Attack pool components ────────────────────────────────────────────────
    const potenceBonus      = Number(intent.modifiers?.potence  ?? 0);
    const celerityBonus     = intent.modifiers?.celerity ? 1 : 0;
    const weaponDamageBonus = Number(intent.weapon?.damageBonus ?? 0);

    const attackAttrName = isMelee ? 'Stärke' : 'Geschicklichkeit';
    const attackAttr     = isMelee ? attacker.attributes.strength : attacker.attributes.dexterity;
    const attackSkillName = isMelee
      ? ((attacker.skills.melee ?? 0) >= (attacker.skills.brawl ?? 0) ? 'Nahkampf' : 'Raufen')
      : 'Schusswaffen';
    const attackSkill    = isMelee
      ? Math.max(attacker.skills.brawl ?? 0, attacker.skills.melee ?? 0)
      : (attacker.skills.firearms ?? 0);

    const attackPool   = Math.max(1, attackAttr + attackSkill + potenceBonus + celerityBonus);
    const attackHunger = Math.min(attacker.hunger ?? 0, attackPool);

    const rollFn     = dice?.roll ?? DiceEngine.roll;
    const attackRoll = rollFn(attackPool, attackHunger);

    // ── Defense pool ──────────────────────────────────────────────────────────
    let defenseRoll      = null;
    let defenseSuccesses = 0;
    let defBreakdown     = null;

    if (target && !this._isIncapacitated(target) && target.intent) {
      const ti       = target.intent;
      const isDodge  = ti.actionType === ActionType.DODGE;
      const isDefend = ti.actionType === ActionType.DEFEND;

      if (isDodge || isDefend) {
        const fortitudeBonus = Number(ti.modifiers?.fortitude ?? 0);
        const defAttrName    = 'Geschicklichkeit';
        const defAttr        = target.attributes.dexterity;
        const defSkillName   = isDodge ? 'Sport' : 'Nahkampf/Raufen';
        const defSkill       = isDodge
          ? (target.skills.athletics ?? 0)
          : Math.max(target.skills.brawl ?? 0, target.skills.melee ?? 0);
        const defPool        = Math.max(1, defAttr + defSkill + fortitudeBonus);
        const defHunger      = Math.min(target.hunger ?? 0, defPool);

        defenseRoll      = rollFn(defPool, defHunger);
        defenseSuccesses = defenseRoll.successes;
        defBreakdown     = {
          attrName: defAttrName, attrVal: defAttr,
          skillName: defSkillName, skillVal: defSkill,
          fortitude: fortitudeBonus,
          total: defPool, hungerDice: defHunger,
        };
      }
    }

    // ── Net result ────────────────────────────────────────────────────────────
    const netSuccesses = Math.max(0, attackRoll.successes - defenseSuccesses);

    // Base damage bonus: ranged always +1, melee +1 if Potence active
    const baseDmgBonus  = isMelee && potenceBonus > 0 ? 1 : (isMelee ? 0 : 1);
    const totalDmgBonus = baseDmgBonus + weaponDamageBonus;
    const rawDamage     = netSuccesses > 0 ? netSuccesses + totalDmgBonus : 0;

    // Damage type: weapon override → messy crit → default superficial
    const weaponForcesAgg = intent.weapon?.damageType === DamageType.AGGRAVATED;
    const damageType      = (weaponForcesAgg || attackRoll.messyCritical)
      ? DamageType.AGGRAVATED
      : DamageType.SUPERFICIAL;

    const actualDamage = this._applyDamageReduction(rawDamage, damageType, target, intent);

    const effects = [];
    if (target && netSuccesses > 0 && actualDamage > 0) {
      this._applyDamage(target, actualDamage, effects);
    }

    // ── Pool breakdown (for display) ──────────────────────────────────────────
    const atkBreakdown = {
      attrName: attackAttrName, attrVal: attackAttr,
      skillName: attackSkillName, skillVal: attackSkill,
      potence:  potenceBonus,
      celerity: celerityBonus,
      weapon:   intent.weapon?.name ?? null,
      weaponDmg: weaponDamageBonus,
      total:    attackPool,
      hungerDice: attackHunger,
    };

    return {
      attackerId:  attacker.id,
      attackerName: attacker.name,
      defenderId:  target?.id ?? null,
      defenderName: target?.name ?? null,
      actionType:  intent.actionType,
      attackRoll,
      defenseRoll,
      netSuccesses,
      rawDamage,
      damage:      actualDamage,
      damageType,
      effects,
      breakdown:   { attack: atkBreakdown, defense: defBreakdown },
      narrative:   this._narrative(attacker, target, attackRoll, defenseRoll,
                     netSuccesses, actualDamage, damageType, effects, atkBreakdown),
    };
  }

  // ─── Discipline resolution ────────────────────────────────────────────────

  _resolveDiscipline(actor) {
    const intent = actor.intent;
    const disc   = intent.disciplineUsed ?? 'unknown';
    const target = intent.targetId ? this.participants.get(intent.targetId) : null;
    const effects = [];
    let narrative = '';

    switch (disc) {
      case 'dominate':
        if (target) {
          this._addStatus(target, StatusEffect.DOMINATED, effects);
          narrative = `${actor.name} Dominates ${target.name} — incapacitated this round.`;
        } else {
          narrative = `${actor.name} uses Dominate but has no target.`;
        }
        break;
      case 'celerity':
        narrative = `${actor.name} activates Celerity (dice bonus applied to attack).`;
        break;
      case 'potence':
        narrative = `${actor.name} channels Potence (damage bonus applied to attack).`;
        break;
      case 'fortitude':
        narrative = `${actor.name} braces with Fortitude (defense bonus active).`;
        break;
      default:
        narrative = `${actor.name} uses discipline: ${disc}.`;
    }

    return {
      attackerId:  actor.id,
      defenderId:  target?.id ?? null,
      actionType:  ActionType.DISCIPLINE,
      attackRoll:  null,
      defenseRoll: null,
      netSuccesses: 0,
      rawDamage:   0,
      damage:      0,
      damageType:  null,
      effects,
      narrative,
    };
  }

  // ─── Special action resolution ────────────────────────────────────────────

  _resolveSpecial(actor) {
    const intent = actor.intent;
    const target = intent.targetId ? this.participants.get(intent.targetId) : null;
    return {
      attackerId:  actor.id,
      defenderId:  target?.id ?? null,
      actionType:  ActionType.SPECIAL,
      attackRoll:  null,
      defenseRoll: null,
      netSuccesses: 0,
      rawDamage:   0,
      damage:      0,
      damageType:  null,
      effects:     [],
      narrative:   `${actor.name}: ${intent.specialAction ?? 'Special action.'}`,
    };
  }

  // ─── Damage helpers ───────────────────────────────────────────────────────

  _applyDamageReduction(rawDamage, type, target, intent) {
    if (!target || rawDamage <= 0) return rawDamage;
    let damage = rawDamage;

    // Fortitude on the TARGET reduces superficial damage
    if (type === DamageType.SUPERFICIAL && target.intent) {
      const fortBonus = Number(target.intent.modifiers?.fortitude ?? 0);
      damage = Math.max(0, damage - fortBonus);
    }

    // Vampires halve superficial
    if (type === DamageType.SUPERFICIAL) {
      damage = Math.ceil(damage / 2);
    }

    return damage;
  }

  _applyDamage(target, amount, effects) {
    target.health.value = Math.max(0, target.health.value - amount);
    this._checkStatus(target, effects);
  }

  _checkStatus(target, effects) {
    const { value, max } = target.health;
    if (value <= 0) {
      this._addStatus(target, StatusEffect.TORPOR, effects);
    } else if (value <= Math.ceil(max * 0.3)) {
      this._addStatus(target, StatusEffect.IMPAIRED, effects);
    }
  }

  _addStatus(target, status, effects) {
    if (!target.statusEffects.includes(status)) {
      target.statusEffects.push(status);
      effects.push(`${target.name} → ${status}`);
    }
  }

  _isIncapacitated(p) {
    return p.statusEffects.includes(StatusEffect.TORPOR) ||
           p.statusEffects.includes(StatusEffect.DISABLED);
  }

  // ─── End of round ─────────────────────────────────────────────────────────

  /**
   * Clear transient (1-round) effects and intents. Transition back to INTENT.
   */
  endRound() {
    const transient = new Set([StatusEffect.DOMINATED]);
    for (const p of this.participants.values()) {
      p.statusEffects = p.statusEffects.filter(s => !transient.has(s));
      p.intent = null;
    }
    this.setPhase(CombatPhase.INTENT);
  }

  // ─── Narrative builder ────────────────────────────────────────────────────

  _narrative(attacker, target, atkRoll, defRoll, net, damage, dmgType, effects, breakdown) {
    // Pool breakdown line
    let poolLine = '';
    if (breakdown) {
      const parts = [
        `${breakdown.attrName}(${breakdown.attrVal})`,
        `${breakdown.skillName}(${breakdown.skillVal})`,
      ];
      if (breakdown.potence)  parts.push(`Potenz(${breakdown.potence})`);
      if (breakdown.celerity) parts.push(`Celerity(1)`);
      if (breakdown.weapon && breakdown.weaponDmg > 0)
        parts.push(`${breakdown.weapon} +${breakdown.weaponDmg} Schaden`);
      poolLine = `[Pool: ${parts.join(' + ')} = ${breakdown.total} Würfel, ${breakdown.hungerDice} Hunger] `;
    }

    let s = `${attacker.name} → ${target?.name ?? '?'}: `;
    s += poolLine;
    s += `${atkRoll.successes} Angriffserfolge`;
    if (defRoll) s += ` vs ${defRoll.successes} Verteidigung`;
    s += ` = ${net} netto. `;

    if (net > 0) {
      s += `${damage} ${dmgType === 'aggravated' ? 'aggraviierter' : 'oberflächlicher'} Schaden. `;
    } else {
      s += `Angriff geblockt. `;
    }

    if (atkRoll.bestialFailure) s += '⚠ BESTIAL FAILURE! ';
    if (atkRoll.messyCritical)  s += '💀 MESSY CRITICAL! ';
    if (effects.length) s += effects.join('; ') + '.';
    return s.trim();
  }

  // ─── State sync ───────────────────────────────────────────────────────────

  /**
   * Replace internal state from a plain object (received via socket).
   * Used on player clients to mirror the GM's session.
   * Does NOT fire onUpdate to avoid echo loops.
   * @param {SessionState} state
   */
  loadState(state) {
    this.phase        = state.phase;
    this.round        = state.round;
    this.log          = state.log ?? [];
    this.participants = new Map(
      (state.participants ?? []).map(p => [p.id, { ...p }])
    );
  }

  // ─── State snapshot ───────────────────────────────────────────────────────

  /**
   * Return an immutable snapshot of session state.
   * @returns {SessionState}
   *
   * @typedef {Object} SessionState
   * @property {string}        id
   * @property {string}        phase
   * @property {number}        round
   * @property {Participant[]} participants
   * @property {CombatResult[]} log
   */
  getState() {
    return {
      id:           this.id,
      phase:        this.phase,
      round:        this.round,
      participants: Array.from(this.participants.values()),
      log:          this.log,
    };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  _require(id) {
    const p = this.participants.get(id);
    if (!p) throw new Error(`Participant "${id}" not found in session.`);
    return p;
  }

  _notify() {
    if (typeof this.onUpdate === 'function') {
      this.onUpdate(this.getState());
    }
  }
}
