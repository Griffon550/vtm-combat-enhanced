/**
 * Combat Modal — mit Socket-Sync für GM + Spieler
 *
 * GM-Client:     besitzt die echte CombatSession, sendet State-Updates per Socket
 * Spieler-Client: empfängt State-Updates, kann nur eigene Charaktere bedienen
 */

import { CombatSession, CombatPhase, ActionType } from '../combat-engine.js';
import { createAdapter }  from '../adapters/actor-adapter.js';
import { ActionDialog }   from './action-dialog.js';
import { emitSocket }     from '../module.js';

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
                    state.phase === CombatPhase.INTENT &&
                    !p.intent,
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
      html.find('[data-action="roll-all-initiative"]').on('click', () => this.session.rollAllInitiative());
      html.find('[data-action="roll-initiative"]').on('click', ev => {
        const id = this._actorId(ev);
        if (id) this.session.rollInitiative(id);
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
