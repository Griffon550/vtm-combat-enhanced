/**
 * Combat Modal — mit Socket-Sync für GM + Spieler
 *
 * GM-Client:     besitzt die echte CombatSession, sendet State-Updates per Socket
 * Spieler-Client: empfängt State-Updates, kann nur eigene Charaktere bedienen
 */

import { CombatSession, CombatPhase, ActionType } from '../combat-engine.js';
import { createAdapter }  from '../adapters/actor-adapter.js';
import { ActionDialog }   from './action-dialog.js';
import { DiceRollPopup }  from './dice-popup.js';
import { emitSocket }     from '../module.js';
import { evaluate as diceEvaluate } from '../dice/dice-engine.js';

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/combat-modal.html`;

export class CombatModal extends Application {
  constructor(options = {}) {
    super(options);

    this._isGM     = game.user.isGM;
    this.session   = new CombatSession();
    this._adapters = new Map(); // actorId → ActorAdapter (GM only)

    // GM: nach jedem State-Update → alle Clients benachrichtigen
    if (this._isGM) {
      this.session.onUpdate = (state) => {
        emitSocket('stateUpdate', state);
        // re-render eigenes Fenster
        this.render(false);
      };
    }
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'vtm-combat-modal',
      title:     'VTM Combat Enhanced',
      template:  TEMPLATE,
      width:     960,
      height:    700,
      resizable: true,
      classes:   ['vtm-combat-modal'],
    });
  }

  // ─── Template data ─────────────────────────────────────────────────────────

  getData() {
    const state   = this.session.getState();
    const isGM    = this._isGM;

    // Füge Eigentümer-Flag zu jedem Teilnehmer hinzu
    const enrich = (p) => ({
      ...p,
      isOwned:      isGM || !!(game.actors.get(p.id)?.isOwner),
      canSetIntent: (isGM || !!(game.actors.get(p.id)?.isOwner)) &&
                    state.phase === CombatPhase.INTENT,
      intentSet:    !!p.intent,
    });

    const players = state.participants.filter(p => p.side === 'players').map(enrich);
    const enemies = state.participants.filter(p => p.side === 'enemies').map(enrich);
    const order   = this.session.getInitiativeOrder().map(enrich);

    return {
      isGM,
      phase:           state.phase,
      phaseLabel:      this._phaseLabel(state.phase),
      round:           state.round,
      players,
      enemies,
      initiativeOrder: order,
      log:             state.log.slice(-15).reverse(),

      canStartIntent:  isGM && [CombatPhase.SETUP, CombatPhase.STATE_UPDATE, CombatPhase.DONE].includes(state.phase),
      canSetIntents:   state.phase === CombatPhase.INTENT,
      canResolve:      isGM && state.phase === CombatPhase.INTENT && this.session.allIntentsSet(),
      canEndRound:     isGM && state.phase === CombatPhase.STATE_UPDATE,
      isSetup:         state.phase === CombatPhase.SETUP,
      phases:          CombatPhase,
    };
  }

  _phaseLabel(phase) {
    return {
      [CombatPhase.SETUP]:        'Setup — Actors per Drag & Drop hinzufügen',
      [CombatPhase.INTENT]:       'Intent Phase — Alle wählen ihre Aktion',
      [CombatPhase.RESOLUTION]:   'Auflösung läuft…',
      [CombatPhase.STATE_UPDATE]: 'Ergebnisse — Runde beenden wenn bereit',
      [CombatPhase.DONE]:         'Kampf beendet',
    }[phase] ?? phase;
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  activateListeners(html) {
    super.activateListeners(html);

    // GM-only Phasen-Buttons
    if (this._isGM) {
      html.find('[data-action="start-intent"]').on('click', () => this.session.startIntentPhase());
      html.find('[data-action="resolve-all"]').on('click',  () => this._onResolveAll());
      html.find('[data-action="end-round"]').on('click',    () => this.session.endRound());
      html.find('[data-action="roll-all-initiative"]').on('click', () => this._rollAllInitiativeWithDisplay());
      html.find('[data-action="roll-initiative"]').on('click', ev => {
        const id = this._actorId(ev);
        if (id) this._rollInitiativeWithDisplay(id);
      });
      html.find('[data-action="remove-participant"]').on('click', ev => {
        const id = this._actorId(ev);
        if (id) { this.session.removeParticipant(id); this._adapters.delete(id); }
      });
      html.find('[data-action="move-side"]').on('click', ev => {
        const id = this._actorId(ev);
        if (!id) return;
        const p = this.session.getParticipant(id);
        if (p) { p.side = p.side === 'players' ? 'enemies' : 'players'; this.session._notify(); }
      });

      // Drag & Drop nur für GM
      this._bindDropZone(html.find('.vtm-players-zone')[0], 'players');
      this._bindDropZone(html.find('.vtm-enemies-zone')[0], 'enemies');
    }

    // Aktion wählen — für Eigentümer (GM + Spieler)
    html.find('[data-action="choose-action"]').on('click', ev => {
      const id = this._actorId(ev);
      if (id) this._openActionDialog(id);
    });
  }

  _actorId(ev) {
    return ev.currentTarget.closest('[data-actor-id]')?.dataset?.actorId ?? null;
  }

  // ─── Drag & Drop (nur GM) ─────────────────────────────────────────────────

  _bindDropZone(el, side) {
    if (!el) return;
    el.addEventListener('dragover',  ev => { ev.preventDefault(); el.classList.add('vtm-drop-active'); });
    el.addEventListener('dragenter', ev => { ev.preventDefault(); el.classList.add('vtm-drop-active'); });
    el.addEventListener('dragleave', ev => { if (!el.contains(ev.relatedTarget)) el.classList.remove('vtm-drop-active'); });
    el.addEventListener('drop', ev => { ev.preventDefault(); el.classList.remove('vtm-drop-active'); this._handleDrop(ev, side); });
  }

  async _handleDrop(event, side) {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData('text/plain')); }
    catch { ui.notifications.warn('VTM Combat: Ungültige Drop-Daten.'); return; }

    let actor = null;
    if      (data.type === 'Actor')      actor = data.uuid ? await fromUuid(data.uuid) : game.actors.get(data.id);
    else if (data.type === 'Token')      actor = canvas?.tokens?.get(data.id)?.actor;
    else if (data.type === 'Combatant')  actor = game.combat?.combatants?.get(data.id)?.actor;

    if (!actor) { ui.notifications.warn(`VTM Combat: Actor nicht gefunden (type: ${data.type}).`); return; }
    this._addActor(actor, side);
  }

  _addActor(actor, side) {
    if (this.session.participants.has(actor.id)) {
      ui.notifications.info(`${actor.name} ist bereits im Kampf.`); return;
    }
    const adapter = createAdapter(actor);
    this._adapters.set(actor.id, adapter);
    this.session.addParticipant(adapter.toPlainObject(), side);
    ui.notifications.info(`${actor.name} zu ${side === 'players' ? 'Spielern' : 'Gegnern'} hinzugefügt.`);
  }

  // ─── Aktionsdialog ────────────────────────────────────────────────────────

  _openActionDialog(actorId) {
    const participant = this.session.getParticipant(actorId);
    if (!participant) return;

    if (this.session.phase !== CombatPhase.INTENT) {
      ui.notifications.warn('Aktionen können nur in der Intent-Phase gesetzt werden.'); return;
    }

    // Prüfe Berechtigung
    if (!this._isGM && !game.actors.get(actorId)?.isOwner) {
      ui.notifications.warn('Du kannst nur Aktionen für deine eigenen Charaktere wählen.'); return;
    }

    const targets = Array.from(this.session.participants.values()).filter(p => p.id !== actorId);

    new ActionDialog({
      participant,
      targets,
      existingIntent: participant.intent ?? null,
      onConfirm: (intent) => {
        if (this._isGM) {
          // GM setzt Intent direkt
          try { this.session.setIntent(actorId, intent); }
          catch (e) { ui.notifications.error(e.message); }
        } else {
          // Spieler schickt Intent per Socket an GM
          emitSocket('setIntent', { participantId: actorId, intent });
        }
      },
    }).render(true);
  }

  // ─── Initiative mit Foundry Roll API (Dice So Nice) ──────────────────────

  async _rollInitiativeWithDisplay(id) {
    if (!this._isGM) return;
    const p = this.session.getParticipant(id);
    if (!p) return;

    const dex  = p.attributes.dexterity ?? 2;
    const wits = p.attributes.wits      ?? 2;

    // Pool berechnen (identisch zur Logik in rollInitiative — pure/side-effect-free)
    const initCtx = this.session.disciplineEngine.applyBeforeInitiative(
      p,
      { pool: dex + wits, hungerDice: 0 },
      p.intent?.activePowers ?? [],
    );

    const normalCount = initCtx.pool - initCtx.hungerDice;
    const hungerCount = initCtx.hungerDice;

    // Via Foundry Roll würfeln → triggert Dice So Nice automatisch
    const parts   = [
      normalCount > 0 && `${normalCount}d10`,
      hungerCount > 0 && `${hungerCount}d10`,
    ].filter(Boolean);
    const formula = parts.join('+') || '1d10';

    const foundryRoll = new Roll(formula);
    await foundryRoll.evaluate({ async: true });

    // Einzelne Würfelwerte aus Foundry-Roll extrahieren
    const allValues = foundryRoll.terms
      .filter(t => Array.isArray(t.results))
      .flatMap(t => t.results.map(r => r.result));
    const normalRolls = allValues.slice(0, normalCount);
    const hungerRolls = allValues.slice(normalCount);

    // Engine mit vorgewürfelten Werten aufrufen (kein zweites Würfeln)
    const initResult = this.session.rollInitiative(id, {
      roll: () => diceEvaluate(normalRolls, hungerRolls),
    });

    // Chat-Nachricht mit Aufschlüsselung — Roll ist eingebettet für Dice So Nice
    await ChatMessage.create({
      rolls:   [foundryRoll],
      flavor:  this._initiativeFlavor(initResult, dex, wits, initCtx),
      speaker: ChatMessage.getSpeaker({ actor: game.actors.get(id) ?? null }),
    });
  }

  async _rollAllInitiativeWithDisplay() {
    for (const id of this.session.participants.keys()) {
      await this._rollInitiativeWithDisplay(id);
    }
  }

  /**
   * Baut das Flavor-HTML für eine Initiative-Nachricht.
   * Zeigt Attribut + Attribut + aktivierte Disziplinkräfte + Ergebnis.
   */
  _initiativeFlavor(initResult, dex, wits, initCtx) {
    const parts = [
      `<strong>Geschicklichkeit</strong>&nbsp;${dex}`,
      `<strong>Geistesgegenwart</strong>&nbsp;${wits}`,
    ];
    for (const pw of (initCtx.appliedPowers ?? [])) {
      parts.push(`<em class="vtm-power-bonus">${pw}</em>`);
    }
    const poolLine = parts.join(' + ') + ` = ${initResult.pool}&nbsp;Würfel`;
    const hungerNote = initCtx.hungerDice > 0
      ? ` <span class="vtm-hunger-note">(${initCtx.hungerDice}× Hunger)</span>`
      : '';

    let resultLine = `${initResult.successes}&nbsp;Erfolge`;
    if ((initResult.initiativeBonus ?? 0) > 0) {
      resultLine += ` +${initResult.initiativeBonus}&nbsp;Bonus`;
    }
    resultLine += ` → Initiative: <strong>${initResult.total}</strong>`;

    if (initResult.roll?.messyCritical)  resultLine += ' <span class="vtm-messy-label">💀 Messy Critical</span>';
    if (initResult.roll?.bestialFailure) resultLine += ' <span class="vtm-bestial-label">⚠ Bestial Failure</span>';

    return `
      <div class="vtm-initiative-flavor">
        <div class="vtm-initiative-header">
          <i class="fas fa-dice-d10"></i> Initiative — ${initResult.name}
        </div>
        <div class="vtm-pool-line">${poolLine}${hungerNote}</div>
        <div class="vtm-result-line">${resultLine}</div>
      </div>`;
  }

  // ─── Resolution (nur GM) ──────────────────────────────────────────────────

  async _onResolveAll() {
    if (!this._isGM) return;
    if (!this.session.allIntentsSet()) {
      ui.notifications.warn('Noch nicht alle Teilnehmer haben ihre Aktion gewählt.'); return;
    }

    this.session.startResolutionPhase();
    const results = this.session.resolveAll();

    for (const r of results) {
      if (r.defenderId && r.damage > 0) {
        const adapter = this._adapters.get(r.defenderId);
        if (adapter) {
          await adapter.applyDamage(r.damage, r.damageType);
          this._syncParticipantFromActor(r.defenderId);
        }
      }
    }

    await this._postChat(results);

    // Würfel-Popup im Vordergrund anzeigen
    const popup = new DiceRollPopup(results, this.session.participants);
    popup.render(true);

    this.render(false);
  }

  // ─── Socket-Sync (Spieler-Seite) ──────────────────────────────────────────

  /**
   * Empfängt einen State-Snapshot vom GM und aktualisiert das Modal.
   * Wird von module.js aufgerufen wenn eine 'stateUpdate'-Nachricht ankommt.
   * @param {SessionState} state
   */
  _syncFromState(state) {
    this.session.loadState(state);
    this.render(false);
  }

  // ─── Hilfsmethoden ───────────────────────────────────────────────────────

  _syncParticipantFromActor(actorId) {
    const adapter = this._adapters.get(actorId);
    const p = this.session.getParticipant(actorId);
    if (!adapter || !p) return;
    const fresh = adapter.toPlainObject();
    Object.assign(p, { health: fresh.health, willpower: fresh.willpower, hunger: fresh.hunger, statusEffects: fresh.statusEffects });
  }

  async _postChat(results) {
    if (!results?.length) return;
    const rows = results.map(r => `<li>${r.narrative}</li>`).join('');
    await ChatMessage.create({
      content: `<div class="vtm-chat-results"><h3>Runde ${this.session.round}</h3><ul>${rows}</ul></div>`,
      speaker: { alias: 'VTM Combat Engine' },
    });
  }

  onActorUpdate(actor, _changes) {
    if (!this.session.participants.has(actor.id)) return;
    this._syncParticipantFromActor(actor.id);
    this.render(false);
  }
}
