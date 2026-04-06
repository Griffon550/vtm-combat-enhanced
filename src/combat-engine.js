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
  // ── Melee attack types (determine attribute+skill pool) ────────────────────
  ATTACK_UNARMED: 'attack_unarmed', // STR + BRAWL
  ATTACK_LIGHT:   'attack_light',   // DEX + MELEE  (light weapons: knife, sword)
  ATTACK_HEAVY:   'attack_heavy',   // STR + MELEE  (heavy weapons: great sword, axe)
  // ── Ranged attack types ────────────────────────────────────────────────────
  ATTACK_RANGED:  'attack_ranged',  // DEX + FIREARMS
  ATTACK_AIMED:   'attack_aimed',   // WITS + FIREARMS (gezieltes Schießen)
  // ── Backward-compatible alias (maps to ATTACK_HEAVY pool logic) ────────────
  ATTACK_MELEE:   'attack_melee',
  // ── Other ─────────────────────────────────────────────────────────────────
  DEFEND:         'defend',
  DODGE:          'dodge',
  DISCIPLINE:     'discipline',
  SPECIAL:        'special',
  PASS:           'pass',
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

// ─── Weapon table ─────────────────────────────────────────────────────────────
// damageBonus: fixed bonus added to net successes on a hit
// attackType : which ActionType this weapon uses (determines attribute+skill pool)
// damageType : null = context default (superficial), 'aggravated' = always agg.

export const WEAPON_TABLE = Object.freeze({
  UNARMED:      { key: 'UNARMED',      name: 'Unbewaffnet',    damageBonus: 0, attackType: 'attack_unarmed', damageType: null },
  KNIFE:        { key: 'KNIFE',        name: 'Messer',         damageBonus: 1, attackType: 'attack_light',   damageType: null },
  SWORD:        { key: 'SWORD',        name: 'Schwert',        damageBonus: 2, attackType: 'attack_light',   damageType: null },
  GREAT_WEAPON: { key: 'GREAT_WEAPON', name: 'Große Waffe',    damageBonus: 3, attackType: 'attack_heavy',   damageType: null },
  PISTOL:       { key: 'PISTOL',       name: 'Pistole',        damageBonus: 2, attackType: 'attack_ranged',  damageType: null },
  RIFLE:        { key: 'RIFLE',        name: 'Gewehr',         damageBonus: 3, attackType: 'attack_ranged',  damageType: null },
  SNIPER:       { key: 'SNIPER',       name: 'Scharfschütze',  damageBonus: 4, attackType: 'attack_aimed',   damageType: null },
  FIRE:         { key: 'FIRE',         name: 'Feuer',          damageBonus: 2, attackType: 'attack_special', damageType: 'aggravated' },
  SUNLIGHT:     { key: 'SUNLIGHT',     name: 'Sonnenlicht',    damageBonus: 3, attackType: 'attack_special', damageType: 'aggravated' },
});

// ─── Armor table ──────────────────────────────────────────────────────────────
// reduction: damage points subtracted after Fortitude, before vampire halving

export const ARMOR_TABLE = Object.freeze({
  NONE:        { key: 'NONE',        name: 'Keine Rüstung',      reduction: 0 },
  LIGHT:       { key: 'LIGHT',       name: 'Leichte Rüstung',    reduction: 1 },
  MEDIUM:      { key: 'MEDIUM',      name: 'Mittlere Rüstung',   reduction: 2 },
  HEAVY:       { key: 'HEAVY',       name: 'Schwere Rüstung',    reduction: 3 },
  REINFORCED:  { key: 'REINFORCED',  name: 'Verstärkte Rüstung', reduction: 4 },
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
    attributes:   { strength: 2, dexterity: 2, wits: 2, stamina: 2, charisma: 2, manipulation: 2, resolve: 2, composure: 2, ...data.attributes },
    skills:       { brawl: 0, melee: 0, firearms: 0, athletics: 0, ...data.skills },
    /** Equipped weapon — pick from WEAPON_TABLE or null for unarmed @type {Object|null} */
    weapon:       data.weapon ?? null,
    /** Equipped armor — pick from ARMOR_TABLE or null @type {Object|null} */
    armor:        data.armor  ?? null,
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
   * Tiebreaker: higher DEX wins.
   * @returns {Participant[]}
   */
  getInitiativeOrder() {
    return Array.from(this.participants.values())
      .filter(p => !this._isIncapacitated(p))
      .sort((a, b) => {
        if (b.initiative !== a.initiative) return b.initiative - a.initiative;
        // Tiebreaker: higher DEX wins
        return (b.attributes?.dexterity ?? 2) - (a.attributes?.dexterity ?? 2);
      });
  }

  // ─── Initiative ────────────────────────────────────────────────────────────

  /**
   * Roll initiative for one participant.
   * Formula (V5): DEX + WITS as a dice pool — successes determine order.
   * Tiebreaker: higher DEX wins (handled by caller / getInitiativeOrder).
   *
   * @param {string} id
   * @param {{ roll?: (pool:number, hunger:number) => DiceResult }} opts  dice override for tests
   * @returns {{ participantId, dex, wits, pool, hungerDice, successes }}
   */
  rollInitiative(id, opts = {}) {
    const p      = this._require(id);
    const dex    = p.attributes.dexterity ?? 2;
    const wits   = p.attributes.wits      ?? 2;
    const pool   = dex + wits;
    const hunger = Math.min(p.hunger ?? 0, pool);

    const rollFn   = opts.roll ?? DiceEngine.roll;
    const result   = rollFn(pool, hunger);

    // Store raw successes as initiative; tiebreaker resolved by getInitiativeOrder via dex
    p.initiative     = result.successes;
    p._initiativeDex = dex;   // cached for tiebreaker
    this._notify();
    return { participantId: id, dex, wits, pool, hungerDice: hunger, successes: result.successes };
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
      // Weapon override: entry from WEAPON_TABLE or null (falls back to participant.weapon)
      weapon:         intent.weapon         ?? null,
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
      case ActionType.ATTACK_UNARMED:
      case ActionType.ATTACK_LIGHT:
      case ActionType.ATTACK_HEAVY:
      case ActionType.ATTACK_RANGED:
      case ActionType.ATTACK_AIMED:
      case ActionType.ATTACK_MELEE:   // backward-compat alias
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
    const intent  = attacker.intent;
    const target  = intent.targetId ? this.participants.get(intent.targetId) : null;

    // ── Effective weapon: intent override → equipped weapon → UNARMED fallback ─
    const weapon = intent.weapon ?? attacker.weapon ?? WEAPON_TABLE.UNARMED;

    // ── Attack pool ────────────────────────────────────────────────────────────
    const atkBreakdown = this._getAttackPool(attacker, intent.actionType, intent.modifiers);
    const rollFn       = dice?.roll ?? DiceEngine.roll;
    const attackRoll   = rollFn(atkBreakdown.total, atkBreakdown.hungerDice);

    // ── Defense pool ──────────────────────────────────────────────────────────
    let defenseRoll      = null;
    let defenseSuccesses = 0;
    let defBreakdown     = null;

    if (target && !this._isIncapacitated(target) && target.intent) {
      const ti = target.intent;
      if (ti.actionType === ActionType.DODGE || ti.actionType === ActionType.DEFEND) {
        defBreakdown     = this._getDefensePool(target, ti);
        defenseRoll      = rollFn(defBreakdown.total, defBreakdown.hungerDice);
        defenseSuccesses = defenseRoll.successes;
      }
    }

    // ── Net result & damage ───────────────────────────────────────────────────
    const netSuccesses  = Math.max(0, attackRoll.successes - defenseSuccesses);
    const weaponDmgBonus = Number(weapon.damageBonus ?? 0);
    const rawDamage      = netSuccesses > 0 ? netSuccesses + weaponDmgBonus : 0;

    // Damage type: weapon forces aggravated → messy crit → default superficial
    const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
    const damageType = (weaponForcesAgg || attackRoll.messyCritical)
      ? DamageType.AGGRAVATED
      : DamageType.SUPERFICIAL;

    const actualDamage = this._applyDamageReduction(rawDamage, damageType, target, intent);

    const effects = [];
    if (target && netSuccesses > 0 && actualDamage > 0) {
      this._applyDamage(target, actualDamage, effects);
    }

    return {
      attackerId:   attacker.id,
      attackerName: attacker.name,
      defenderId:   target?.id   ?? null,
      defenderName: target?.name ?? null,
      actionType:   intent.actionType,
      weapon:       weapon.name,
      attackRoll,
      defenseRoll,
      netSuccesses,
      rawDamage,
      damage:       actualDamage,
      damageType,
      effects,
      breakdown:    { attack: atkBreakdown, defense: defBreakdown },
      narrative:    this._narrative(attacker, target, attackRoll, defenseRoll,
                      netSuccesses, actualDamage, damageType, effects, atkBreakdown, weapon),
    };
  }

  // ─── Attack pool helper ───────────────────────────────────────────────────
  //
  // Returns the fully-computed attack pool breakdown for a given action type.
  // Applies IMPAIRED penalty (-2 dice) automatically.
  //
  // @param {Participant} attacker
  // @param {string}      actionType  one of ActionType.*
  // @param {Object}      modifiers   { celerity, potence }
  // @returns {{ total, hungerDice, attrName, attrVal, skillName, skillVal,
  //             potenceBonus, celerityBonus, impaired }}

  _getAttackPool(attacker, actionType, modifiers) {
    const potenceBonus  = Number(modifiers?.potence  ?? 0);
    const celerityBonus = modifiers?.celerity ? 1 : 0;

    let attrVal, attrName, skillVal, skillName;

    switch (actionType) {
      case ActionType.ATTACK_UNARMED:
        attrVal = attacker.attributes.strength;       attrName  = 'Stärke';
        skillVal = attacker.skills.brawl ?? 0;        skillName = 'Raufen';
        break;

      case ActionType.ATTACK_LIGHT:
        attrVal = attacker.attributes.dexterity;      attrName  = 'Geschicklichkeit';
        skillVal = attacker.skills.melee ?? 0;        skillName = 'Nahkampf';
        break;

      case ActionType.ATTACK_HEAVY:
        attrVal = attacker.attributes.strength;       attrName  = 'Stärke';
        skillVal = attacker.skills.melee ?? 0;        skillName = 'Nahkampf';
        break;

      case ActionType.ATTACK_RANGED:
        attrVal = attacker.attributes.dexterity;      attrName  = 'Geschicklichkeit';
        skillVal = attacker.skills.firearms ?? 0;     skillName = 'Schusswaffen';
        break;

      case ActionType.ATTACK_AIMED:
        attrVal = attacker.attributes.wits ?? 2;      attrName  = 'Verstand';
        skillVal = attacker.skills.firearms ?? 0;     skillName = 'Schusswaffen';
        break;

      case ActionType.ATTACK_MELEE:   // backward-compat: use max(brawl, melee) with STR
      default: {
        const brawl = attacker.skills.brawl ?? 0;
        const melee = attacker.skills.melee ?? 0;
        attrVal   = attacker.attributes.strength;   attrName  = 'Stärke';
        if (melee >= brawl) { skillVal = melee; skillName = 'Nahkampf'; }
        else                { skillVal = brawl; skillName = 'Raufen';   }
        break;
      }
    }

    const impaired  = attacker.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const total     = Math.max(1, attrVal + skillVal + potenceBonus + celerityBonus - impaired);
    const hungerDice = Math.min(attacker.hunger ?? 0, total);

    return { total, hungerDice, attrName, attrVal, skillName, skillVal,
             potenceBonus, celerityBonus, impaired };
  }

  // ─── Defense pool helper ──────────────────────────────────────────────────
  //
  // Returns the defense pool breakdown for a defending/dodging participant.
  // Applies IMPAIRED penalty (-2 dice) automatically.
  //
  // @param {Participant} target
  // @param {Intent}      intent  the target's declared intent
  // @returns {{ total, hungerDice, attrName, attrVal, skillName, skillVal,
  //             fortitude, impaired }}

  _getDefensePool(target, intent) {
    const fortitudeBonus = Number(intent.modifiers?.fortitude ?? 0);
    const isDodge        = intent.actionType === ActionType.DODGE;

    const attrVal  = target.attributes.dexterity;
    const attrName = 'Geschicklichkeit';
    let skillVal, skillName;

    if (isDodge) {
      skillVal  = target.skills.athletics ?? 0;
      skillName = 'Sport';
    } else {
      // DEFEND — parry with highest of brawl/melee
      const brawl = target.skills.brawl ?? 0;
      const melee = target.skills.melee ?? 0;
      if (melee >= brawl) { skillVal = melee; skillName = 'Nahkampf'; }
      else                { skillVal = brawl; skillName = 'Raufen';   }
    }

    const impaired  = target.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const total     = Math.max(1, attrVal + skillVal + fortitudeBonus - impaired);
    const hungerDice = Math.min(target.hunger ?? 0, total);

    return { total, hungerDice, attrName, attrVal, skillName, skillVal,
             fortitude: fortitudeBonus, impaired };
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

    // 1. Fortitude (active defense modifier, superficial only)
    if (type === DamageType.SUPERFICIAL && target.intent) {
      const fortBonus = Number(target.intent.modifiers?.fortitude ?? 0);
      damage = Math.max(0, damage - fortBonus);
    }

    // 2. Armor reduction (applies to both damage types vs. physical attacks)
    const armorReduction = target.armor?.reduction ?? 0;
    if (armorReduction > 0) {
      damage = Math.max(0, damage - armorReduction);
    }

    // 3. Vampires halve superficial damage (after armor, ceiling)
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

  _narrative(attacker, target, atkRoll, defRoll, net, damage, dmgType, effects, breakdown, weapon) {
    // Pool breakdown line
    let poolLine = '';
    if (breakdown) {
      const parts = [
        `${breakdown.attrName}(${breakdown.attrVal})`,
        `${breakdown.skillName}(${breakdown.skillVal})`,
      ];
      if (breakdown.potenceBonus)  parts.push(`Potenz(${breakdown.potenceBonus})`);
      if (breakdown.celerityBonus) parts.push(`Celerity(1)`);
      if (breakdown.impaired > 0)  parts.push(`Beeinträchtigt(-${breakdown.impaired})`);
      poolLine = `[Pool: ${parts.join(' + ')} = ${breakdown.total} W, ${breakdown.hungerDice}× Hunger] `;
    }

    let s = `${attacker.name} → ${target?.name ?? '?'}: `;
    if (weapon && weapon.name !== 'Unbewaffnet') s += `[${weapon.name}] `;
    s += poolLine;
    s += `${atkRoll.successes} Angriffserfolge`;
    if (defRoll) s += ` vs ${defRoll.successes} Verteidigung`;
    s += ` = ${net} netto. `;

    if (net > 0) {
      const dmgLabel = dmgType === 'aggravated' ? 'aggraviierter' : 'oberflächlicher';
      s += `${damage} ${dmgLabel} Schaden. `;
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
