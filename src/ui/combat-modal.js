/**
 * Combat Modal
 * ─────────────────────────────────────────────────────────────────────────────
 * Main UI window. Extends Foundry's Application.
 *
 * Layout:
 *   [Players | Action area | Enemies]
 *   [Initiative order strip]
 *   [Combat log]
 *
 * Drag & Drop:
 *   Actors from the Actor Directory, Tokens on canvas, or Combatants from the
 *   Foundry combat tracker can be dropped onto either side.
 */

import { CombatSession, CombatPhase, ActionType } from '../combat-engine.js';
import { createAdapter } from '../adapters/actor-adapter.js';
import { ActionDialog }  from './action-dialog.js';

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/combat-modal.html`;

export class CombatModal extends Application {
  constructor(options = {}) {
    super(options);

    /** @type {CombatSession} */
    this.session = new CombatSession();

    // Re-render on every engine state change
    this.session.onUpdate = () => this.render(false);

    /**
     * Live map of actorId → ActorAdapter so we can write damage back.
     * @type {Map<string, import('../adapters/actor-adapter.js').ActorAdapter>}
     */
    this._adapters = new Map();
  }

  // ─── Foundry Application overrides ────────────────────────────────────────

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
    const state    = this.session.getState();
    const players  = state.participants.filter(p => p.side === 'players');
    const enemies  = state.participants.filter(p => p.side === 'enemies');
    const order    = this.session.getInitiativeOrder();

    return {
      phase:          state.phase,
      phaseLabel:     this._phaseLabel(state.phase),
      round:          state.round,
      players,
      enemies,
      initiativeOrder: order,
      log:            state.log.slice(-15).reverse(), // newest first

      // Button visibility
      canStartIntent: [CombatPhase.SETUP, CombatPhase.STATE_UPDATE, CombatPhase.DONE].includes(state.phase),
      canSetIntents:  state.phase === CombatPhase.INTENT,
      canResolve:     state.phase === CombatPhase.INTENT && this.session.allIntentsSet(),
      canEndRound:    state.phase === CombatPhase.STATE_UPDATE,
      isSetup:        state.phase === CombatPhase.SETUP,

      // Phases enum for template
      phases: CombatPhase,
    };
  }

  _phaseLabel(phase) {
    const map = {
      [CombatPhase.SETUP]:        'Setup — Drop actors onto each side',
      [CombatPhase.INTENT]:       'Intent Phase — All participants choose actions',
      [CombatPhase.RESOLUTION]:   'Resolving…',
      [CombatPhase.STATE_UPDATE]: 'State Update — Review results',
      [CombatPhase.DONE]:         'Combat ended',
    };
    return map[phase] ?? phase;
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  activateListeners(html) {
    super.activateListeners(html);

    // ── Phase controls ──────────────────────────────────────────────────────
    html.find('[data-action="start-intent"]').on('click', () => {
      this.session.startIntentPhase();
    });

    html.find('[data-action="resolve-all"]').on('click', () => {
      this._onResolveAll();
    });

    html.find('[data-action="end-round"]').on('click', () => {
      this.session.endRound();
    });

    html.find('[data-action="roll-all-initiative"]').on('click', () => {
      this.session.rollAllInitiative();
    });

    // ── Per-character controls ──────────────────────────────────────────────
    html.find('[data-action="roll-initiative"]').on('click', ev => {
      const id = this._actorIdFromEvent(ev);
      if (id) this.session.rollInitiative(id);
    });

    html.find('[data-action="choose-action"]').on('click', ev => {
      const id = this._actorIdFromEvent(ev);
      if (id) this._openActionDialog(id);
    });

    html.find('[data-action="remove-participant"]').on('click', ev => {
      const id = this._actorIdFromEvent(ev);
      if (id) {
        this.session.removeParticipant(id);
        this._adapters.delete(id);
      }
    });

    html.find('[data-action="move-side"]').on('click', ev => {
      const id = this._actorIdFromEvent(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (p) {
        p.side = p.side === 'players' ? 'enemies' : 'players';
        this.session._notify();
      }
    });

    // ── Drag & Drop zones ───────────────────────────────────────────────────
    this._bindDropZone(html.find('.vtm-players-zone')[0], 'players');
    this._bindDropZone(html.find('.vtm-enemies-zone')[0], 'enemies');
  }

  _actorIdFromEvent(ev) {
    return ev.currentTarget.closest('[data-actor-id]')?.dataset?.actorId ?? null;
  }

  // ─── Drag & Drop ──────────────────────────────────────────────────────────

  /**
   * Bind all D&D events on a drop zone element.
   * @param {HTMLElement|undefined} el
   * @param {'players'|'enemies'}   side
   */
  _bindDropZone(el, side) {
    if (!el) return;

    el.addEventListener('dragover', ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      el.classList.add('vtm-drop-active');
    });

    el.addEventListener('dragenter', ev => {
      ev.preventDefault();
      el.classList.add('vtm-drop-active');
    });

    el.addEventListener('dragleave', ev => {
      // Only remove highlight when leaving the zone itself, not a child element
      if (!el.contains(ev.relatedTarget)) {
        el.classList.remove('vtm-drop-active');
      }
    });

    el.addEventListener('drop', ev => {
      ev.preventDefault();
      el.classList.remove('vtm-drop-active');
      this._handleDrop(ev, side);
    });
  }

  /**
   * Process a drop event and extract a Foundry Actor.
   * Supports: Actor, Token, Combatant drag types.
   */
  async _handleDrop(event, side) {
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData('text/plain'));
    } catch {
      ui.notifications.warn('VTM Combat: Could not parse dropped data.');
      return;
    }

    let actor = null;

    if (data.type === 'Actor') {
      // Dropped from Actor Directory
      actor = data.uuid
        ? await fromUuid(data.uuid)
        : game.actors.get(data.id);
    } else if (data.type === 'Token') {
      // Dropped from canvas token
      const token = canvas?.tokens?.get(data.id) ?? canvas?.tokens?.placeables?.find(t => t.id === data.id);
      actor = token?.actor ?? null;
    } else if (data.type === 'Combatant') {
      // Dropped from Foundry combat tracker
      const combatant = game.combat?.combatants?.get(data.id);
      actor = combatant?.actor ?? null;
    }

    if (!actor) {
      ui.notifications.warn(`VTM Combat: Could not resolve actor from dropped data (type: ${data.type}).`);
      return;
    }

    this._addActor(actor, side);
  }

  /**
   * Add a Foundry Actor to the session on the given side.
   * @param {Actor}               actor
   * @param {'players'|'enemies'} side
   */
  _addActor(actor, side) {
    if (this.session.participants.has(actor.id)) {
      ui.notifications.info(`${actor.name} is already in combat.`);
      return;
    }

    const adapter = createAdapter(actor);
    this._adapters.set(actor.id, adapter);

    const data = adapter.toPlainObject();
    this.session.addParticipant(data, side);

    ui.notifications.info(`${actor.name} added to ${side === 'players' ? 'Players' : 'Enemies'}.`);
  }

  // ─── Action dialog ────────────────────────────────────────────────────────

  _openActionDialog(actorId) {
    const participant = this.session.getParticipant(actorId);
    if (!participant) return;

    if (this.session.phase !== CombatPhase.INTENT) {
      ui.notifications.warn('Actions can only be set during the Intent phase.');
      return;
    }

    const targets = Array.from(this.session.participants.values())
      .filter(p => p.id !== actorId);

    const dialog = new ActionDialog({
      participant,
      targets,
      onConfirm: (intent) => {
        try {
          this.session.setIntent(actorId, intent);
        } catch (err) {
          ui.notifications.error(err.message);
        }
      },
    });
    dialog.render(true);
  }

  // ─── Resolution ───────────────────────────────────────────────────────────

  async _onResolveAll() {
    if (!this.session.allIntentsSet()) {
      ui.notifications.warn('Not all active participants have set their intent.');
      return;
    }

    this.session.startResolutionPhase();
    const results = this.session.resolveAll();

    // Write damage back to Foundry Actor documents
    for (const result of results) {
      if (result.defenderId && result.damage > 0) {
        const adapter = this._adapters.get(result.defenderId);
        if (adapter) {
          await adapter.applyDamage(result.damage, result.damageType);
          // Refresh in-session snapshot from live actor
          this._syncParticipantFromActor(result.defenderId);
        }
      }
    }

    await this._postChatResults(results);
    this.render(false);
  }

  // ─── Foundry sync helpers ─────────────────────────────────────────────────

  /**
   * Pull fresh data from the live Foundry Actor into the session participant.
   */
  _syncParticipantFromActor(actorId) {
    const adapter = this._adapters.get(actorId);
    const p       = this.session.getParticipant(actorId);
    if (!adapter || !p) return;

    const fresh   = adapter.toPlainObject();
    Object.assign(p, {
      health:        fresh.health,
      willpower:     fresh.willpower,
      hunger:        fresh.hunger,
      statusEffects: fresh.statusEffects,
    });
  }

  // ─── Chat output ──────────────────────────────────────────────────────────

  async _postChatResults(results) {
    if (!results?.length) return;

    const rows = results.map(r =>
      `<li class="vtm-result-entry">${r.narrative}</li>`
    ).join('');

    const content = `
      <div class="vtm-chat-results">
        <h3>Round ${this.session.round} — Combat Results</h3>
        <ul>${rows}</ul>
      </div>`;

    await ChatMessage.create({
      content,
      speaker: { alias: 'VTM Combat Engine' },
    });
  }

  // ─── Hook into live actor updates ────────────────────────────────────────

  /**
   * Call this from the updateActor hook to keep session in sync.
   * @param {Actor}  actor
   * @param {Object} _changes
   */
  onActorUpdate(actor, _changes) {
    if (!this.session.participants.has(actor.id)) return;
    this._syncParticipantFromActor(actor.id);
    this.render(false);
  }
}
