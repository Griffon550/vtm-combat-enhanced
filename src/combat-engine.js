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
import { Log }        from './logger.js';
// Discipline system deactivated — will be added back manually piece by piece

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const CombatPhase = Object.freeze({
  SETUP:        'setup',
  INTENT:       'intent',
  RESOLUTION:   'resolution',
  STATE_UPDATE: 'state_update',
  DONE:         'done',
});

export const ActionType = Object.freeze({
  // ── Unbewaffnete Angriffe ──────────────────────────────────────────────────
  ATTACK_UNARMED:         'attack_unarmed',         // STR + BRAWL (Kraft)
  ATTACK_UNARMED_FINESSE: 'attack_unarmed_finesse', // DEX + BRAWL (Finesse)
  // ── Bewaffnete Nahkampf-Angriffe ──────────────────────────────────────────
  ATTACK_LIGHT:   'attack_light',   // DEX + MELEE  (leichte Waffe: Messer, Schwert)
  ATTACK_HEAVY:   'attack_heavy',   // STR + MELEE  (schwere Waffe: Axt, Zweihand)
  // ── Fernkampf-Angriffe ────────────────────────────────────────────────────
  ATTACK_RANGED:  'attack_ranged',  // DEX + FIREARMS
  ATTACK_AIMED:   'attack_aimed',   // WITS + FIREARMS (gezieltes Schießen)
  // ── Rückwärtskompatibel ───────────────────────────────────────────────────
  ATTACK_MELEE:   'attack_melee',
  // ── Andere ────────────────────────────────────────────────────────────────
  DEFEND:           'defend',
  DODGE:            'dodge',
  DISCIPLINE:       'discipline',
  SPECIAL:          'special',
  PASS:             'pass',
  // ── Dominate ────────────────────────────────────────────────────────────────
  DOMINATE_COMPEL:  'dominate_compel',  // Charisma + Dominate vs Resolve + Intelligence
});

// Physische Angriffs-Aktionstypen (für contested/opposed/unhindered Interaktionen)
const _PHYSICAL_ATTACK_SET = new Set([
  ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE,
  ActionType.ATTACK_LIGHT,   ActionType.ATTACK_HEAVY,
  ActionType.ATTACK_RANGED,  ActionType.ATTACK_AIMED, ActionType.ATTACK_MELEE,
]);

// Alle Interaktions-Aktionstypen (inkl. soziale Angriffe)
const _ATTACK_SET = new Set([..._PHYSICAL_ATTACK_SET, ActionType.DOMINATE_COMPEL]);


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

/**
 * Verteilt einen Pool gleichmäßig auf Ziele und gibt den Pool für das Ziel
 * am gegebenen Index zurück. Der Rest (bei ungeradem Pool oder ungerader Zielzahl)
 * geht an frühere Ziele (kleinere Indizes).
 *
 * Beispiel: Pool 7, 3 Ziele → [3, 2, 2]  (nicht [2, 2, 2] — 1 Würfel verloren)
 *
 * @param {number} total       Gesamtpool
 * @param {number} numTargets  Anzahl Ziele (≥ 1)
 * @param {number} targetIndex 0-basierter Index dieses Ziels
 * @returns {number}
 */
function _splitPool(total, numTargets, targetIndex) {
  if (numTargets <= 1) return total;
  const base      = Math.floor(total / numTargets);
  const remainder = total % numTargets;
  return Math.max(1, base + (targetIndex < remainder ? 1 : 0));
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
    health: {
      value:       10,
      max:         10,
      superficial: 0,
      aggravated:  0,
      ...data.health,
    },
    willpower:    { value: 3, max: 6, superficial: 0, aggravated: 0, ...data.willpower },
    hunger:       data.hunger     ?? 0,
    initiative:   data.initiative ?? 0,
    /** 'melee' | 'ranged' — Distanz zum nächsten Gegner */
    distance:     data.distance   ?? 'melee',
    statusEffects: Array.from(data.statusEffects ?? []),
    disciplines,
    attributes:   { strength: 2, dexterity: 2, wits: 2, stamina: 2, charisma: 2, manipulation: 2, resolve: 2, composure: 2, intelligence: 2, ...data.attributes },
    skills:       { brawl: 0, melee: 0, firearms: 0, athletics: 0, ...data.skills },
    bloodPotency:     data.bloodPotency !== undefined ? data.bloodPotency : null,
    inCover:          data.inCover ?? false,
    disciplinePowers:       Array.from(data.disciplinePowers ?? []),
    fleetnessActive:        false, // Reset jede Runde
    lightningStrikeActive:  false, // Reset jede Runde
    prowessActive:          false, // Reset jede Runde
    sparkOfRageActive:      false, // Reset jede Runde
    fistOfCaineActive:      false, // Reset jede Runde
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
    this.round = 1;

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

  setInCover(participantId, inCover) {
    const p = this._require(participantId);
    p.inCover = inCover;
    this._notify();
  }

  setFleetness(participantId, active) {
    const p = this._require(participantId);
    p.fleetnessActive = active;
    this._notify();
  }

  setLightningStrike(participantId, active) {
    const p = this._require(participantId);
    p.lightningStrikeActive = active;
    this._notify();
  }

  setProwess(participantId, active) {
    const p = this._require(participantId);
    p.prowessActive = active;
    this._notify();
  }

  setSparkOfRage(participantId, active) {
    const p = this._require(participantId);
    p.sparkOfRageActive = active;
    this._notify();
  }

  setFistOfCaine(participantId, active) {
    const p = this._require(participantId);
    p.fistOfCaineActive = active;
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
    const impaired = p.statusEffects?.includes(StatusEffect.IMPAIRED) ? 2 : 0;

    const pool     = Math.max(1, dex + wits - impaired);
    const hunger   = Math.min(p.hunger ?? 0, pool);
    const rollFn   = opts.roll ?? DiceEngine.roll;
    const result   = rollFn(pool, hunger);

    Log.debug(`Initiative ${p.name}: DEX(${dex}) + WIT(${wits})${impaired ? ` -${impaired} IMPAIRED` : ''} = ${pool} Würfel`);
    Log.roll(`${p.name} Initiative`, pool, hunger, result);

    p.initiative     = result.successes;
    p._initiativeDex = dex;
    this._notify();
    return {
      participantId: id,
      name:          p.name,
      dex, wits,
      pool,
      hungerDice:    hunger,
      roll:          result,
      successes:     result.successes,
      total:         p.initiative,
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
    // Normalisiere targetIds: bevorzuge explizites Array, falle auf targetId zurück
    const targetIds = intent.targetIds?.length
      ? Array.from(intent.targetIds)
      : (intent.targetId ? [intent.targetId] : []);

    p.intent = {
      actorId:        participantId,
      actionType:     intent.actionType    ?? ActionType.PASS,
      targetIds,
      targetId:       targetIds[0]         ?? null,   // Rückwärtskompatibilität
      activePowers:   Array.from(intent.activePowers ?? []),
      modifiers:      intent.modifiers     ?? {},
      disciplineUsed: intent.disciplineUsed ?? null,
      specialAction:  intent.specialAction  ?? null,
      weapon:         intent.weapon         ?? null,
      bloodSurge:     intent.bloodSurge     ?? false,
    };
    this._notify();
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  startResolutionPhase() {
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
    const roundCtx = { defenseCount: new Map(), hasAttacked: new Set() };

    const interactions = this._buildInteractions();
    Log.group(`Runde ${this.round} — Auflösung (${interactions.length} Interaktion${interactions.length !== 1 ? 'en' : ''})`);
    if (interactions.length) {
      Log.debug('Interaktionen:', interactions.map(i => `${i.type}: ${i.attacker.name} → ${i.defender?.name ?? '?'}`).join(', '));
    }

    // 1. Angriffs-Interaktionen (contested / opposed / unhindered)
    for (const interaction of interactions) {
      // Angreifer-Intent könnte durch frühere Disziplin (Compel) auf null gesetzt worden sein
      if (!interaction.attacker.intent) continue;
      const r = this._resolveInteraction(interaction, diceOverride, roundCtx);
      if (r) {
        if (Array.isArray(r)) { results.push(...r); this.log.push(...r); }
        else                  { results.push(r);    this.log.push(r);    }
      }
    }

    // 2. Nicht-Angriffs-Aktionen (Disziplin, Sonderaktion) in Initiativereihenfolge
    for (const actor of this.getInitiativeOrder()) {
      if (!actor.intent || this._isIncapacitated(actor)) continue;
      const at = actor.intent.actionType;
      if (_ATTACK_SET.has(at) || at === ActionType.DEFEND || at === ActionType.DODGE || at === ActionType.PASS) continue;
      const r = this._resolveOne(actor, diceOverride, roundCtx);
      if (r) {
        if (Array.isArray(r)) { results.push(...r); this.log.push(...r); }
        else                  { results.push(r);    this.log.push(r);    }
      }
    }

    Log.debug(`Runde ${this.round} abgeschlossen — ${results.length} Ergebnis${results.length !== 1 ? 'se' : ''}`);
    Log.groupEnd();
    this.setPhase(CombatPhase.STATE_UPDATE);
    return results;
  }

  /**
   * Löst eine einzelne Nicht-Angriffs-Aktion auf.
   * Angriffe laufen jetzt durch das Interaktionssystem (_buildInteractions → _resolveInteraction).
   */
  _resolveOne(actor, dice, roundCtx) {
    const { actionType } = actor.intent;
    if (_ATTACK_SET.has(actionType))                                   return null;
    if (actionType === ActionType.DEFEND || actionType === ActionType.DODGE) return null;
    switch (actionType) {
      case ActionType.DISCIPLINE: return this._resolveDiscipline(actor);
      case ActionType.SPECIAL:    return this._resolveSpecial(actor);
      default:                    return null;
    }
  }

  // ─── Interaktionssystem ───────────────────────────────────────────────────

  /**
   * Leitet die Reaktionsweise eines Verteidigers gegenüber einem bestimmten Angreifer ab.
   * @param {Participant} defender
   * @param {string}      attackerId
   * @returns {'attacking_back'|'defending'|'none'}
   */
  _inferReactionType(defender, attackerId) {
    const intent = defender.intent;
    if (!intent) return 'none';
    if (_PHYSICAL_ATTACK_SET.has(intent.actionType)) {
      const tids = intent.targetIds?.length ? intent.targetIds
                 : (intent.targetId ? [intent.targetId] : []);
      if (tids.includes(attackerId)) return 'attacking_back';
    }
    if (intent.actionType === ActionType.DEFEND || intent.actionType === ActionType.DODGE) {
      return 'defending';
    }
    return 'none';
  }

  /**
   * Baut alle Kampf-Interaktionspaare aus den deklarierten Intents.
   * Contested-Paare (A→B und B→A) werden dedupliziert.
   * @returns {Array<{type:'contested'|'opposed'|'unhindered', attacker:Participant, defender:Participant}>}
   */
  _buildInteractions() {
    const interactions = [];
    const handled      = new Set(); // deduplizierte Paare: "id1§id2" (sortiert)

    for (const actor of this.getInitiativeOrder()) {
      if (!actor.intent || !_ATTACK_SET.has(actor.intent.actionType)) continue;
      if (this._isIncapacitated(actor)) continue;

      const actionType = actor.intent.actionType;
      const targetIds  = actor.intent.targetIds?.length ? actor.intent.targetIds
                       : (actor.intent.targetId ? [actor.intent.targetId] : []);

      // ── Soziale Aktionen (Compel etc.): eigene Interaktionstyp, kein Dedup ──
      if (actionType === ActionType.DOMINATE_COMPEL) {
        for (const targetId of targetIds) {
          const defender = this.participants.get(targetId);
          if (!defender) continue;
          interactions.push({ type: 'compel', attacker: actor, defender });
        }
        continue;
      }

      // ── Physische Angriffe: contested / opposed / unhindered (mit Dedup) ───
      for (const targetId of targetIds) {
        const defender = this.participants.get(targetId);
        if (!defender || this._isIncapacitated(defender)) continue;

        const pairKey = [actor.id, targetId].sort().join('§');
        if (handled.has(pairKey)) continue;
        handled.add(pairKey);

        const reaction = this._inferReactionType(defender, actor.id);
        interactions.push({
          type:     reaction === 'attacking_back' ? 'contested'
                  : reaction === 'defending'       ? 'opposed'
                  :                                  'unhindered',
          attacker: actor,
          defender,
        });
      }
    }
    return interactions;
  }

  /** Dispatcht eine Interaktion zum passenden Auflösungstyp. */
  _resolveInteraction(interaction, dice, roundCtx) {
    const { type, attacker, defender } = interaction;
    switch (type) {
      case 'contested':  return this._resolveContested(attacker, defender, dice, roundCtx);
      case 'opposed':    return this._resolveOpposed(attacker, defender, dice, roundCtx);
      case 'unhindered': return this._resolveUnhindered(attacker, defender, dice, roundCtx);
      case 'compel':     return this._resolveCompel(attacker, defender, dice, roundCtx);
      default: return null;
    }
  }

  /**
   * Dominate 1 — Compel: Manipulation+Dominate vs Resolve+Intelligence.
   * Bei Erfolg verliert das Ziel seine Aktion (intent = null) und befolgt den Befehl.
   */
  _resolveCompel(attacker, defender, dice, roundCtx) {
    const rollFn   = dice?.roll ?? DiceEngine.roll;
    const intent   = attacker.intent;

    Log.group(`Compel: ${attacker.name} → ${defender.name}`);

    // ── Angriffspool: Charisma + Dominate-Rang ──────────────────────────────────
    const bd        = this._getAttackPool(attacker, ActionType.DOMINATE_COMPEL, []);
    const atkPool   = bd.total;
    const atkHunger = Math.min(attacker.hunger ?? 0, atkPool);
    Log.pool('Compel-Angriff', bd);
    const attackRoll = rollFn(atkPool, atkHunger);
    Log.roll(`${attacker.name} Compel`, atkPool, atkHunger, attackRoll);
    const atkSuccesses = attackRoll.successes;

    // ── Verteidigungspool: Resolve + Intelligence (kein Hunger) ───────────────
    const resolve      = defender.attributes.resolve      ?? 1;
    const intelligence = defender.attributes.intelligence ?? 2;
    const impairedDef  = defender.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const defPool      = Math.max(1, resolve + intelligence - impairedDef);
    const defBdLog = { attrName: 'Entschlossenheit', attrVal: resolve, skillName: 'Intelligenz', skillVal: intelligence, impaired: impairedDef, total: defPool, hungerDice: 0 };
    Log.pool('Widerstand', defBdLog);
    const defenseRoll  = rollFn(defPool, 0);
    Log.roll(`${defender.name} Widerstand`, defPool, 0, defenseRoll);
    const defSuccesses = defenseRoll.successes;

    const netSuccesses = Math.max(0, atkSuccesses - defSuccesses);
    Log.outcome(attacker.name, defender.name, atkSuccesses, defSuccesses, netSuccesses, 0, 0, null);
    const effects      = [];

    if (netSuccesses > 0) {
      // Ziel steht unter Compel-Einfluss und verliert seine Aktion
      defender.intent = null;
      effects.push(`${defender.name} steht unter dem Einfluss von Compel und verliert seine Aktion.`);
    }

    roundCtx?.hasAttacked.add(attacker.id);

    const defBd = {
      attrName: 'Entschlossenheit', attrVal: resolve,
      skillName: 'Intelligenz',     skillVal: intelligence,
      total: defPool, hungerDice: 0, impaired: impairedDef,
    };

    Log.groupEnd();
    return {
      attackerId:   attacker.id,  attackerName: attacker.name,
      defenderId:   defender.id,  defenderName: defender.name,
      actionType:   ActionType.DOMINATE_COMPEL, interactionType: 'compel',
      attackRoll, defenseRoll,
      netSuccesses, rawDamage: 0, damage: 0, damageType: null,
      effects,
      breakdown: { attack: bd, defense: defBd },
      narrative: netSuccesses > 0
        ? `${attacker.name} zwingt ${defender.name} mit Compel: ${atkSuccesses}:${defSuccesses} → ${netSuccesses} Nettoerfolge.`
        : `${attacker.name} scheitert mit Compel gegen ${defender.name}: ${atkSuccesses}:${defSuccesses}.`,
    };
  }

  /**
   * Typ A: Beide greifen sich gegenseitig an → contested roll.
   * Nur der Charakter mit mehr Erfolgen trifft; Schaden = Nettoerfolge + Boni.
   */
  _resolveContested(initiator, counterpart, dice, roundCtx) {
    const rollFn = dice?.roll ?? DiceEngine.roll;
    Log.group(`Contested: ${initiator.name} ↔ ${counterpart.name}`);

    const bdI    = this._getAttackPool(initiator,   initiator.intent.actionType,   initiator.intent.activePowers   ?? []);
    const bdC    = this._getAttackPool(counterpart,  counterpart.intent.actionType, counterpart.intent.activePowers ?? []);
    Log.pool(`${initiator.name} Angriff`,   bdI);
    Log.pool(`${counterpart.name} Angriff`, bdC);

    const numI   = initiator.intent.targetIds?.length   || 1;
    const numC   = counterpart.intent.targetIds?.length || 1;
    const idxI   = initiator.intent.targetIds?.indexOf(counterpart.id) ?? 0;
    const idxC   = counterpart.intent.targetIds?.indexOf(initiator.id)  ?? 0;
    const modI   = initiator.intent.poolModifier   ?? 0;
    const modC   = counterpart.intent.poolModifier ?? 0;
    const splI   = Math.max(1, _splitPool(bdI.total + modI, numI, idxI));
    const splC   = Math.max(1, _splitPool(bdC.total + modC, numC, idxC));
    const hunI   = Math.min(initiator.hunger   ?? 0, splI);
    const hunC   = Math.min(counterpart.hunger ?? 0, splC);

    const rollI  = rollFn(splI, hunI);
    const rollC  = rollFn(splC, hunC);
    Log.roll(`${initiator.name}`,   splI, hunI, rollI);
    Log.roll(`${counterpart.name}`, splC, hunC, rollC);
    let succI  = rollI.successes + (bdI.autoSuccesses ?? 0);
    let succC  = rollC.successes + (bdC.autoSuccesses ?? 0);

    // Lightning Strike (Celerity 5): Gegenangreifer gilt als hätte nur 1 Erfolg
    const lsI = initiator.lightningStrikeActive   && (initiator.disciplinePowers   ?? []).includes('Lightning Strike');
    const lsC = counterpart.lightningStrikeActive && (counterpart.disciplinePowers ?? []).includes('Lightning Strike');
    if (lsI) { Log.debug(`Lightning Strike: ${counterpart.name} wird auf 1 Erfolg begrenzt`); succC = Math.min(succC, 1); }
    if (lsC) { Log.debug(`Lightning Strike: ${initiator.name} wird auf 1 Erfolg begrenzt`);   succI = Math.min(succI, 1); }

    roundCtx?.hasAttacked.add(initiator.id);
    roundCtx?.hasAttacked.add(counterpart.id);

    const splitBdI = { ...bdI, total: splI, hungerDice: hunI, splitCount: numI > 1 ? numI : 0 };
    const splitBdC = { ...bdC, total: splC, hungerDice: hunC, splitCount: numC > 1 ? numC : 0 };

    // Gleichstand → niemand trifft
    if (succI === succC) {
      Log.debug(`Gleichstand ${succI}:${succC} — niemand trifft.`);
      Log.groupEnd();
      return {
        attackerId: initiator.id, attackerName: initiator.name,
        defenderId: counterpart.id, defenderName: counterpart.name,
        actionType: initiator.intent.actionType, interactionType: 'contested',
        attackRoll: rollI, defenseRoll: rollC,
        netSuccesses: 0, rawDamage: 0, damage: 0, damageType: null,
        effects: [],
        breakdown: { attack: splitBdI, defense: splitBdC },
        contestedNames: { winner: null, loser: null, initiator: initiator.name, counterpart: counterpart.name },
        narrative: `${initiator.name} vs ${counterpart.name}: Gleichstand (${succI}:${succC}) — niemand trifft.`,
      };
    }

    const winner     = succI > succC ? initiator   : counterpart;
    const loser      = succI > succC ? counterpart  : initiator;
    const winnerRoll = succI > succC ? rollI        : rollC;
    const loserRoll  = succI > succC ? rollC        : rollI;
    const winnerBd   = succI > succC ? splitBdI     : splitBdC;
    const loserBd    = succI > succC ? splitBdC     : splitBdI;
    const winnerSucc = Math.max(succI, succC);
    const loserSucc  = Math.min(succI, succC);
    const netSuccesses = winnerSucc - loserSucc;

    const weapon          = winner.intent.weapon ?? winner.weapon ?? WEAPON_TABLE.UNARMED;
    const weaponDmgBonus  = Number(weapon.damageBonus ?? 0);
    const potenceDmgBonus = this._getPotenceDamageBonus(winner, winner.intent.actionType);
    const baseDamage      = netSuccesses + weaponDmgBonus + potenceDmgBonus;
    Log.debug(`Waffe: ${weapon.name}, Bonus: ${weaponDmgBonus}${potenceDmgBonus ? ` +${potenceDmgBonus} Prowess` : ''}, Rohschaden: ${baseDamage}`);

    const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
    const damageType = weaponForcesAgg ? DamageType.AGGRAVATED
                     : this._getPotenceDamageType(winner, winner.intent.actionType, loser, DamageType.SUPERFICIAL);

    const actualDamage = this._applyDamageReduction(baseDamage, damageType, loser);
    const effects = [];
    if (actualDamage > 0) this._applyDamage(loser, actualDamage, damageType, effects);

    Log.outcome(winner.name, loser.name, winnerSucc, loserSucc, netSuccesses, baseDamage, actualDamage, damageType);
    if (effects.length) Log.debug(`Effekte: ${effects.join(', ')}`);
    Log.groupEnd();
    return {
      attackerId:   winner.id,   attackerName: winner.name,
      defenderId:   loser.id,    defenderName: loser.name,
      actionType:   winner.intent.actionType, interactionType: 'contested',
      weapon:       weapon.name, attackRoll: winnerRoll, defenseRoll: loserRoll,
      netSuccesses, rawDamage: baseDamage, damage: actualDamage, damageType,
      prowessDamageBonus: potenceDmgBonus,
      effects,
      breakdown: { attack: winnerBd, defense: loserBd },
      contestedNames: { winner: winner.name, loser: loser.name,
                        initiator: initiator.name, counterpart: counterpart.name },
      narrative: `${winner.name} gewinnt den Austausch gegen ${loser.name}: ${winnerSucc}:${loserSucc} → ${netSuccesses} netto → ${actualDamage} Schaden.`,
    };
  }

  /**
   * Typ B: Angriff gegen aktive Verteidigung → opposed roll (bisheriges Verhalten).
   */
  _resolveOpposed(attacker, defender, dice, roundCtx) {
    const rollFn       = dice?.roll ?? DiceEngine.roll;
    const intent       = attacker.intent;
    const activePowers = intent.activePowers ?? [];

    Log.group(`Opposed: ${attacker.name} → ${defender?.name ?? '?'}`);
    roundCtx?.hasAttacked.add(attacker.id);

    const numTargets   = intent.targetIds?.length || 1;
    const targetIndex  = intent.targetIds?.indexOf(defender.id) ?? 0;
    const atkBd        = this._getAttackPool(attacker, intent.actionType, activePowers);
    const poolMod      = intent.poolModifier ?? 0;
    const splitTotal   = Math.max(1, _splitPool(atkBd.total + poolMod, numTargets, targetIndex));
    const splitHunger  = Math.min(attacker.hunger ?? 0, splitTotal);
    const splitBd      = { ...atkBd, total: splitTotal, hungerDice: splitHunger, splitCount: numTargets > 1 ? numTargets : 0 };
    Log.pool(`${attacker.name} Angriff`, splitBd);

    const weapon = intent.weapon ?? attacker.weapon ?? WEAPON_TABLE.UNARMED;

    const attackRoll        = rollFn(splitTotal, splitHunger);
    Log.roll(`${attacker.name} Angriff`, splitTotal, splitHunger, attackRoll);
    const totalAtkSuccesses = attackRoll.successes + (atkBd.autoSuccesses ?? 0);

    let defenseRoll = null, defenseSuccesses = 0, defBd = null, defenseBlocked = false;
    if (defender && !this._isIncapacitated(defender)) {
      defenseBlocked = defender.statusEffects.includes(StatusEffect.RESTRAINED)
                    || defender.statusEffects.includes(StatusEffect.SURPRISED);
      if (defenseBlocked) {
        Log.debug(`${defender.name} kann sich nicht verteidigen (RESTRAINED/SURPRISED)`);
      }
      if (!defenseBlocked) {
        const prevDef            = roundCtx?.defenseCount.get(defender.id) ?? 0;
        const hasAttackedPenalty = (roundCtx?.hasAttacked.has(defender.id) && prevDef === 0) ? 1 : 0;
        const multiDefPenalty    = Math.max(0, prevDef + hasAttackedPenalty);
        const ti                 = defender.intent ?? { actionType: ActionType.DEFEND };
        defBd         = this._getDefensePool(defender, ti, multiDefPenalty, { prevDefenses: prevDef, hasAttackedPenalty }, intent.actionType);
        Log.pool(`${defender.name} Verteidigung`, defBd);
        // Lightning Strike (Celerity 5): Verteidiger gilt als hätte nur 1 Erfolg erzielt
        if (attacker.lightningStrikeActive
            && (attacker.disciplinePowers ?? []).includes('Lightning Strike')) {
          defenseSuccesses = 1;
          defenseRoll = { successes: 1, _lightningStrike: true };
          Log.debug(`Lightning Strike: ${defender.name} wird auf 1 Verteidigungserfolg begrenzt`);
        } else {
          defenseRoll      = rollFn(defBd.total, defBd.hungerDice);
          Log.roll(`${defender.name} Verteidigung`, defBd.total, defBd.hungerDice, defenseRoll);
          defenseSuccesses = defenseRoll.successes;
        }
        roundCtx?.defenseCount.set(defender.id, prevDef + 1);
      }
    }

    const netSuccesses    = Math.max(0, totalAtkSuccesses - defenseSuccesses);
    const weaponDmgBonus  = Number(weapon.damageBonus ?? 0);
    const potenceDmgBonus = this._getPotenceDamageBonus(attacker, intent.actionType);
    const baseDamage      = netSuccesses > 0 ? netSuccesses + weaponDmgBonus + potenceDmgBonus : 0;

    const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
    const damageType = weaponForcesAgg ? DamageType.AGGRAVATED
                     : this._getPotenceDamageType(attacker, intent.actionType, defender, DamageType.SUPERFICIAL);

    const actualDamage = this._applyDamageReduction(baseDamage, damageType, defender);
    const effects = [];
    if (defender && netSuccesses > 0) {
      if (actualDamage > 0) this._applyDamage(defender, actualDamage, damageType, effects);
    }

    Log.outcome(attacker.name, defender?.name ?? '?', totalAtkSuccesses, defenseSuccesses, netSuccesses, baseDamage, actualDamage, damageType);
    if (effects.length) Log.debug(`Effekte: ${effects.join(', ')}`);
    Log.groupEnd();
    return {
      attackerId: attacker.id, attackerName: attacker.name,
      defenderId: defender?.id ?? null, defenderName: defender?.name ?? null,
      actionType: intent.actionType, interactionType: 'opposed',
      weapon: weapon.name, attackRoll, defenseRoll,
      netSuccesses, rawDamage: baseDamage, damage: actualDamage, damageType,
      prowessDamageBonus: potenceDmgBonus,
      effects,
      defenseBlocked, splitCount: numTargets > 1 ? numTargets : 0,
      breakdown: { attack: splitBd, defense: defBd },
      narrative: this._narrative(attacker, defender, attackRoll, defenseRoll,
                   netSuccesses, actualDamage, damageType, effects, splitBd,
                   weapon, numTargets),
    };
  }

  /**
   * Typ C: Ziel reagiert nicht auf diesen Angreifer → ungehinderter Angriff.
   * Option 2: min. 1 Erfolg nötig; alle Erfolgswürfel landen (kein Verteidigungswurf).
   */
  _resolveUnhindered(attacker, defender, dice, roundCtx) {
    const rollFn       = dice?.roll ?? DiceEngine.roll;
    const intent       = attacker.intent;
    const activePowers = intent.activePowers ?? [];

    Log.group(`Unhindered: ${attacker.name} → ${defender?.name ?? '?'}`);
    roundCtx?.hasAttacked.add(attacker.id);

    const numTargets  = intent.targetIds?.length || 1;
    const targetIndex = intent.targetIds?.indexOf(defender?.id) ?? 0;
    const atkBd       = this._getAttackPool(attacker, intent.actionType, activePowers);
    const poolMod     = intent.poolModifier ?? 0;
    const splitTotal  = Math.max(1, _splitPool(atkBd.total + poolMod, numTargets, targetIndex));
    const splitHunger = Math.min(attacker.hunger ?? 0, splitTotal);
    const splitBd     = { ...atkBd, total: splitTotal, hungerDice: splitHunger, splitCount: numTargets > 1 ? numTargets : 0 };
    Log.pool(`${attacker.name} Angriff`, splitBd);

    const weapon = intent.weapon ?? attacker.weapon ?? WEAPON_TABLE.UNARMED;

    const attackRoll = rollFn(splitTotal, splitHunger);
    Log.roll(`${attacker.name} Angriff`, splitTotal, splitHunger, attackRoll);
    const successes  = attackRoll.successes + (atkBd.autoSuccesses ?? 0);

    // Option 2: mindestens 1 Erfolg nötig
    if (successes < 1) {
      Log.debug(`Fehlschlag: 0 Erfolge — kein Schaden.`);
      Log.groupEnd();
      return {
        attackerId: attacker.id, attackerName: attacker.name,
        defenderId: defender?.id ?? null, defenderName: defender?.name ?? null,
        actionType: intent.actionType, interactionType: 'unhindered',
        weapon: weapon.name, attackRoll, defenseRoll: null,
        netSuccesses: 0, rawDamage: 0, damage: 0, damageType: DamageType.SUPERFICIAL,
        effects: [], breakdown: { attack: splitBd, defense: null },
        defenseBlocked: false,
        narrative: `${attacker.name} → ${defender?.name ?? '?'}: Fehlschlag (0 Erfolge).`,
      };
    }

    const weaponDmgBonus  = Number(weapon.damageBonus ?? 0);
    const potenceDmgBonus = this._getPotenceDamageBonus(attacker, intent.actionType);
    const baseDamage      = successes + weaponDmgBonus + potenceDmgBonus;

    const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
    const damageType = weaponForcesAgg ? DamageType.AGGRAVATED
                     : this._getPotenceDamageType(attacker, intent.actionType, defender, DamageType.SUPERFICIAL);

    const actualDamage = this._applyDamageReduction(baseDamage, damageType, defender);
    const effects = [];
    if (defender && actualDamage > 0) this._applyDamage(defender, actualDamage, damageType, effects);

    Log.outcome(attacker.name, defender?.name ?? '?', successes, 0, successes, baseDamage, actualDamage, damageType);
    if (effects.length) Log.debug(`Effekte: ${effects.join(', ')}`);
    Log.groupEnd();
    return {
      attackerId: attacker.id,  attackerName: attacker.name,
      defenderId: defender?.id  ?? null, defenderName: defender?.name ?? null,
      actionType: intent.actionType, interactionType: 'unhindered',
      weapon: weapon.name, attackRoll, defenseRoll: null,
      netSuccesses: successes, rawDamage: baseDamage, damage: actualDamage, damageType,
      prowessDamageBonus: potenceDmgBonus,
      effects,
      defenseBlocked: false, splitCount: numTargets > 1 ? numTargets : 0,
      breakdown: { attack: splitBd, defense: null },
      narrative: this._narrative(attacker, defender, attackRoll, null,
                   successes, actualDamage, damageType, effects, splitBd,
                   weapon, numTargets),
    };
  }

  // ─── Attack resolution ────────────────────────────────────────────────────

  _resolveAttack(attacker, dice, roundCtx = null) {
    const intent       = attacker.intent;
    const activePowers = intent.activePowers ?? [];

    // Angreifer als "hat angegriffen" markieren (zählt für dessen eigene Verteidigung später)
    roundCtx?.hasAttacked.add(attacker.id);

    // ── Ziele bestimmen ───────────────────────────────────────────────────────
    const targetIds = intent.targetIds?.length
      ? intent.targetIds
      : (intent.targetId ? [intent.targetId] : [null]);
    const numTargets = targetIds.length;

    // ── Effektive Waffe: intent → ausgerüstete Waffe → Unbewaffnet ────────────
    const weapon = intent.weapon ?? attacker.weapon ?? WEAPON_TABLE.UNARMED;

    // ── Angriffspool (einmal für alle Ziele berechnen, dann aufteilen) ────────
    const atkBreakdown = this._getAttackPool(attacker, intent.actionType, activePowers);
    const rollFn       = dice?.roll ?? DiceEngine.roll;

    // ── Loop über alle Ziele ──────────────────────────────────────────────────
    const results = [];

    for (let tIdx = 0; tIdx < targetIds.length; tIdx++) {
      const targetId    = targetIds[tIdx];
      const target      = targetId ? this.participants.get(targetId) : null;

      // Pool für dieses Ziel (Rest geht an frühere Ziele)
      const splitTotal  = _splitPool(atkBreakdown.total, numTargets, tIdx);
      const splitHunger = Math.min(attacker.hunger ?? 0, splitTotal);

      // Aufgeteiltes Pool-Breakdown für dieses Ziel
      const splitBreakdown = {
        ...atkBreakdown,
        total:      splitTotal,
        hungerDice: splitHunger,
        splitCount: numTargets > 1 ? numTargets : 0,
      };

      // Angriffsroll mit aufgeteiltem Pool
      const attackRoll        = rollFn(splitTotal, splitHunger);
      const totalAtkSuccesses = attackRoll.successes + (atkBreakdown.autoSuccesses ?? 0);

      // ── Verteidigungspool — Multi-Defense-System ────────────────────────────
      //   defense_pool = base - prevDefenses - attackedPenalty + celerityReduction
      //   RESTRAINED / SURPRISED → kein Abwehrwurf

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
          const multiDefPenalty    = Math.max(0, prevDefenses + hasAttackedPenalty);

          const ti     = target.intent ?? { actionType: ActionType.DEFEND };
          defBreakdown = this._getDefensePool(target, ti, multiDefPenalty, {
            prevDefenses, hasAttackedPenalty,
          }, intent.actionType);
          defenseRoll      = rollFn(defBreakdown.total, defBreakdown.hungerDice);
          defenseSuccesses = defenseRoll.successes;

          // Verteidigungszähler erhöhen — nächster Angriff kostet 1 Würfel mehr
          roundCtx?.defenseCount.set(target.id, prevDefenses + 1);
        }
      }

      // ── Netto-Erfolge & Rohschaden ──────────────────────────────────────────
      const netSuccesses   = Math.max(0, totalAtkSuccesses - defenseSuccesses);
      const weaponDmgBonus = Number(weapon.damageBonus ?? 0);
      const baseDamage     = netSuccesses > 0 ? netSuccesses + weaponDmgBonus : 0;

      // Schadenstyp: Waffe → Standard superficial
      const weaponForcesAgg = weapon.damageType === DamageType.AGGRAVATED;
      const damageType = weaponForcesAgg ? DamageType.AGGRAVATED : DamageType.SUPERFICIAL;

      // ── Schadensreduktion (Rüstung, Vampir-Halbierung) ────────────────────
      const actualDamage = this._applyDamageReduction(baseDamage, damageType, target);

      // ── Schaden anwenden ──────────────────────────────────────────────────
      const effects = [];
      if (target && netSuccesses > 0) {
        if (actualDamage > 0) this._applyDamage(target, actualDamage, damageType, effects);
      }

      results.push({
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
        defenseBlocked,
        splitCount:   numTargets > 1 ? numTargets : 0,
        breakdown:    { attack: splitBreakdown, defense: defBreakdown },
        narrative:    this._narrative(attacker, target, attackRoll, defenseRoll,
                        netSuccesses, actualDamage, damageType, effects, splitBreakdown,
                        weapon, numTargets),
      });
    }

    return results;
  }

  // ─── Attack pool helper ───────────────────────────────────────────────────
  //
  // Returns the fully-computed attack pool breakdown for a given action type.
  // Applies IMPAIRED penalty (-2 dice) automatically.
  //
  // @param {Participant} attacker
  // @param {string}      actionType  one of ActionType.*
  // @returns {{ total, hungerDice, attrName, attrVal, skillName, skillVal, impaired }}

  _getAttackPool(attacker, actionType, activePowers) {
    let attrVal, attrName, skillVal, skillName;

    switch (actionType) {
      case ActionType.ATTACK_UNARMED:
        attrVal = attacker.attributes.strength;   attrName  = 'Stärke';
        skillVal = attacker.skills.brawl ?? 0;    skillName = 'Raufen';
        break;
      case ActionType.ATTACK_UNARMED_FINESSE:
        attrVal = attacker.attributes.dexterity;  attrName  = 'Geschicklichkeit';
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
      case ActionType.DOMINATE_COMPEL:
        attrVal  = attacker.attributes.charisma              ?? 1; attrName  = 'Charisma';
        skillVal = attacker.disciplines?.dominate?.rating    ?? 0; skillName = 'Dominate';
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

    // ── Prowess (Potence 2): +Potence-Rating auf Nahkampfangriffe ────────────
    const _PROWESS_ACTIONS = new Set([
      ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE,
      ActionType.ATTACK_LIGHT,   ActionType.ATTACK_HEAVY, ActionType.ATTACK_MELEE,
    ]);
    let prowessBonus = 0;
    if (attacker.prowessActive
        && (attacker.disciplinePowers ?? []).includes('Prowess')
        && _PROWESS_ACTIONS.has(actionType)) {
      prowessBonus = attacker.disciplines?.potence?.rating ?? 0;
    }

    // ── Spark of Rage (Potence 4): +2 auf alle physischen Angriffe ───────────
    let sparkBonus = 0;
    if (attacker.sparkOfRageActive
        && (attacker.disciplinePowers ?? []).includes('Spark of Rage')
        && _PHYSICAL_ATTACK_SET.has(actionType)) {
      sparkBonus = 2;
    }

    const impaired = attacker.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const total    = Math.max(1, attrVal + skillVal + prowessBonus + sparkBonus - impaired);

    return {
      total,
      hungerDice:    Math.min(attacker.hunger ?? 0, total),
      autoSuccesses: 0,
      attrName, attrVal, skillName, skillVal,
      impaired,
      prowessBonus, sparkBonus,
    };
  }

  // ─── Potence damage helpers ───────────────────────────────────────────────

  /**
   * Schadenstyp-Override durch Potence.
   * Lethal Body (Potence 1): Unbewaffnet → aggravated gegen Sterbliche.
   * Fist of Caine (Potence 5): Unbewaffnet → aggravated gegen Vampire.
   */
  _getPotenceDamageType(attacker, actionType, target, baseDamageType) {
    const UNARMED = new Set([ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE]);
    if (!UNARMED.has(actionType)) return baseDamageType;
    const powers = attacker.disciplinePowers ?? [];
    const targetIsVampire = target?.bloodPotency !== null && target?.bloodPotency !== undefined;

    if (powers.includes('Lethal Body') && !targetIsVampire) return DamageType.AGGRAVATED;
    if (attacker.fistOfCaineActive && powers.includes('Fist of Caine') && targetIsVampire) {
      return DamageType.AGGRAVATED;
    }
    return baseDamageType;
  }

  /**
   * Schadensbonus durch Prowess (Potence 2): +Potence-Rating auf Nahkampfschaden.
   */
  _getPotenceDamageBonus(attacker, actionType) {
    const PROWESS_ACTIONS = new Set([
      ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE,
      ActionType.ATTACK_LIGHT,   ActionType.ATTACK_HEAVY, ActionType.ATTACK_MELEE,
    ]);
    if (attacker.prowessActive
        && (attacker.disciplinePowers ?? []).includes('Prowess')
        && PROWESS_ACTIONS.has(actionType)) {
      return attacker.disciplines?.potence?.rating ?? 0;
    }
    return 0;
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
   * @param {number}      multiDefPenalty   Kumulativer Malus (bereits durch Celerity reduziert)
   * @param {object}      [debugInfo]       { prevDefenses, hasAttackedPenalty, celerityReduction }
   * @param {string|null} [attackActionType] Angriffstyp des Angreifers (für Fernkampf-Malus)
   */
  _getDefensePool(target, intent, multiDefPenalty = 0, debugInfo = {}, attackActionType = null) {
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

    // ── Fernkampf-Malus: -2 ohne Deckung, außer Rapid Reflexes (konkret gelernt) ──
    const RANGED_ATTACKS = new Set([ActionType.ATTACK_RANGED, ActionType.ATTACK_AIMED]);
    let rangedPenalty = 0;
    let rapidReflexesActive = false;
    if (attackActionType && RANGED_ATTACKS.has(attackActionType)) {
      const hasCover         = target.inCover ?? false;
      const hasRapidReflexes = (target.disciplinePowers ?? []).includes('Rapid Reflexes');
      rapidReflexesActive    = hasRapidReflexes;
      if (!hasCover && !hasRapidReflexes) rangedPenalty = 2;
    }

    // ── Fleetness (Celerity 2, konkret gelernt): +Celerity-Rang auf Dodge ──────
    let fleetnessDice = 0;
    if (isDodge && (target.fleetnessActive ?? false)
        && (target.disciplinePowers ?? []).includes('Fleetness')) {
      fleetnessDice = target.disciplines?.celerity?.rating ?? 0;
    }

    const impaired   = target.statusEffects.includes(StatusEffect.IMPAIRED) ? 2 : 0;
    const rawTotal   = Math.max(1, attrVal + skillVal + fleetnessDice - impaired - rangedPenalty);
    const total      = Math.max(1, rawTotal - multiDefPenalty);
    const hungerDice = Math.min(target.hunger ?? 0, total);

    return {
      total, hungerDice, attrName, attrVal, skillName, skillVal,
      impaired, rangedPenalty, rapidReflexesActive,
      fleetnessDice, multiDefPenalty, rawTotal,
      prevDefenses:       debugInfo.prevDefenses       ?? 0,
      hasAttackedPenalty: debugInfo.hasAttackedPenalty ?? 0,
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

    let damage = rawDamage;

    // 1. Rüstung
    const armorReduction = target.armor?.reduction ?? 0;
    if (armorReduction > 0) {
      damage = Math.max(0, damage - armorReduction);
      Log.debug(`Schadensreduktion ${target.name}: -${armorReduction} Rüstung → ${damage}`);
    }

    // 2. Nur Vampire halbieren oberflächlichen Schaden (V5: Menschen nicht)
    const isVampire = target.bloodPotency !== null && target.bloodPotency !== undefined;
    if (isVampire && type === DamageType.SUPERFICIAL) {
      const before = damage;
      damage = Math.ceil(damage / 2);
      Log.debug(`Schadensreduktion ${target.name}: Vampir-Halbierung ${before} → ${damage} superficial`);
    }

    return damage;
  }

  /**
   * Trägt Schaden in den Health Track ein.
   *
   * V5-Regeln:
   *   - Superficial füllt leere Kästen. Wenn alle Kästen voll (sup+agg=max),
   *     upgrades jeder weitere superficial-Punkt einen bestehenden sup-Kasten zu agg.
   *   - Aggravated geht direkt in agg-Kästen.
   *   - Alle Kästen gefüllt (sup+agg >= max)  → IMPAIRED (−2)
   *   - Alle Kästen aggraviiert (agg >= max)  → TORPOR (Vampir) / DISABLED (Mensch)
   */
  _applyDamage(target, amount, type, effects) {
    if (amount <= 0) return;
    const max = target.health.max;
    let sup   = target.health.superficial ?? 0;
    let agg   = target.health.aggravated  ?? 0;

    if (type === DamageType.AGGRAVATED) {
      agg = Math.min(max, agg + amount);
    } else {
      // Phase 1: leere Kästen mit superficial füllen
      const empty     = Math.max(0, max - sup - agg);
      const fillEmpty = Math.min(amount, empty);
      sup            += fillEmpty;
      const overflow  = amount - fillEmpty;

      // Phase 2: Überschuss upgraded bestehende sup-Kästen zu agg
      if (overflow > 0 && sup > 0) {
        const upgrade = Math.min(overflow, sup);
        sup -= upgrade;
        agg  = Math.min(max, agg + upgrade);
      }
    }

    // Sicherheitsbegrenzung
    agg = Math.min(max, agg);
    sup = Math.min(max - agg, sup);

    target.health.superficial = sup;
    target.health.aggravated  = agg;
    target.health.value       = Math.max(0, max - sup - agg);

    this._checkStatus(target, effects);
  }

  _checkStatus(target, effects) {
    const max         = target.health.max;
    const agg         = target.health.aggravated  ?? 0;
    const sup         = target.health.superficial ?? 0;
    const totalFilled = agg + sup;
    const isVampire   = target.bloodPotency !== null && target.bloodPotency !== undefined;

    if (agg >= max) {
      // Alle Kästen aggraviiert → Torpor (Vampir) oder Tot (Mensch)
      const status = isVampire ? StatusEffect.TORPOR : StatusEffect.DISABLED;
      this._addStatus(target, status, effects);
    } else if (totalFilled >= max) {
      // Alle Kästen gefüllt (mix aus sup/agg) → Impaired
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
    this.round++;
    this.log.push({ _roundSeparator: true, round: this.round });
    const transient = new Set([StatusEffect.DOMINATED]);
    for (const p of this.participants.values()) {
      p.statusEffects    = p.statusEffects.filter(s => !transient.has(s));
      p.intent           = null;
      p.fleetnessActive       = false;
      p.lightningStrikeActive = false;
      // prowessActive bleibt bestehen (ganzer Kampf)
      p.sparkOfRageActive     = false;
      p.fistOfCaineActive     = false;
    }
    this.setPhase(CombatPhase.INTENT);
  }

  // ─── Narrative builder ────────────────────────────────────────────────────

  _narrative(attacker, target, atkRoll, defRoll, net, damage, dmgType, effects,
             breakdown, weapon, numTargets = 1) {
    let poolLine = '';
    if (breakdown) {
      const parts = [
        `${breakdown.attrName}(${breakdown.attrVal})`,
        `${breakdown.skillName}(${breakdown.skillVal})`,
      ];
      if (breakdown.impaired > 0) parts.push(`Beeinträchtigt(-${breakdown.impaired})`);
      let poolStr = `${breakdown.total} W`;
      if (numTargets > 1) poolStr += ` (÷${numTargets} Ziele)`;
      poolLine = `[Pool: ${parts.join(' + ')} = ${poolStr}, ${breakdown.hungerDice}× Hunger] `;
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
