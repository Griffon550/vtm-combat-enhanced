/**
 * Actor Adapter — wod5e 5.x aware
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges Foundry Actor documents to the plain data objects the combat engine
 * expects. Isolated here so the engine itself never touches Foundry APIs.
 *
 * ── HOW TO INSPECT YOUR ACTUAL ACTOR SCHEMA IN FOUNDRY ──────────────────────
 *
 * Open the browser console (F12) on your Foundry world and run:
 *
 *   // List all actor names so you know the exact spelling:
 *   game.actors.contents.map(a => `${a.name} [${a.type}]`)
 *
 *   // Inspect a vampire's full system object:
 *   const a = game.actors.contents.find(a => a.type === 'vampire');
 *   console.log(JSON.stringify(a.system, null, 2));
 *
 *   // Inspect all items on that actor (attributes, skills, disciplines):
 *   a.items.contents.map(i => ({ name: i.name, type: i.type, system: i.system }))
 *
 * ── wod5e 5.x SCHEMA NOTES ──────────────────────────────────────────────────
 *
 * wod5e (SchreckNet, v5.3+) stores data as follows:
 *
 *   Health / Willpower:
 *     actor.system.health   = { max, aggravated, superficial }
 *     actor.system.willpower = { max, aggravated, superficial }
 *     → "remaining" = max - aggravated - superficial  (NOT a .value field)
 *
 *   Hunger:
 *     actor.system.hunger.value  (0–5)
 *
 *   Attributes + Skills:
 *     Stored as ITEMS on the actor (type: "skill").
 *     item.system.skill   = "strength" | "dexterity" | "brawl" | …
 *     item.system.value   = dot rating (1–5)
 *
 *   Disciplines:
 *     Stored as ITEMS on the actor (type: "power") grouped by discipline.
 *     The discipline level = number of powers of that discipline type.
 *     OR: item.type === "discipline" with item.system.value.
 *     Both patterns are handled below.
 *
 * ── ADAPTING FOR OTHER SYSTEMS ───────────────────────────────────────────────
 * Edit FIELD_MAP. Each entry is (actor) => value with a safe fallback.
 */

import { KNOWN_POWER_NAMES } from '../disciplines/discipline-powers.js';

// ─── wod5e trait lookup ───────────────────────────────────────────────────────

/**
 * Look up a skill or attribute value from a wod5e actor.
 *
 * wod5e 5.x (SchreckNet) stores all traits DIRECTLY on actor.system:
 *   Skills:     actor.system.skills.{id}.value     e.g. system.skills.brawl.value
 *   Attributes: actor.system.attributes.{id}.value e.g. system.attributes.dexterity.value
 *
 * Fallback: sortedSkills / sortedAttributes arrays ({id, value} entries).
 *
 * @param {Actor}  actor
 * @param {string} traitName  canonical English id e.g. 'strength', 'brawl'
 * @param {number} fallback
 */
function wod5eSkill(actor, traitName, fallback = 0) {
  const s = actor.system;
  if (!s) return fallback;

  // 1. system.skills.{id}.value  (Fähigkeiten)
  const fromSkills = s.skills?.[traitName]?.value;
  if (fromSkills != null) return Number(fromSkills);

  // 2. system.attributes.{id}.value  (Attribute)
  const fromAttribs = s.attributes?.[traitName]?.value;
  if (fromAttribs != null) return Number(fromAttribs);

  // 3. sortedSkills — array of {id, value, …}
  for (const cat of ['physical', 'social', 'mental']) {
    const e = s.sortedSkills?.[cat]?.find(x => x.id === traitName);
    if (e?.value != null) return Number(e.value);
  }

  // 4. sortedAttributes — array of {id, value, …}
  for (const cat of ['physical', 'social', 'mental']) {
    const e = s.sortedAttributes?.[cat]?.find(x => x.id === traitName);
    if (e?.value != null) return Number(e.value);
  }

  return fallback;
}

/**
 * Discipline level in wod5e 5.x.
 *
 * wod5e 5.x uses one of two patterns (changed between minor versions):
 *   A) items of type "discipline" with system.value = dot rating
 *   B) items of type "power" where system.discipline = "celerity" etc.
 *      → level = count of owned powers of that discipline
 *
 * We try pattern A first, then B, then fall back to flat system fields.
 *
 * @param {Actor} actor
 * @param {string} discName  lowercase, e.g. 'celerity'
 */
function wod5eDiscipline(actor, discName) {
  // 1. system.disciplines.{id}.value  — primärer Pfad in wod5e 5.x
  const direct = actor.system?.disciplines?.[discName]?.value;
  if (direct != null) return Number(direct);

  // 2. Flat system field (ältere Forks)
  const flat = _get(actor, `system.disciplines.${discName}`);
  if (typeof flat === 'number') return flat;

  // 3. Dedicated discipline item (andere Systeme)
  if (actor.items) {
    const discItem = actor.items.find(
      i => i.type === 'discipline' &&
           (i.system?.discipline?.toLowerCase() === discName ||
            i.name?.toLowerCase()               === discName)
    );
    if (discItem) return Number(discItem.system?.value ?? discItem.system?.level ?? 0);
  }

  return 0;
}

/**
 * Liest die knownPowers (bekannte Kräfte) einer Disziplin aus wod5e-Items.
 * Mappt wod5e-Itemnamen auf kanonische DISCIPLINE_POWERS-Schlüssel.
 * Unbekannte Namen werden ignoriert.
 *
 * @param {Actor}  actor
 * @param {string} discName  lowercase Disziplinname
 * @param {Set<string>} knownPowerNames  aus discipline-powers.js
 * @returns {string[]}
 */
function wod5eKnownPowers(actor, discName, knownPowerNames) {
  if (!actor.items || !knownPowerNames) return [];

  return actor.items
    .filter(i =>
      i.type === 'power' &&
      i.system?.discipline?.toLowerCase() === discName
    )
    .map(i => i.name?.trim())
    .filter(name => name && knownPowerNames.has(name));
}

/**
 * wod5e remaining track value: max − aggravated − superficial
 */
function wod5eRemaining(trackObj, fallbackMax = 5) {
  if (!trackObj) return fallbackMax;
  const max  = Number(trackObj.max          ?? fallbackMax);
  const agg  = Number(trackObj.aggravated   ?? 0);
  const sup  = Number(trackObj.superficial  ?? 0);
  return Math.max(0, max - agg - sup);
}

// ─── Field map ────────────────────────────────────────────────────────────────
// Modify entries here to match your system's actual schema.

const FIELD_MAP = {

  // ── Health ─────────────────────────────────────────────────────────────────
  // wod5e: max - aggravated - superficial
  healthMax:   a => a.system?.health?.max ?? 4,
  healthValue: a => wod5eRemaining(a.system?.health, 4),

  // Expose raw damage counts so applyDamage() can write the right fields
  healthAggravated:  a => a.system?.health?.aggravated  ?? 0,
  healthSuperficial: a => a.system?.health?.superficial ?? 0,

  // ── Willpower ──────────────────────────────────────────────────────────────
  willpowerMax:   a => a.system?.willpower?.max ?? 6,
  willpowerValue: a => wod5eRemaining(a.system?.willpower, 6),

  // ── Hunger (VTM only) ──────────────────────────────────────────────────────
  hunger: a => Number(a.system?.hunger?.value ?? 0),

  // ── Attributes — system.attributes.{id}.value ──────────────────────────────
  strength:     a => wod5eSkill(a, 'strength',     1),
  dexterity:    a => wod5eSkill(a, 'dexterity',    1),
  wits:         a => wod5eSkill(a, 'wits',         1),
  stamina:      a => wod5eSkill(a, 'stamina',      1),
  charisma:     a => wod5eSkill(a, 'charisma',     1),
  manipulation: a => wod5eSkill(a, 'manipulation', 1),
  resolve:      a => wod5eSkill(a, 'resolve',      1),
  composure:    a => wod5eSkill(a, 'composure',    1),

  // ── Skills — system.skills.{id}.value ──────────────────────────────────────
  brawl:     a => wod5eSkill(a, 'brawl',     0),
  melee:     a => wod5eSkill(a, 'melee',     0),
  firearms:  a => wod5eSkill(a, 'firearms',  0),
  athletics: a => wod5eSkill(a, 'athletics', 0),
  stealth:   a => wod5eSkill(a, 'stealth',   0),

  // ── Disciplines (gibt { rating, knownPowers } zurück) ──────────────────────
  celerity:  a => ({ rating: wod5eDiscipline(a, 'celerity'),  knownPowers: wod5eKnownPowers(a, 'celerity',  KNOWN_POWER_NAMES) }),
  potence:   a => ({ rating: wod5eDiscipline(a, 'potence'),   knownPowers: wod5eKnownPowers(a, 'potence',   KNOWN_POWER_NAMES) }),
  fortitude: a => ({ rating: wod5eDiscipline(a, 'fortitude'), knownPowers: wod5eKnownPowers(a, 'fortitude', KNOWN_POWER_NAMES) }),
  dominate:  a => ({ rating: wod5eDiscipline(a, 'dominate'),  knownPowers: wod5eKnownPowers(a, 'dominate',  KNOWN_POWER_NAMES) }),
  presence:  a => ({ rating: wod5eDiscipline(a, 'presence'),  knownPowers: wod5eKnownPowers(a, 'presence',  KNOWN_POWER_NAMES) }),
  protean:   a => ({ rating: wod5eDiscipline(a, 'protean'),   knownPowers: wod5eKnownPowers(a, 'protean',   KNOWN_POWER_NAMES) }),
  auspex:    a => ({ rating: wod5eDiscipline(a, 'auspex'),    knownPowers: wod5eKnownPowers(a, 'auspex',    KNOWN_POWER_NAMES) }),
  obfuscate: a => ({ rating: wod5eDiscipline(a, 'obfuscate'), knownPowers: wod5eKnownPowers(a, 'obfuscate', KNOWN_POWER_NAMES) }),
};

// ─── Path helpers ─────────────────────────────────────────────────────────────

function _get(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

// ─── ActorAdapter ─────────────────────────────────────────────────────────────

export class ActorAdapter {
  /** @param {Actor} foundryActor  A live Foundry Actor document */
  constructor(foundryActor) {
    this._actor = foundryActor;
  }

  // Identity
  get id()   { return this._actor.id; }
  get name() { return this._actor.name; }
  get img()  { return this._actor.img ?? 'icons/svg/mystery-man.svg'; }

  _safe(key, fallback = 0) {
    try {
      const fn = FIELD_MAP[key];
      if (!fn) return fallback;
      return fn(this._actor) ?? fallback;
    } catch (e) {
      console.warn(`vtm-combat-enhanced | ActorAdapter._safe("${key}") failed:`, e);
      return fallback;
    }
  }

  // ── Resource getters ───────────────────────────────────────────────────────

  getHealth() {
    return {
      value: this._safe('healthValue', 4),
      max:   this._safe('healthMax',   4),
    };
  }

  getWillpower() {
    return {
      value: this._safe('willpowerValue', 3),
      max:   this._safe('willpowerMax',   6),
    };
  }

  getHunger()              { return this._safe('hunger', 0); }
  getAttribute(name)       { return this._safe(name, 2); }
  getSkill(name)           { return this._safe(name, 0); }
  getDiscipline(name)      { return this._safe(name, 0); }

  getPool(attribute, skill, bonus = 0) {
    return Math.max(1, this.getAttribute(attribute) + this.getSkill(skill) + bonus);
  }

  // ── Status effects ─────────────────────────────────────────────────────────

  _getStatusEffects() {
    // Foundry v11: actor.statuses is a Set<string>
    if (this._actor.statuses instanceof Set) {
      return Array.from(this._actor.statuses);
    }
    // Fallback: ActiveEffect labels
    return Array.from(this._actor.effects ?? [])
      .map(e => e.label ?? e.name ?? '')
      .filter(Boolean);
  }

  // ── Plain object snapshot ──────────────────────────────────────────────────

  toPlainObject() {
    return {
      id:            this.id,
      name:          this.name,
      img:           this.img,
      health:        this.getHealth(),
      willpower:     this.getWillpower(),
      hunger:        this.getHunger(),
      statusEffects: this._getStatusEffects(),
      attributes: {
        strength:     this.getAttribute('strength'),
        dexterity:    this.getAttribute('dexterity'),
        wits:         this.getAttribute('wits'),
        stamina:      this.getAttribute('stamina'),
        charisma:     this.getAttribute('charisma'),
        manipulation: this.getAttribute('manipulation'),
        resolve:      this.getAttribute('resolve'),
        composure:    this.getAttribute('composure'),
      },
      skills: {
        brawl:     this.getSkill('brawl'),
        melee:     this.getSkill('melee'),
        firearms:  this.getSkill('firearms'),
        athletics: this.getSkill('athletics'),
      },
      // Disziplinen als { rating, knownPowers[] } — für DisciplineEngine
      disciplines: {
        celerity:  this.getDiscipline('celerity'),
        potence:   this.getDiscipline('potence'),
        fortitude: this.getDiscipline('fortitude'),
        dominate:  this.getDiscipline('dominate'),
        presence:  this.getDiscipline('presence'),
        protean:   this.getDiscipline('protean'),
        auspex:    this.getDiscipline('auspex'),
        obfuscate: this.getDiscipline('obfuscate'),
      },
    };
  }

  // ── Damage application (wod5e aware) ──────────────────────────────────────

  /**
   * Write damage back to the Foundry Actor document using wod5e's schema.
   *
   * wod5e tracks damage as separate aggravated/superficial fields.
   * The update increments the correct field without exceeding max.
   *
   * @param {number} amount              already halved for superficial
   * @param {'superficial'|'aggravated'} type
   */
  async applyDamage(amount, type) {
    if (amount <= 0) return;

    const h   = this._actor.system?.health;
    const max = this._safe('healthMax', 4);

    if (h && ('aggravated' in h || 'superficial' in h)) {
      // ── wod5e schema ──────────────────────────────────────────────────────
      const field    = type === 'aggravated' ? 'aggravated' : 'superficial';
      const current  = Number(h[field] ?? 0);
      const otherDmg = type === 'aggravated'
        ? Number(h.superficial ?? 0)
        : Number(h.aggravated  ?? 0);
      // Cap: can't exceed remaining uninjured boxes
      const headroom = Math.max(0, max - otherDmg - current);
      const apply    = Math.min(amount, headroom);

      if (apply > 0) {
        await this._actor.update({
          [`system.health.${field}`]: current + apply,
        });
      }
    } else {
      // ── Generic fallback ──────────────────────────────────────────────────
      const path = this._healthWritePath();
      if (path) {
        const current = this._safe('healthValue', max);
        await this._actor.update({ [path]: Math.max(0, current - amount) });
      }
    }
  }

  _healthWritePath() {
    if (_get(this._actor, 'system.health.value') !== undefined) return 'system.health.value';
    if (_get(this._actor, 'system.health')        !== undefined) return 'system.health';
    return null;
  }

  // ── Module flags ───────────────────────────────────────────────────────────

  getFlag(key)        { return this._actor.getFlag('vtm-combat-enhanced', key); }
  async setFlag(k, v) { return this._actor.setFlag('vtm-combat-enhanced', k, v); }
  async unsetFlag(k)  { return this._actor.unsetFlag('vtm-combat-enhanced', k); }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an ActorAdapter from a Foundry Actor document.
 * @param {Actor} actor
 * @returns {ActorAdapter}
 */
export function createAdapter(actor) {
  return new ActorAdapter(actor);
}

// ─── Debug helper (available in browser console) ──────────────────────────────

/**
 * Run this in the Foundry console to diagnose what the adapter reads
 * from a specific actor:
 *
 *   vtmDebugActor("Name of your character")
 */
if (typeof window !== 'undefined') {
  window.vtmDebugActor = function (nameOrId) {
    const actor = game?.actors?.getName(nameOrId) ?? game?.actors?.get(nameOrId);
    if (!actor) {
      console.error(`vtmDebugActor: Actor "${nameOrId}" not found.`);
      console.log('Available actors:', game.actors.contents.map(a => `${a.name} [${a.type}]`));
      return;
    }
    const adapter = new ActorAdapter(actor);
    const data    = adapter.toPlainObject();
    console.group(`vtmDebugActor: ${actor.name}`);
    console.log('Adapter output:', data);
    console.log('Raw system:', actor.system);
    console.log('Items (attributes/skills/disciplines):',
      actor.items.contents.map(i => ({
        name: i.name, type: i.type,
        skill:      i.system?.skill,
        attribute:  i.system?.attribute,
        value:      i.system?.value,
        discipline: i.system?.discipline,
      }))
    );
    // Zeige direkte System-Felder für Attribute-Fallback-Diagnose
    const attrKeys = ['strength','dexterity','wits','stamina'];
    const directCheck = {};
    for (const k of attrKeys) {
      directCheck[k] = {
        'system[k].value':            actor.system?.[k]?.value,
        'system.abilities[k].value':  actor.system?.abilities?.[k]?.value,
        'system.attributes[k].value': actor.system?.attributes?.[k]?.value,
      };
    }
    console.log('Direkte System-Felder (Attribut-Fallbacks):', directCheck);
    console.groupEnd();
    return data;
  };
}
