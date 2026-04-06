/**
 * VTM V5 Discipline Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Liest DISCIPLINE_POWERS und wendet Effekte an definierten Timing-Hooks an.
 * Keine hart verdrahteten Sonderfälle — alle Logik ist datengetrieben.
 *
 * Effektklassen (effect.*):
 *   diceBonus              Würfel auf Pool addieren
 *   autoSuccessBonus       Automatische Erfolge (post-Roll)
 *   initiativeBonus        Flat-Bonus auf Initiative-Erfolge
 *   damageBonus            Schaden auf Treffer addieren
 *   damageTypeOverride     Schadenstyp überschreiben ('aggravated'|'superficial')
 *   damageReduction        Schaden reduzieren (vor vampirischer Halbierung)
 *   downgradeDamageType    Aggravated → Superficial für einen Treffer
 *   statusApply            Zustände auf Ziel anwenden
 *   statusResistBonus      Zustände widerstehen (Auflistung)
 *   healthBonus            Effektiver HP-Puffer erhöhen
 *   rangeControl           Distanzwechsel erlauben
 *   targetLoss             Zielanvisierung des Angreifers aufheben
 *   cannotBeTargeted       Charakter ist nicht normal angreifbar
 *
 * Alle Methoden geben einen neuen, gemuteten Context zurück.
 * Der original-context wird nie modifiziert.
 */

import { DISCIPLINE_POWERS } from './discipline-powers.js';

export class DisciplineEngine {
  /**
   * @param {Record<string, PowerDefinition>} powerCatalog
   */
  constructor(powerCatalog = DISCIPLINE_POWERS) {
    this.catalog = powerCatalog;
  }

  // ─── Timing Hook: beforeInitiative ────────────────────────────────────────
  //
  // Input context:  { pool: number, hungerDice: number }
  // Output context: { pool, hungerDice, initiativeBonus, surpriseResistance }

  applyBeforeInitiative(participant, context, activePowers = []) {
    const ctx = { ...context, initiativeBonus: 0, surpriseResistance: false };

    for (const { power } of this._powers(participant, 'beforeInitiative', activePowers)) {
      const e = power.effect;
      if (e.diceBonus)          ctx.pool += e.diceBonus;
      if (e.initiativeBonus)    ctx.initiativeBonus += Number(e.initiativeBonus);
      if (e.surpriseResistance) ctx.surpriseResistance = true;
    }

    ctx.pool      = Math.max(1, ctx.pool);
    ctx.hungerDice = Math.min(participant.hunger ?? 0, ctx.pool);
    return ctx;
  }

  // ─── Timing Hook: beforeRoll ──────────────────────────────────────────────
  //
  // Modifiziert den Angriffs- oder Verteidigungspool vor dem Würfeln.
  //
  // Input context:  { total: number, hungerDice: number }
  // Output context: { total, hungerDice, autoSuccesses, appliedPowers[] }

  applyBeforeRoll(participant, actionType, context, activePowers = []) {
    const ctx = { ...context, autoSuccesses: 0, appliedPowers: [] };

    for (const { power } of this._powers(participant, 'beforeRoll', activePowers)) {
      if (!this._matchesAction(power, actionType)) continue;
      const e = power.effect;
      if (e.diceBonus)         ctx.total += e.diceBonus;
      if (e.autoSuccessBonus)  ctx.autoSuccesses += e.autoSuccessBonus;
      ctx.appliedPowers.push(power.power);
    }

    ctx.total      = Math.max(1, ctx.total);
    ctx.hungerDice = Math.min(participant.hunger ?? 0, ctx.total);
    return ctx;
  }

  // ─── Timing Hook: onHit ───────────────────────────────────────────────────
  //
  // Wird nach Trefferermittlung (netSuccesses > 0) für den Angreifer aufgerufen.
  // Kann Schaden, Schadenstyp und Zustände auf das Ziel verändern.
  //
  // Input context:  { damage, damageType, statusesToApply: [] }
  // Output context: { damage, damageType, statusesToApply, appliedPowers[], requiresContest }

  applyOnHit(attacker, actionType, context, activePowers = []) {
    const ctx = {
      ...context,
      statusesToApply: [...(context.statusesToApply ?? [])],
      appliedPowers:   [],
      requiresContest: false,
    };

    for (const { power, rating } of this._powers(attacker, 'onHit', activePowers)) {
      if (!this._matchesAction(power, actionType)) continue;
      const e = power.effect;

      if (e.damageBonus) {
        ctx.damage += this._resolve(e.damageBonus, power.discipline, attacker);
      }
      if (e.damageTypeOverride) {
        ctx.damageType = e.damageTypeOverride;
      }
      if (e.statusApply) {
        for (const s of e.statusApply) {
          if (!ctx.statusesToApply.includes(s)) ctx.statusesToApply.push(s);
        }
      }
      if (e.requiresContest) ctx.requiresContest = true;
      ctx.appliedPowers.push(power.power);
    }

    return ctx;
  }

  // ─── Timing Hook: beforeDamageApply ──────────────────────────────────────
  //
  // Wird für den VERTEIDIGER aufgerufen, nachdem der Rohschaden feststeht.
  // Fortitude-Reduktionen, Defy Bane etc. greifen hier.
  //
  // Input context:  { damage, damageType }
  // Output context: { damage, damageType, appliedPowers[] }

  applyBeforeDamageApply(defender, context, activePowers = []) {
    const ctx = { ...context, appliedPowers: [] };

    for (const { power } of this._powers(defender, 'beforeDamageApply', activePowers)) {
      const e = power.effect;

      // Schadensreduktion — appliesTo begrenzt auf bestimmten Schadenstyp
      if (e.damageReduction) {
        const typeMatch = !e.appliesTo || e.appliesTo.includes(ctx.damageType);
        if (typeMatch) {
          const reduction = this._resolve(e.damageReduction, power.discipline, defender);
          ctx.damage = Math.max(0, ctx.damage - reduction);
          ctx.appliedPowers.push(power.power);
        }
      }

      // Aggravated → Superficial downgrade
      if (e.downgradeDamageType && ctx.damageType === 'aggravated') {
        ctx.damageType = 'superficial';
        ctx.appliedPowers.push(power.power);
      }
    }

    return ctx;
  }

  // ─── Status-Poolmalus aus aktiven Zuständen ───────────────────────────────
  //
  // Gibt die Anzahl Würfel zurück, die wegen negativer Statuszustände
  // vom Pool abgezogen werden müssen.

  getStatusPoolPenalty(participant) {
    const s = participant.statusEffects ?? [];
    let penalty = 0;
    if (s.includes('intimidated'))  penalty += 2;
    if (s.includes('frightened'))   penalty += 2;
    if (s.includes('hesitating'))   penalty += 1;
    if (s.includes('destabilized')) penalty += 1;
    if (s.includes('enraged'))      penalty += 1;   // Verlust feinmotorischer Kontrolle
    return penalty;
  }

  // ─── Passiver Gesundheitsbonus (Resilience) ───────────────────────────────

  getPassiveHealthBonus(participant) {
    let bonus = 0;
    for (const { power } of this._powers(participant, 'passive', [])) {
      if (power.effect.healthBonus) {
        bonus += this._resolve(power.effect.healthBonus, power.discipline, participant);
      }
    }
    return bonus;
  }

  // ─── Statusresistenz-Prüfung ──────────────────────────────────────────────
  //
  // true wenn ein passiver Effekt diesen Zustand blockiert.

  resistsStatus(participant, statusName) {
    for (const { power } of this._powers(participant, 'passive', [])) {
      if (power.effect.statusResistBonus?.includes(statusName)) return true;
    }
    return false;
  }

  // ─── Distanzkontrolle ─────────────────────────────────────────────────────
  //
  // true wenn der Charakter diesen Zug die Distanz wechseln darf.

  canControlRange(participant, activePowers = []) {
    for (const { power } of this._powers(participant, 'onTurnStart', activePowers)) {
      if (power.effect.rangeControl) return true;
    }
    return false;
  }

  // ─── Zielbarkeits-Prüfung ─────────────────────────────────────────────────
  //
  // true wenn der Charakter gerade nicht normal angreifbar ist (Nebelform etc.)

  cannotBeTargeted(participant, activePowers = []) {
    // Status-Check
    if (participant.statusEffects?.includes('mist_form')) return true;
    // Power-Check
    for (const { power } of this._powers(participant, 'onTurnStart', activePowers)) {
      if (power.effect.cannotBeTargeted) return true;
    }
    return false;
  }

  // ─── Interne Hilfsmethoden ────────────────────────────────────────────────

  /**
   * Gibt alle passenden Kräfte eines Teilnehmers für einen bestimmten Hook zurück.
   * Berücksichtigt:
   *   - knownPowers des Teilnehmers
   *   - timing muss mit hookName übereinstimmen
   *   - activation = 'passive' → immer aktiv
   *   - activation ≠ 'passive' → muss in activePowers stehen
   *
   * @param {Participant} participant
   * @param {string}      hookName
   * @param {string[]}    activePowers
   * @returns {{ power: PowerDefinition, rating: number }[]}
   */
  _powers(participant, hookName, activePowers) {
    const results = [];
    for (const [discName, discData] of Object.entries(participant.disciplines ?? {})) {
      const rating      = typeof discData === 'object' ? (discData.rating      ?? 0) : (discData ?? 0);
      const knownPowers = typeof discData === 'object' ? (discData.knownPowers ?? []) : [];
      if (!rating) continue;

      for (const powerName of knownPowers) {
        const power = this.catalog[powerName];
        if (!power)                        continue;
        if (power.timing !== hookName)      continue;

        const passive    = power.activation === 'passive';
        const activated  = activePowers.includes(powerName);
        if (!passive && !activated)        continue;

        results.push({ power, rating });
      }
    }
    return results;
  }

  /**
   * true wenn power.effect.appliesTo nicht gesetzt ist ODER den actionType enthält.
   */
  _matchesAction(power, actionType) {
    if (!power.effect.appliesTo) return true;
    return power.effect.appliesTo.includes(actionType);
  }

  /**
   * Löst skalierbare Effektwerte auf.
   *   'scale_with_rating'         → Disziplinrating des Charakters
   *   'scale_with_rating_doubled' → Rating × 2
   *   'moderate'                  → 2
   *   'high'                      → 3
   *   number                      → direkt
   */
  _resolve(value, disciplineName, participant) {
    const disc   = participant.disciplines?.[disciplineName?.toLowerCase()];
    const rating = typeof disc === 'object' ? (disc.rating ?? 0) : (Number(disc) || 0);

    if (value === 'scale_with_rating')         return rating;
    if (value === 'scale_with_rating_doubled') return rating * 2;
    if (value === 'moderate')                  return 2;
    if (value === 'high')                      return 3;
    return typeof value === 'number' ? value : 0;
  }
}

/** Modul-Singleton — wird von CombatSession im Konstruktor genutzt. */
export const disciplineEngine = new DisciplineEngine(DISCIPLINE_POWERS);
