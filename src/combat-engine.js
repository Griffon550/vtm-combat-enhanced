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

import { DiceEngine }        from './dice/dice-engine.js';
import { DisciplineEngine }  from './disciplines/discipline-engine.js';
import { DISCIPLINE_POWERS } from './disciplines/discipline-powers.js';

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
  // ── Kampfzustände ──────────────────────────────────────────────────────────
  IMPAIRED:      'impaired',       // -2 auf alle Pools (Health voll)
  TORPOR:        'torpor',         // kampfunfähig
  DISABLED:      'disabled',       // kampfunfähig
  // ── Mentale Kontrolle ─────────────────────────────────────────────────────
  DOMINATED:     'dominated',      // 1-Runden-Effekt aus Dominate (Compel/Mesmerize)
  COMPELLED:     'compelled',      // einfacher Befehl aktiv
  CONTROLLED:    'controlled',     // stärkere Kontrolle (Mesmerize/Terminal Decree)
  // ── Angst & Debuff ────────────────────────────────────────────────────────
  INTIMIDATED:   'intimidated',    // -2 Pool (Daunt)
  FRIGHTENED:    'frightened',     // -2 Pool, kann Rückzug erzwingen (Dread Gaze)
  HESITATING:    'hesitating',     // -1 Pool
  ENRAGED:       'enraged',        // -1 Pool, Entscheidungslogik eingeschränkt
  DESTABILIZED:  'destabilized',   // -1 Pool
  // ── Positionale Zustände ──────────────────────────────────────────────────
  MIST_FORM:     'mist_form',      // nicht normal angreifbar (Protean Mist Form)
  VANISHED:      'vanished',       // Zielanvisierung aufgehoben (Obfuscate Vanish)
  MAJESTIC:      'majestic',       // Feinde müssen testen um anzugreifen (Presence Majesty)
  // ── Handlungseinschränkungen ──────────────────────────────────────────────
  RESTRAINED:    'restrained',     // fixiert — kein Verteidigungswurf möglich
  SURPRISED:     'surprised',      // überrascht — kein Verteidigungswurf in der ersten Runde
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
/**
 * Normalisiert einen Disziplin-Wert: Zahl (alt) oder Objekt (neu).
 * @param {number|{rating:number,knownPowers:string[]}|undefined} d
 * @returns {{ rating: number, knownPowers: string[] }}
 */
function _normDisc(d) {
  if (!d)                  return { rating: 0, knownPowers: [] };
  if (typeof d === 'number') return { rating: d, knownPowers: [] };
  return { rating: d.rating ?? 0, knownPowers: Array.from(d.knownPowers ?? []) };
}

export function createParticipant(data, side = 'players') {
  // Normalisiere Disziplinen (kompatibel mit altem Flat-Number-Format)
  const rawDisc = data.disciplines ?? {};
  const disciplines = {
    potence:   _normDisc(rawDisc.potence),
    celerity:  _normDisc(rawDisc.celerity),
    fortitude: _normDisc(rawDisc.fortitude),
    dominate:  _normDisc(rawDisc.dominate),
    presence:  _normDisc(rawDisc.presence),
    protean:   _normDisc(rawDisc.protean),
    obfuscate: _normDisc(rawDisc.obfuscate),
  };

  return {
    id:           data.id   ?? `actor-${Math.random().toString(36).slice(2)}`,
    name:         data.name ?? 'Unknown',
    img:          data.img  ?? '',
    side,
    health:       { value: 10, max: 10, ...data.health },
    willpower:    { value: 3,  max: 6,  ...data.willpower },
    hunger:       data.hunger     ?? 0,
    initiative:   data.initiative ?? 0,
    /** 'melee' | 'ranged' — Distanz zum nächsten Gegner */
    distance:     data.distance   ?? 'melee',
    statusEffects: Array.from(data.statusEffects ?? []),
    disciplines,
    attributes:   { strength: 2, dexterity: 2, wits: 2, stamina: 2, charisma: 2, manipulation: 2, resolve: 2, composure: 2, ...data.attributes },
    skills:       { brawl: 0, melee: 0, firearms: 0, athletics: 0, ...data.skills },
    /** Equipped weapon — pick from WEAPON_TABLE or null for unarmed @type {Object|null} */
    weapon:       data.weapon ?? null,
    /** Equipped armor  — pick from ARMOR_TABLE  or null @type {Object|null} */
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

    /** Modulare Disziplineffekt-Auflösung */
    this.disciplineEngine = new DisciplineEngine(DISCIPLINE_POWERS);

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
    const p    = this._require(id);
    const dex  = p.attributes.dexterity ?? 2;
    const wits = p.attributes.wits      ?? 2;

    // beforeInitiative: passive Kräfte (z.B. Rapid Reflexes +1 Würfel, Lightning Strike +5 Erfolge)
    const initCtx = this.disciplineEngine.applyBeforeInitiative(
      p,
      { pool: dex + wits, hungerDice: 0 },
      p.intent?.activePowers ?? [],
    );

    const rollFn = opts.roll ?? DiceEngine.roll;
    const result = rollFn(initCtx.pool, initCtx.hungerDice);

    // Flat Initiative-Bonus (z.B. Lightning Strike: +5 Erfolge)
    p.initiative     = result.successes + (initCtx.initiativeBonus ?? 0);
    p._initiativeDex = dex;
    this._notify();
    return {
      participantId:      id,
      name:               p.name,
      dex, wits,
      pool:               initCtx.pool,
      hungerDice:         initCtx.hungerDice,
      roll:               result,          // full DiceResult (normalRolls, hungerRolls, …)
      successes:          result.successes,
      initiativeBonus:    initCtx.initiativeBonus,
      surpriseResistance: initCtx.surpriseResistance,
      appliedPowers:      initCtx.appliedPowers ?? [],
      total:              p.initiative,
    };
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
      actorId:       participantId,
      actionType:    intent.actionType  ?? ActionType.PASS,
      targetId:      intent.targetId   ?? null,
      /** Kräfte, die dieser Charakter diesen Zug aktiviert (rouse_check / contest). */
      activePowers:  Array.from(intent.activePowers ?? []),
      /** Legacy-Modifikatoren (werden intern ignoriert, dienen der Rückwärtskompatibilität). */
      modifiers:     intent.modifiers  ?? {},
      disciplineUsed: intent.disciplineUsed ?? null,
      specialAction:  intent.specialAction  ?? null,
      /** Waffe: Eintrag aus WEAPON_TABLE oder null (fällt auf participant.weapon zurück). */
      weapon:         intent.weapon    ?? null,
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
    const results  = [];
    const order    = this.getInitiativeOrder();

    /**
     * Rundenkontext für Multi-Defense-Tracking.
     * @type {{ defenseCount: Map<string,number>, hasAttacked: Set<string> }}
     *
     * defenseCount  — wie oft hat dieser Teilnehmer diese Runde bereits verteidigt
     * hasAttacked   — hat dieser Teilnehmer diese Runde bereits einen Angriff ausgeführt
     */
    const roundCtx = {
      defenseCount: new Map(),
      hasAttacked:  new Set(),
    };

    for (const actor of order) {
      if (!actor.intent || actor.intent.actionType === ActionType.PASS) continue;
      if (this._isIncapacitated(actor)) continue;

      const result = this._resolveOne(actor, diceOverride, roundCtx);
      if (result) {
        results.push(result);
        this.log.push(result);
      }
    }

    this.setPhase(CombatPhase.STATE_UPDATE);
    return results;
  }

  /** Resolve a single actor's intent. */
  _resolveOne(actor, dice, roundCtx) {
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
        return this._resolveAttack(actor, dice, roundCtx);
      case ActionType.DISCIPLINE:
        return this._resolveDiscipline(actor);
      case ActionType.SPECIAL:
        return this._resolveSpecial(actor);
      default:
        return null;
    }
  }

  // ─── Attack resolution ────────────────────────────────────────────────────

  _resolveAttack(attacker, dice, roundCtx = null) {
    const intent        = attacker.intent;
    const activePowers  = intent.activePowers ?? [];
    const target        = intent.targetId ? this.participants.get(intent.targetId) : null;

    // Angreifer als "hat angegriffen" markieren (zählt für dessen eigene Verteidigung später)
    roundCtx?.hasAttacked.add(attacker.id);

    // ── Zielbarkeit prüfen (Mist Form, Vanish, …) ────────────────────────────
    if (target && this.disciplineEngine.cannotBeTargeted(target, target.intent?.activePowers ?? [])) {
      return {
        attackerId: attacker.id, attackerName: attacker.name,
        defenderId: target.id,   defenderName: target.name,
        actionType: intent.actionType,
        weapon: null, attackRoll: null, defenseRoll: null,
        netSuccesses: 0, rawDamage: 0, damage: 0, damageType: null,
        effects: [], breakdown: null, defenseBlocked: false,
        narrative: `${attacker.name} → ${target.name}: Ziel nicht angreifbar (Nebelform o.ä.).`,
      };
    }

    // ── Effektive Waffe: intent → ausgerüstete Waffe → Unbewaffnet ────────────
    const weapon = intent.weapon ?? attacker.weapon ?? WEAPON_TABLE.UNARMED;

    // ── Angriffspool ─────────────────────────────────────────────────────────
    const atkBreakdown = this._getAttackPool(attacker, intent.actionType, activePowers);
    const rollFn       = dice?.roll ?? DiceEngine.roll;
    const attackRoll   = rollFn(atkBreakdown.total, atkBreakdown.hungerDice);

    // Automatische Erfolge aus Disziplineffekten
    const totalAtkSuccesses = attackRoll.successes + (atkBreakdown.autoSuccesses ?? 0);

    // ── Verteidigungspool — Multi-Defense-System ──────────────────────────────
    //
    // Jeder kann reaktiv verteidigen, AUSSER er ist:
    //   • RESTRAINED  (physisch fixiert)
    //   • SURPRISED   (überrascht, kein Abwehrwurf)
    //
    // Malus: defense_pool = base - prevDefenses - attackedPenalty + celerityReduction
    //   prevDefenses    = Anzahl bereits absolvierter Verteidigungen diese Runde
    //   attackedPenalty = +1 auf die ERSTE Verteidigung wenn Ziel bereits selbst angegriffen hat
    //   celerityReduction = durch Swiftness/Celerity reduzierter Malus

    let defenseRoll      = null;
    let defenseSuccesses = 0;
    let defBreakdown     = null;
    let defenseBlocked   = false;

    if (target && !this._isIncapacitated(target)) {
      defenseBlocked = target.statusEffects.includes(StatusEffect.RESTRAINED)
                    || target.statusEffects.includes(StatusEffect.SURPRISED);

      if (!defenseBlocked) {
        const prevDefenses       = roundCtx?.defenseCount.get(target.id) ?? 0;
        const hasAttackedPenalty = (roundCtx?.hasAttacked.has(target.id) && prevDefenses === 0) ? 1 : 0;
        const rawPenalty         = prevDefenses + hasAttackedPenalty;
        const celerityReduction  = this.disciplineEngine.getMultiDefensePenaltyReduction(
          target, target.intent?.activePowers ?? []
        );
        const multiDefPenalty = Math.max(0, rawPenalty - celerityReduction);

        const ti     = target.intent ?? { actionType: ActionType.DEFEND };
        defBreakdown = this._getDefensePool(target, ti, multiDefPenalty, {
          prevDefenses, hasAttackedPenalty, celerityReduction,
        });
        defenseRoll      = rollFn(defBreakdown.total, defBreakdown.hungerDice);
        defenseSuccesses = defenseRoll.successes;

        // Verteidigungszähler erhöhen — nächster Angriff gegen dieses Ziel kostet 1 Würfel mehr
        roundCtx?.defenseCount.set(target.id, prevDefenses + 1);
      }
    }

    // ── Netto-Erfolge & Rohschaden ────────────────────────────────────────────
    const netSuccesses   = Math.max(0, totalAtkSuccesses - defenseSuccesses);
    const weaponDmgBonus = Number(weapon.damageBonus ?? 0);
    const baseDamage     = netSuccesses > 0 ? netSuccesses + weaponDmgBonus : 0;

    // Schadenstyp: Waffe → Messy Critical → Standard superficial
    const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
    let damageType = (weaponForcesAgg || attackRoll.messyCritical)
      ? DamageType.AGGRAVATED
      : DamageType.SUPERFICIAL;

    // ── onHit-Hook: Disziplinkräfte (Prowess, Lethal Body, Spark of Rage, …) ──
    let finalDamage     = baseDamage;
    let statusesToApply = [];
    let onHitPowers     = [];

    if (netSuccesses > 0) {
      const hitCtx = this.disciplineEngine.applyOnHit(
        attacker, intent.actionType,
        { damage: baseDamage, damageType, statusesToApply: [] },
        activePowers,
      );
      finalDamage     = hitCtx.damage;
      damageType      = hitCtx.damageType;
      statusesToApply = hitCtx.statusesToApply;
      onHitPowers     = hitCtx.appliedPowers ?? [];
    }

    // ── Schadensreduktion (Rüstung, Fortitude, Vampir-Halbierung) ────────────
    const actualDamage = this._applyDamageReduction(finalDamage, damageType, target);

    // ── Schaden und Zustände anwenden ─────────────────────────────────────────
    const effects = [];
    if (target && netSuccesses > 0) {
      if (actualDamage > 0) {
        this._applyDamage(target, actualDamage, effects);
      }
      for (const status of statusesToApply) {
        this._addStatus(target, status, effects);
      }
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
      rawDamage:    baseDamage,
      damage:       actualDamage,
      damageType,
      effects,
      appliedPowers: [...onHitPowers, ...(atkBreakdown.appliedPowers ?? [])],
      defenseBlocked,
      breakdown:    { attack: atkBreakdown, defense: defBreakdown },
      narrative:    this._narrative(attacker, target, attackRoll, defenseRoll,
                      netSuccesses, actualDamage, damageType, effects, atkBreakdown,
                      weapon, onHitPowers),
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

  _getAttackPool(attacker, actionType, activePowers) {
    let attrVal, attrName, skillVal, skillName;

    switch (actionType) {
      case ActionType.ATTACK_UNARMED:
        attrVal = attacker.attributes.strength;   attrName  = 'Stärke';
        skillVal = attacker.skills.brawl ?? 0;    skillName = 'Raufen';
        break;
      case ActionType.ATTACK_LIGHT:
        attrVal = attacker.attributes.dexterity;  attrName  = 'Geschicklichkeit';
        skillVal = attacker.skills.melee ?? 0;    skillName = 'Nahkampf';
        break;
      case ActionType.ATTACK_HEAVY:
        attrVal = attacker.attributes.strength;   attrName  = 'Stärke';
        skillVal = attacker.skills.melee ?? 0;    skillName = 'Nahkampf';
        break;
      case ActionType.ATTACK_RANGED:
        attrVal = attacker.attributes.dexterity;  attrName  = 'Geschicklichkeit';
        skillVal = attacker.skills.firearms ?? 0; skillName = 'Schusswaffen';
        break;
      case ActionType.ATTACK_AIMED:
        attrVal = attacker.attributes.wits ?? 2;  attrName  = 'Verstand';
        skillVal = attacker.skills.firearms ?? 0; skillName = 'Schusswaffen';
        break;
      case ActionType.ATTACK_MELEE:
      default: {
        const brawl = attacker.skills.brawl ?? 0;
        const melee = attacker.skills.melee ?? 0;
        attrVal = attacker.attributes.strength;   attrName = 'Stärke';
        if (melee >= brawl) { skillVal = melee; skillName = 'Nahkampf'; }
        else                { skillVal = brawl; skillName = 'Raufen';   }
        break;
      }
    }

    // Statusmalus (frightened, intimidated, etc.)
    const statusPenalty = this.disciplineEngine.getStatusPoolPenalty(attacker);
    const impaired      = attacker.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const baseTotal     = Math.max(1, attrVal + skillVal - impaired - statusPenalty);

    // beforeRoll-Hook: Disziplinkräfte (Unerring Aim, Fist of Caine, …)
    const rollCtx = this.disciplineEngine.applyBeforeRoll(
      attacker, actionType,
      { total: baseTotal, hungerDice: Math.min(attacker.hunger ?? 0, baseTotal) },
      activePowers,
    );

    return {
      total:        rollCtx.total,
      hungerDice:   rollCtx.hungerDice,
      autoSuccesses: rollCtx.autoSuccesses ?? 0,
      appliedPowers: rollCtx.appliedPowers ?? [],
      attrName, attrVal, skillName, skillVal,
      impaired, statusPenalty,
    };
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

  /**
   * Berechnet den Verteidigungspool inkl. Mehrfachverteidigungsmalus.
   *
   * @param {Participant} target
   * @param {Intent}      intent
   * @param {number}      multiDefPenalty  Kumulativer Malus (bereits durch Celerity reduziert)
   * @param {object}      [debugInfo]      { prevDefenses, hasAttackedPenalty, celerityReduction }
   */
  _getDefensePool(target, intent, multiDefPenalty = 0, debugInfo = {}) {
    // Fortitude wirkt NICHT auf den Verteidigungspool — nur auf Schadensreduktion
    const isDodge = intent.actionType === ActionType.DODGE;

    const attrVal  = target.attributes.dexterity;
    const attrName = 'Geschicklichkeit';
    let skillVal, skillName;

    if (isDodge) {
      skillVal  = target.skills.athletics ?? 0;
      skillName = 'Sport';
    } else {
      const brawl = target.skills.brawl ?? 0;
      const melee = target.skills.melee ?? 0;
      if (melee >= brawl) { skillVal = melee; skillName = 'Nahkampf'; }
      else                { skillVal = brawl; skillName = 'Raufen';   }
    }

    const statusPenalty = this.disciplineEngine.getStatusPoolPenalty(target);
    const impaired      = target.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const rawTotal      = Math.max(1, attrVal + skillVal - impaired - statusPenalty);
    const total         = Math.max(1, rawTotal - multiDefPenalty);
    const hungerDice    = Math.min(target.hunger ?? 0, total);

    return {
      total, hungerDice, attrName, attrVal, skillName, skillVal,
      impaired, statusPenalty,
      multiDefPenalty,
      rawTotal,
      prevDefenses:      debugInfo.prevDefenses      ?? 0,
      hasAttackedPenalty: debugInfo.hasAttackedPenalty ?? 0,
      celerityReduction: debugInfo.celerityReduction  ?? 0,
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

  _applyDamageReduction(rawDamage, type, target) {
    if (!target || rawDamage <= 0) return rawDamage;

    // 1. beforeDamageApply-Hook: Fortitude (Toughness, Flesh of Marble, Defy Bane)
    const defActivePowers = target.intent?.activePowers ?? [];
    const discCtx = this.disciplineEngine.applyBeforeDamageApply(
      target,
      { damage: rawDamage, damageType: type },
      defActivePowers,
    );
    let damage   = discCtx.damage;
    type         = discCtx.damageType;  // Defy Bane kann aggravated → superficial ändern

    // 2. Rüstung (nach Fortitude, vor Vampir-Halbierung)
    const armorReduction = target.armor?.reduction ?? 0;
    if (armorReduction > 0) {
      damage = Math.max(0, damage - armorReduction);
    }

    // 3. Vampire halbieren oberflächlichen Schaden (Ceiling)
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

  _narrative(attacker, target, atkRoll, defRoll, net, damage, dmgType, effects,
             breakdown, weapon, onHitPowers = []) {
    let poolLine = '';
    if (breakdown) {
      const parts = [
        `${breakdown.attrName}(${breakdown.attrVal})`,
        `${breakdown.skillName}(${breakdown.skillVal})`,
      ];
      if (breakdown.impaired > 0)      parts.push(`Beeinträchtigt(-${breakdown.impaired})`);
      if (breakdown.statusPenalty > 0) parts.push(`StatusMalus(-${breakdown.statusPenalty})`);
      if (breakdown.appliedPowers?.length) {
        parts.push(...breakdown.appliedPowers.map(p => `[${p}]`));
      }
      poolLine = `[Pool: ${parts.join(' + ')} = ${breakdown.total} W, ${breakdown.hungerDice}× Hunger] `;
    }

    let s = `${attacker.name} → ${target?.name ?? '?'}: `;
    if (weapon && weapon.name !== 'Unbewaffnet') s += `[${weapon.name}] `;
    s += poolLine;
    s += `${atkRoll.successes} Angriffserfolge`;
    if (breakdown?.autoSuccesses > 0) s += ` +${breakdown.autoSuccesses} Auto`;
    if (defRoll) s += ` vs ${defRoll.successes} Verteidigung`;
    s += ` = ${net} netto. `;

    if (net > 0) {
      const dmgLabel = dmgType === 'aggravated' ? 'aggraviierter' : 'oberflächlicher';
      s += `${damage} ${dmgLabel} Schaden`;
      if (onHitPowers.length) s += ` (${onHitPowers.join(', ')})`;
      s += '. ';
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
