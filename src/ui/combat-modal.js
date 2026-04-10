/**
 * Combat Modal — mit Socket-Sync für GM + Spieler
 *
 * GM-Client:     besitzt die echte CombatSession, sendet State-Updates per Socket
 * Spieler-Client: empfängt State-Updates, kann nur eigene Charaktere bedienen
 */

import { CombatSession, CombatPhase, ActionType } from '../combat-engine.js';
import { createAdapter }      from '../adapters/actor-adapter.js';
import { ActionDialog }       from './action-dialog.js';
import { RollConfirmDialog }  from './roll-confirm-dialog.js';
import { WillpowerRerollDialog } from './willpower-reroll-dialog.js';
import { emitSocket }         from '../module.js';
import { evaluate as diceEvaluate, roll as diceRoll } from '../dice/dice-engine.js';
import { Log }                from '../logger.js';

const MODULE_ID = 'vtm-combat-enhanced';
const TEMPLATE  = `modules/${MODULE_ID}/templates/combat-modal.html`;

// Blood Surge bonus dice per Blood Potency level (index 0–10)
const SURGE_BONUS = [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];

export class CombatModal extends Application {
  constructor(options = {}) {
    super(options);

    this._isGM                      = game.user.isGM;
    this.session                    = new CombatSession();
    this._adapters                  = new Map(); // actorId → ActorAdapter (GM only)
    this._pendingDecisions          = new Map(); // participantId → resolve(decision)
    this._pendingWillpowerDecisions = new Map(); // participantId → resolve({ spent, indices })

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

    // Füge Eigentümer-Flag und aufgelöste Zielnamen zu jedem Teilnehmer hinzu
    const enrich = (p) => {
      let intent = p.intent;
      if (intent) {
        const ids = intent.targetIds?.length ? intent.targetIds
                  : (intent.targetId ? [intent.targetId] : []);
        const names = ids.map(id => this.session.getParticipant(id)?.name).filter(Boolean);
        intent = { ...intent, targetName: names.join(', ') || null };
      }
      const owned = isGM || !!(game.actors.get(p.id)?.isOwner);
      return {
        ...p,
        intent,
        isOwned:        owned,
        canSetIntent:   owned && state.phase === CombatPhase.INTENT,
        intentSet:      !!p.intent,
        inCover:          p.inCover ?? false,
        canToggleCover:   owned,
        hasRapidReflexes:       (p.disciplinePowers ?? []).includes('Rapid Reflexes'),
        hasFleetness:           (p.disciplinePowers ?? []).includes('Fleetness'),
        hasBlink:               (p.disciplinePowers ?? []).includes('Blink'),
        hasLightningStrike:     (p.disciplinePowers ?? []).includes('Lightning Strike'),
        hasCompel:              (p.disciplinePowers ?? []).includes('Compel'),
        fleetnessActive:        p.fleetnessActive ?? false,
        lightningStrikeActive:  p.lightningStrikeActive ?? false,
        canToggleFleetness:     owned && (p.disciplinePowers ?? []).includes('Fleetness'),
        canToggleLightningStrike: owned && (p.disciplinePowers ?? []).includes('Lightning Strike'),
        // Potence
        hasLethalBody:          (p.disciplinePowers ?? []).includes('Lethal Body'),
        hasProwess:             (p.disciplinePowers ?? []).includes('Prowess'),
        hasSparkOfRage:         (p.disciplinePowers ?? []).includes('Spark of Rage'),
        hasFistOfCaine:         (p.disciplinePowers ?? []).includes('Fist of Caine'),
        prowessActive:          p.prowessActive ?? false,
        sparkOfRageActive:      p.sparkOfRageActive ?? false,
        fistOfCaineActive:      p.fistOfCaineActive ?? false,
        canToggleProwess:       owned && (p.disciplinePowers ?? []).includes('Prowess'),
        canToggleSparkOfRage:   owned && (p.disciplinePowers ?? []).includes('Spark of Rage'),
        canToggleFistOfCaine:   owned && (p.disciplinePowers ?? []).includes('Fist of Caine'),
      };
    };

    // Eigene Charaktere zuerst anzeigen
    const ownFirst = (a, b) => (b.isOwned ? 1 : 0) - (a.isOwned ? 1 : 0);
    const players = state.participants.filter(p => p.side === 'players').map(enrich).sort(ownFirst);
    const enemies = state.participants.filter(p => p.side === 'enemies').map(enrich).sort(ownFirst);
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
      canEndRound:     isGM && state.phase !== CombatPhase.SETUP,
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
    } else {
      // Entfernen für Spieler (eigene Charaktere) — via Socket an GM
      html.find('[data-action="remove-participant"]').on('click', ev => {
        const id = this._actorId(ev);
        if (!id || !game.actors.get(id)?.isOwner) return;
        emitSocket('removeParticipant', { participantId: id });
      });
    }

    // Lightning Strike toggle
    html.find('[data-action="toggle-lightning-strike"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newVal = !(p.lightningStrikeActive ?? false);
      if (this._isGM) {
        this.session.setLightningStrike(id, newVal);
      } else {
        emitSocket('setLightningStrike', { participantId: id, active: newVal });
      }
    });

    // Fleetness toggle — für Eigentümer (GM + Spieler), nur wenn Power gelernt
    html.find('[data-action="toggle-fleetness"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newVal = !(p.fleetnessActive ?? false);
      if (this._isGM) {
        this.session.setFleetness(id, newVal);
      } else {
        emitSocket('setFleetness', { participantId: id, active: newVal });
      }
    });

    // Cover toggle — für Eigentümer (GM + Spieler)
    html.find('[data-action="toggle-cover"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newCover = !(p.inCover ?? false);
      if (this._isGM) {
        this.session.setInCover(id, newCover);
      } else {
        emitSocket('setCover', { participantId: id, inCover: newCover });
      }
    });

    // Prowess toggle
    html.find('[data-action="toggle-prowess"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newVal = !(p.prowessActive ?? false);
      if (this._isGM) this.session.setProwess(id, newVal);
      else emitSocket('setProwess', { participantId: id, active: newVal });
    });

    // Spark of Rage toggle
    html.find('[data-action="toggle-spark-of-rage"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newVal = !(p.sparkOfRageActive ?? false);
      if (this._isGM) this.session.setSparkOfRage(id, newVal);
      else emitSocket('setSparkOfRage', { participantId: id, active: newVal });
    });

    // Fist of Caine toggle
    html.find('[data-action="toggle-fist-of-caine"]').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const p = this.session.getParticipant(id);
      if (!p) return;
      if (!this._isGM && !game.actors.get(id)?.isOwner) return;
      const newVal = !(p.fistOfCaineActive ?? false);
      if (this._isGM) this.session.setFistOfCaine(id, newVal);
      else emitSocket('setFistOfCaine', { participantId: id, active: newVal });
    });

    // Aktion wählen — für Eigentümer (GM + Spieler)
    html.find('[data-action="choose-action"]').on('click', ev => {
      const id = this._actorId(ev);
      if (id) this._openActionDialog(id);
    });

    // Charakterblatt öffnen — Klick auf Name oder Avatar
    html.find('.vtm-card-name, .vtm-avatar').on('click', ev => {
      const id = this._actorId(ev);
      if (!id) return;
      const actor = game.actors.get(id);
      if (actor) actor.sheet?.render(true);
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
    const impairedPenalty = p.statusEffects?.includes('impaired') ? 2 : 0;

    const pool        = Math.max(1, dex + wits - impairedPenalty);
    const hungerDice  = Math.min(p.hunger ?? 0, pool);
    const normalCount = pool - hungerDice;

    const foundryActor = game.actors.get(id);
    const { normalRolls, hungerRolls } = await this._wod5eRoll({
      basicDice:    normalCount,
      advancedDice: hungerDice,
      actor:        foundryActor ?? undefined,
      data:         foundryActor?.system ?? {},
      title:        `${p.name} — Initiative`,
      quickRoll:    true,
    });

    // Engine mit vorgewürfelten Werten aufrufen (kein zweites Würfeln)
    this.session.rollInitiative(id, {
      roll: () => diceEvaluate(normalRolls, hungerRolls),
    });
  }

  async _rollAllInitiativeWithDisplay() {
    for (const id of this.session.participants.keys()) {
      await this._rollInitiativeWithDisplay(id);
    }
  }

  // ─── Resolution (interaktiv) ──────────────────────────────────────────────

  async _onResolveAll() {
    if (!this._isGM) return;
    if (!this.session.allIntentsSet()) {
      ui.notifications.warn('Noch nicht alle Teilnehmer haben ihre Aktion gewählt.'); return;
    }

    this.session.startResolutionPhase();
    this.render(false);

    const roundCtx              = { defenseCount: new Map(), hasAttacked: new Set() };
    const surgeResults          = new Map();
    const fleetnessRouseResults = new Set();
    // Angriffs-Ergebnisse werden in _processQueue direkt ins Log geschrieben.
    // Nicht-Angriffs-Ergebnisse sammeln wir separat und schreiben sie hier.
    const held               = [];
    const nonAttackResults   = [];

    try {
      const interactions = this.session._buildInteractions();
      Log.debug(`_onResolveAll: ${interactions.length} Interaktion(en)`);

      // Erste Runde: Interaktionen in Initiativereihenfolge
      await this._processQueue(interactions, roundCtx, held, false, surgeResults, fleetnessRouseResults);
      // Zweite Runde: zurückgehaltene Interaktionen
      if (held.length) await this._processQueue(held, roundCtx, [], true, surgeResults, fleetnessRouseResults);

      // Nicht-Angriffs-Aktionen (Disziplin, Sonderaktion) direkt auflösen
      const ATTACK_SET = new Set([
        ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE,
        ActionType.ATTACK_LIGHT,   ActionType.ATTACK_HEAVY,
        ActionType.ATTACK_RANGED,  ActionType.ATTACK_AIMED, ActionType.ATTACK_MELEE,
        ActionType.DOMINATE_COMPEL,
      ]);
      for (const actor of this.session.getInitiativeOrder()) {
        if (!actor.intent || this.session._isIncapacitated(actor)) continue;
        const at = actor.intent.actionType;
        if (ATTACK_SET.has(at) || at === ActionType.DEFEND || at === ActionType.DODGE || at === ActionType.PASS) continue;
        const r = this.session._resolveOne(actor, null, roundCtx);
        if (r) nonAttackResults.push(...(Array.isArray(r) ? r : [r]));
      }

      // Nicht-Angriffs-Ergebnisse ins Log schreiben
      const round = this.session.round;
      for (const r of nonAttackResults) this.session.log.push({ ...r, round });

    } catch (err) {
      Log.error('_onResolveAll Fehler:', err);
      console.error('vtm-combat | _onResolveAll error:', err);
    }

    // Auflösung abgeschlossen — Runde muss manuell per "End Round"-Knopf beendet werden.
    this.session.setPhase(CombatPhase.STATE_UPDATE);
    this.render(true);
  }

  /**
   * Verarbeitet eine Warteschlange von Interaktionen.
   * Angriffs-Ergebnisse werden direkt ins session.log geschrieben und per Socket gesendet.
   * @param {Object[]}  interactions  { type, attacker, defender }
   * @param {Object}    roundCtx
   * @param {Object[]}  heldOut       Interactions, die zurückgehalten wurden (wird befüllt)
   * @param {boolean}   isHeld
   */
  async _processQueue(interactions, roundCtx, heldOut, isHeld, surgeResults = new Map(), fleetnessRouseResults = new Set()) {
    for (const interaction of interactions) {
      const { attacker, defender } = interaction;
      // Aktion wurde durch Compel oder Disziplin unterbunden → überspringen
      if (!attacker.intent) continue;
      if (this.session._isIncapacitated(attacker)) continue;
      // Verteidiger ohne Intent (z.B. nach Compel) gilt als unhindered
      if (defender && !defender.intent && interaction.type === 'opposed') {
        interaction.type = 'unhindered';
      }

      const decision = await this._awaitRollDecision(interaction, isHeld);

      if (decision === 'hold' && !isHeld) {
        heldOut.push(interaction);
      } else if (decision === 'roll') {
        const r = await this._resolveInteractionInteractive(interaction, roundCtx, surgeResults, fleetnessRouseResults);
        if (r) {
          const items = Array.isArray(r) ? r : [r];

          // Schaden sofort auf Foundry-Akteure anwenden (damit IMPAIRED etc. korrekt gesetzt wird)
          for (const item of items) {
            if (item.defenderId && item.damage > 0) {
              const adapter = this._adapters.get(item.defenderId);
              if (adapter) {
                await adapter.applyDamage(item.damage, item.damageType);
                this._syncParticipantFromActor(item.defenderId);
                Log.debug(`Schaden angewendet: ${item.damage} ${item.damageType} auf ${item.defenderName}`);
              }
            }
          }

          // Sofort ins Log schreiben und an alle Clients senden
          for (const item of items) this.session.log.push({ ...item, round: this.session.round });
          emitSocket('stateUpdate', this.session.getState());
          this.render(false);
        }
      }
    }
  }

  /**
   * Öffnet das Würfel-Bestätigungs-Modal für den Besitzer der Angreifer-Seite.
   * @param {Object}  interaction  { type, attacker, defender }
   * @param {boolean} isHeld
   * @returns {Promise<'roll'|'hold'|'abort'>}
   */
  async _awaitRollDecision(interaction, isHeld) {
    const { attacker } = interaction;
    const rollInfo = this._buildRollInfo(interaction, isHeld);

    const ownerUser = game.users.find(u =>
      !u.isGM && u.active &&
      game.actors.get(attacker.id)?.getUserLevel(u) >= (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3)
    );

    if (ownerUser) {
      return new Promise((resolve) => {
        // Timeout: nach 45s automatisch würfeln damit _onResolveAll nicht ewig hängt
        const timeout = setTimeout(() => {
          if (this._pendingDecisions.has(attacker.id)) {
            console.warn(`vtm-combat | Kein Spieler-Entscheid für ${attacker.name} nach 45s — auto-roll`);
            this._pendingDecisions.delete(attacker.id);
            resolve('roll');
          }
        }, 45_000);

        this._pendingDecisions.set(attacker.id, (decision) => {
          clearTimeout(timeout);
          resolve(decision);
        });
        emitSocket('showRollModal', { rollInfo, targetUserId: ownerUser.id });
      });
    } else {
      return RollConfirmDialog.open(rollInfo);
    }
  }

  /**
   * Baut das rollInfo-Objekt für den Bestätigungsdialog.
   * @param {Object}  interaction  { type, attacker, defender }
   * @param {boolean} isHeld
   */
  _buildRollInfo(interaction, isHeld) {
    const { type, attacker, defender } = interaction;
    const intent       = attacker.intent;
    const actionType   = intent.actionType;
    const activePowers = intent.activePowers ?? [];

    const ACTION_LABELS = {
      attack_unarmed:         'Unbewaffnet (Str)',
      attack_unarmed_finesse: 'Unbewaffnet (Dex)',
      attack_light:           'Leichte Waffe',
      attack_heavy:           'Schwere Waffe',
      attack_ranged:          'Fernkampf',
      attack_aimed:           'Gezielter Schuss',
      attack_melee:           'Nahkampf',
      dominate_compel:        'Compel (Dominate 1)',
      discipline:             'Disziplin einsetzen',
      special:                'Sonderaktion',
    };

    const ATTACK_SET = new Set([
      ActionType.ATTACK_UNARMED, ActionType.ATTACK_UNARMED_FINESSE,
      ActionType.ATTACK_LIGHT,   ActionType.ATTACK_HEAVY,
      ActionType.ATTACK_RANGED,  ActionType.ATTACK_AIMED, ActionType.ATTACK_MELEE,
      ActionType.DOMINATE_COMPEL,
    ]);
    const isAttack = ATTACK_SET.has(actionType);

    const targetIds    = intent.targetIds?.length ? intent.targetIds : (intent.targetId ? [intent.targetId] : []);
    const targetNames  = targetIds.map(id => this.session.getParticipant(id)?.name ?? id).filter(Boolean);
    const targetLabel  = targetNames.join(', ') || '';

    let normalDice = 0, hungerDice = 0, totalDice = 0, splitNote = '', surgeNote = '', modifierNote = '';
    if (isAttack) {
      const bd          = this.session._getAttackPool(attacker, actionType, activePowers);

      // Blood Surge Vorschau: Würfel vorhersagen ohne Rouse Check auszulösen
      const hasSurge    = !!intent.bloodSurge;
      const bp          = attacker.bloodPotency ?? 0;
      const surgeDice   = hasSurge ? (SURGE_BONUS[Math.min(bp, 10)] ?? 1) : 0;
      const poolMod     = intent.poolModifier ?? 0;
      const boosted     = bd.total + surgeDice + poolMod;

      const numTargets  = targetIds.length || 1;
      const targetIndex = numTargets > 1 ? Math.max(0, targetIds.indexOf(defender?.id ?? '')) : 0;
      const remainder   = boosted % numTargets;
      const splitTotal  = numTargets > 1
        ? Math.max(1, Math.floor(boosted / numTargets) + (targetIndex < remainder ? 1 : 0))
        : Math.max(1, boosted);
      hungerDice   = Math.min(attacker.hunger ?? 0, splitTotal);
      normalDice   = splitTotal - hungerDice;
      totalDice    = splitTotal;
      if (hasSurge) surgeNote = `+${surgeDice} Blutschub (BP ${bp})`;
      if (poolMod !== 0) modifierNote = `${poolMod > 0 ? '+' : ''}${poolMod} Modifikator`;
      if (numTargets > 1) {
        const defName = defender?.name ?? `Ziel ${targetIndex + 1}`;
        splitNote = `Pool ${boosted}${hasSurge ? ` (${bd.total}+${surgeDice})` : ''} ÷ ${numTargets} Ziele → ${defName}: ${splitTotal} Würfel`;
      }
    }

    // Interaktionstyp-Label für den Dialog
    const interactionLabels = {
      contested:  `⚔ Angriff gegen Gegenangriff — ${defender?.name ?? ''} greift ebenfalls an`,
      opposed:    `🛡 Angriff gegen Verteidigung — ${defender?.name ?? ''} weicht aus`,
      unhindered: `→ Ungehinderter Angriff — ${defender?.name ?? ''} reagiert nicht`,
      compel:     `🧠 Dominate Compel — ${defender?.name ?? ''} widersetzt sich (Entschl.+Intel.)`,
    };

    return {
      participantId:    attacker.id,
      name:             attacker.name,
      img:              attacker.img ?? '',
      actionLabel:      ACTION_LABELS[actionType] ?? actionType,
      targetLabel,
      isAttack,
      normalDice, hungerDice, totalDice, splitNote, surgeNote, modifierNote,
      narrativeHint:    !isAttack ? (intent.specialAction ?? intent.disciplineUsed ?? '') : '',
      isHeld,
      interactionType:  type,
      interactionLabel: interactionLabels[type] ?? '',
    };
  }

  /**
   * Führt einen Blutschub-Rouse Check für einen Teilnehmer durch.
   * Liest Blutpotenz direkt vom Foundry-Actor (Fallback über participant.bloodPotency).
   * Wartet nach dem Roll einen Tick damit der Hunger-Update am Dokument ankommt.
   *
   * @param {Participant} participant
   * @returns {Promise<{surgeDice: number}>}
   */
  async _resolveBloodSurge(participant) {
    if (!participant.intent?.bloodSurge) return { surgeDice: 0 };

    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) {
      console.warn('vtm-combat | BloodSurge: kein Foundry-Actor für', participant.id);
      return { surgeDice: 0 };
    }

    // Blutpotenz: direkt vom Actor lesen (robuster als participant.bloodPotency)
    const bp = foundryActor.type === 'vampire'
      ? Number(foundryActor.system?.blood?.potency ?? participant.bloodPotency ?? 0)
      : Number(participant.bloodPotency ?? 0);

    // Rouse Check
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            'Rouse Check — Blutschub',
    });

    // Tick abwarten: Foundry wendet actor.update() asynchron an —
    // ohne Pause lesen wir evtl. den alten Hunger-Wert
    await new Promise(r => setTimeout(r, 100));

    // Hunger am Participant aktualisieren
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value
      ?? participant.hunger;

    const surgeDice = SURGE_BONUS[Math.min(bp, 10)] ?? 1;
    console.log(`vtm-combat | BloodSurge: BP=${bp}, surgeDice=${surgeDice}, hungerNach=${participant.hunger}`);
    return { surgeDice };
  }

  /**
   * Rouse Check für Lightning Strike (Celerity 5).
   */
  async _resolveLightningStrikeRouse(participant) {
    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) return;
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            `Rouse Check — Lightning Strike (${participant.name})`,
    });
    await new Promise(r => setTimeout(r, 100));
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value ?? participant.hunger;
  }

  /**
   * Rouse Check für Fleetness (Celerity 2).
   * Aktualisiert den Hunger des Participants danach.
   */
  async _resolveFleetenessRouse(participant) {
    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) return;
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            `Rouse Check — Fleetness (${participant.name})`,
    });
    await new Promise(r => setTimeout(r, 100));
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value ?? participant.hunger;
  }

  /** Rouse Check für Prowess (Potence 2). */
  async _resolveProwessRouse(participant) {
    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) return;
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            `Rouse Check — Prowess (${participant.name})`,
    });
    await new Promise(r => setTimeout(r, 100));
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value ?? participant.hunger;
  }

  /** Rouse Check für Spark of Rage (Potence 4). */
  async _resolveSparkOfRageRouse(participant) {
    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) return;
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            `Rouse Check — Spark of Rage (${participant.name})`,
    });
    await new Promise(r => setTimeout(r, 100));
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value ?? participant.hunger;
  }

  /** Rouse Check für Fist of Caine (Potence 5). */
  async _resolveFistOfCaineRouse(participant) {
    const foundryActor = game.actors.get(participant.id);
    if (!foundryActor) return;
    await this._wod5eRoll({
      advancedDice:     1,
      disableBasicDice: true,
      increaseHunger:   true,
      quickRoll:        true,
      actor:            foundryActor,
      data:             foundryActor.system,
      title:            `Rouse Check — Fist of Caine (${participant.name})`,
    });
    await new Promise(r => setTimeout(r, 100));
    participant.hunger = game.actors.get(participant.id)?.system?.hunger?.value ?? participant.hunger;
  }

  // ─── Combat result chat message ────────────────────────────────────────────

  /**
   * Baut eine HTML-Würfelreihe für die Chat-Nachricht.
   * @param {number[]} normalRolls
   * @param {number[]} hungerRolls
   * @returns {string} HTML
   */
  _buildDiceRowHtml(normalRolls, hungerRolls) {
    const dieCls = (v, hunger) => {
      if (v === 10)                      return { cls: 'crit',    sym: '★' };
      if (v >= 6)                        return { cls: 'success', sym: '☥' };
      if (hunger && v === 1)             return { cls: 'bestial', sym: '☠' };
      return                                    { cls: 'fail',    sym: '·' };
    };
    const parts = [
      ...normalRolls.map(v => { const d = dieCls(v, false); return `<span class="vtm-chat-die vtm-chat-die-${d.cls}" title="${v}">${d.sym}</span>`; }),
      ...hungerRolls.map(v => { const d = dieCls(v, true);  return `<span class="vtm-chat-die vtm-chat-die-${d.cls} vtm-chat-die-hunger" title="${v}">${d.sym}</span>`; }),
    ];
    return parts.join('');
  }

  /**
   * Zählt Erfolge aus Würfelreihen (≥6 = 1, Pair-10 = +1 extra).
   */
  _countSuccesses(normalRolls, hungerRolls) {
    const all = [...normalRolls, ...hungerRolls];
    let s = all.filter(v => v >= 6).length;
    const tens = all.filter(v => v === 10).length;
    s += Math.floor(tens / 2);
    return s;
  }

  /**
   * Postet ein WoD5e-artiges Chat-Message-Ergebnis nach einem Contested/Opposed-Wurf.
   */
  async _postCombatChatMessage(result, nRollsA, hRollsA, nRollsD = [], hRollsD = []) {
    try {
      const atkSucc = this._countSuccesses(nRollsA, hRollsA);
      const defSucc = this._countSuccesses(nRollsD, hRollsD);

      const ACTION_ICONS = {
        attack_unarmed:         '👊',
        attack_unarmed_finesse: '👊',
        attack_light:           '🗡',
        attack_heavy:           '⚔',
        attack_ranged:          '🔫',
        attack_aimed:           '🎯',
        attack_melee:           '⚔',
        dominate_compel:        '🧠',
      };
      const icon = ACTION_ICONS[result.actionType] ?? '⚔';

      const atkDiceHtml = this._buildDiceRowHtml(nRollsA, hRollsA);
      const defDiceHtml = nRollsD.length + hRollsD.length > 0
        ? this._buildDiceRowHtml(nRollsD, hRollsD) : null;

      const net     = result.netSuccesses ?? 0;
      const dmg     = result.damage ?? 0;
      const dmgRaw  = result.rawDamage ?? 0;
      const dmgTypeLabel = result.damageType === 'aggravated' ? 'agg' : 'sup';
      const weapon       = result.weapon && result.weapon !== 'Unbewaffnet' ? ` [${result.weapon}]` : '';

      // Schadenszusammensetzung (wie im Combat Log)
      const prowessBonus = result.prowessDamageBonus ?? 0;
      const weaponBonus  = Math.max(0, dmgRaw - net - prowessBonus);
      const formulaParts = net > 0 ? [`${net} Netto`] : [];
      if (prowessBonus > 0) formulaParts.push(`+ ${prowessBonus} Prowess`);
      if (weaponBonus  > 0) formulaParts.push(`+ ${weaponBonus} Waffe`);
      let formula = formulaParts.join(' ');
      if (net > 0 && dmg < dmgRaw) formula += ' ÷2 (Vampir)';
      if (net > 0) formula += ` = <strong>${dmg} ${dmgTypeLabel}</strong>`;

      let outcomeHtml;
      if (result.interactionType === 'contested') {
        const winner = result.contestedNames?.winner;
        if (!winner) {
          outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-tie">Gleichstand — niemand trifft</div>`;
        } else if (dmg > 0) {
          outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-hit">${formula} Schaden an ${result.defenderName}</div>`;
        } else {
          outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-block">${net} Netto — geblockt</div>`;
        }
      } else if (net > 0 && dmg > 0) {
        outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-hit">${formula} Schaden</div>`;
      } else if (net > 0) {
        outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-block">${formula} — Red. auf 0</div>`;
      } else {
        outcomeHtml = `<div class="vtm-chat-outcome vtm-chat-outcome-block">Geblockt</div>`;
      }

      let specialFlags = '';
      if (result.attackRoll?.messyCritical)  specialFlags += `<div class="vtm-chat-flag vtm-chat-flag-messy">💀 Messy Critical!</div>`;
      if (result.attackRoll?.bestialFailure) specialFlags += `<div class="vtm-chat-flag vtm-chat-flag-bestial">⚠ Bestial Failure!</div>`;

      const content = `
        <div class="vtm-chat-result">
          <div class="vtm-chat-title">${icon} ${result.attackerName} → ${result.defenderName}${weapon}</div>
          <div class="vtm-chat-roll-row">
            <span class="vtm-chat-role">Angriff</span>
            <div class="vtm-chat-dice">${atkDiceHtml}</div>
            <span class="vtm-chat-tally">${atkSucc} Erf.</span>
          </div>
          ${defDiceHtml ? `<div class="vtm-chat-roll-row vtm-chat-def-row">
            <span class="vtm-chat-role">Abwehr</span>
            <div class="vtm-chat-dice">${defDiceHtml}</div>
            <span class="vtm-chat-tally">${defSucc} Erf.</span>
          </div>` : ''}
          ${outcomeHtml}
          ${specialFlags}
        </div>`;

      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker(),
        flags:   { 'vtm-combat-enhanced': { combatResult: true } },
      });
    } catch (e) {
      console.warn('vtm-combat | Chat-Nachricht konnte nicht erstellt werden:', e);
    }
  }

  /**
   * Wraps WOD5E.api.Roll in a Promise.
   * Falls back to native Foundry Roll if WOD5E is not available.
   *
   * @param {Object}  params
   * @param {Object}  [opts]
   * @returns {Promise<{normalRolls: number[], hungerRolls: number[]}>}
   */
  /**
   * @param {Object}  params
   * @param {Object}  [opts]
   * @param {boolean} [opts.silent=false]  Wenn true: WOD5E-API umgehen, nur Dice-So-Nice-Animation
   *                                       ohne Chat-Nachricht (Fallback-Pfad).
   */
  async _wod5eRoll(params, { silent = false } = {}) {
    const wod5eRoll = window.WOD5E?.api?.Roll;
    if (!wod5eRoll || silent) {
      // Fallback / silent: Foundry Roll + Dice So Nice — erzeugt KEINE Chat-Nachricht
      const { basicDice = 0, advancedDice = 0 } = params;
      const parts = [basicDice > 0 && `${basicDice}dv`, advancedDice > 0 && `${advancedDice}dg`].filter(Boolean);
      const fRoll = new Roll(parts.join('+') || '1dv');
      await fRoll.evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(fRoll, game.user, true);
      const terms = fRoll.terms.filter(t => Array.isArray(t.results));
      return {
        normalRolls: (terms[0]?.results ?? []).map(r => r.result),
        hungerRolls: (terms[1]?.results ?? []).map(r => r.result),
      };
    }

    return new Promise((resolve, reject) => {
      try {
        wod5eRoll({
          ...params,
          callback: (_err, rollData) => {
            if (_err) { reject(_err); return; }
            const terms = (rollData?.terms ?? []).filter(t => Array.isArray(t.results));
            resolve({
              normalRolls: (terms[0]?.results ?? []).map(r => r.result),
              hungerRolls: (terms[1]?.results ?? []).map(r => r.result),
            });
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Löst eine Interaktion interaktiv auf — Foundry-Würfel für DSN-Animation.
   * Typ A (contested): beide Seiten rollen Angriffspool.
   * Typ B (opposed):   Angreifer rollt Angriffspool, Verteidigung intern.
   * Typ C (unhindered): Angreifer rollt, kein Verteidigungswurf.
   *
   * @param {Object} interaction  { type, attacker, defender }
   * @param {Object} roundCtx
   */
  async _resolveInteractionInteractive(interaction, roundCtx, surgeResults = new Map(), fleetnessRouseResults = new Set()) {
    const { type, attacker, defender } = interaction;
    const intent       = attacker.intent;
    const activePowers = intent.activePowers ?? [];

    // ── Blood Surge (Angreifer) — nur 1× pro Runde, nicht 1× pro Ziel ────────
    if (!surgeResults.has(attacker.id)) {
      const { surgeDice } = await this._resolveBloodSurge(attacker);
      surgeResults.set(attacker.id, surgeDice);
    }
    const surgeDice = surgeResults.get(attacker.id);

    // ── Angriffspool des Angreifers ───────────────────────────────────────────
    const bd           = this.session._getAttackPool(attacker, intent.actionType, activePowers);
    const numTargets   = intent.targetIds?.length || 1;
    const targetIndex  = intent.targetIds?.indexOf(defender.id) ?? 0;
    const poolMod      = intent.poolModifier ?? 0;
    const boostedTotal = Math.max(1, bd.total + surgeDice + poolMod);
    const splitTotal   = numTargets > 1
      ? Math.max(1, Math.floor(boostedTotal / numTargets) + (targetIndex < boostedTotal % numTargets ? 1 : 0))
      : boostedTotal;
    const splitHunger = Math.min(attacker.hunger ?? 0, splitTotal);
    const normalDice  = splitTotal - splitHunger;

    // ── Lightning Strike Rouse Check (Angreifer) — 1× pro Runde ─────────────
    if (attacker.lightningStrikeActive
        && (attacker.disciplinePowers ?? []).includes('Lightning Strike')
        && !fleetnessRouseResults.has(`ls_${attacker.id}`)) {
      await this._resolveLightningStrikeRouse(attacker);
      fleetnessRouseResults.add(`ls_${attacker.id}`);
    }

    // ── Fleetness Rouse Check (Verteidiger) — 1× pro Runde ───────────────────
    if (defender && defender.fleetnessActive
        && (defender.disciplinePowers ?? []).includes('Fleetness')
        && !fleetnessRouseResults.has(defender.id)) {
      await this._resolveFleetenessRouse(defender);
      fleetnessRouseResults.add(defender.id);
    }

    // ── Prowess Rouse Check (Angreifer) — 1× pro Runde ───────────────────────
    if (attacker.prowessActive
        && (attacker.disciplinePowers ?? []).includes('Prowess')
        && !fleetnessRouseResults.has(`prowess_${attacker.id}`)) {
      await this._resolveProwessRouse(attacker);
      fleetnessRouseResults.add(`prowess_${attacker.id}`);
    }

    // ── Spark of Rage Rouse Check (Angreifer) — 1× pro Runde ─────────────────
    if (attacker.sparkOfRageActive
        && (attacker.disciplinePowers ?? []).includes('Spark of Rage')
        && !fleetnessRouseResults.has(`spark_${attacker.id}`)) {
      await this._resolveSparkOfRageRouse(attacker);
      fleetnessRouseResults.add(`spark_${attacker.id}`);
    }

    // ── Fist of Caine Rouse Check (Angreifer) — 1× pro Runde ─────────────────
    if (attacker.fistOfCaineActive
        && (attacker.disciplinePowers ?? []).includes('Fist of Caine')
        && !fleetnessRouseResults.has(`foc_${attacker.id}`)) {
      await this._resolveFistOfCaineRouse(attacker);
      fleetnessRouseResults.add(`foc_${attacker.id}`);
    }

    // ── WOD5E-Roll für Angreifer (silent = keine Chat-Nachricht) ─────────────
    Log.group(`${interaction.type}: ${attacker.name} → ${defender?.name ?? '?'}`);
    Log.wod5eRequest(`${attacker.name} — Angriff`, normalDice, splitHunger);
    const foundryActorA = game.actors.get(attacker.id);
    let { normalRolls: nRollsA, hungerRolls: hRollsA } = await this._wod5eRoll({
      basicDice:    normalDice,
      advancedDice: splitHunger,
      actor:        foundryActorA ?? undefined,
      data:         foundryActorA?.system ?? {},
      title:        `${attacker.name} — Angriff`,
      quickRoll:    true,
    }, { silent: true });
    // Willpower-Angebot kommt erst NACH dem Gegner-Würfelwurf (s. unten je Branch)

    if (type === 'compel') {
      // ── Compel: erst Verteidiger würfeln, dann Willpower für Angreifer ────────
      const resolveAttr  = defender.attributes?.resolve      ?? 1;
      const intelligence = defender.attributes?.intelligence ?? 2;
      const impairedDef  = defender.statusEffects?.includes('impaired') ? 2 : 0;
      const defPool      = Math.max(1, resolveAttr + intelligence - impairedDef);

      Log.wod5eRequest(`${defender.name} — Widerstand (Compel)`, defPool, 0);
      const foundryActorD = game.actors.get(defender.id);
      const { normalRolls: nRollsD, hungerRolls: hRollsD } = await this._wod5eRoll({
        basicDice:    defPool,
        advancedDice: 0,
        actor:        foundryActorD ?? undefined,
        data:         foundryActorD?.system ?? {},
        title:        `${defender.name} — Widerstand (Compel)`,
        quickRoll:    true,
      }, { silent: true });
      Log.wod5eResult(`${defender.name} — Widerstand (Compel)`, nRollsD, hRollsD);

      // Beide gewürfelt — jetzt Willpower für Angreifer anbieten (Gegner-Würfel sichtbar)
      ({ normalRolls: nRollsA, hungerRolls: hRollsA } =
        await this._offerWillpowerReroll(attacker, nRollsA, hRollsA,
          { name: defender.name, normalRolls: nRollsD, hungerRolls: hRollsD }));
      Log.wod5eResult(`${attacker.name} — Angriff (final)`, nRollsA, hRollsA);

      let callCount = 0;
      const diceOverride = {
        roll: (pool, hunger) => {
          callCount++;
          if (callCount === 1) return diceEvaluate(nRollsA, hRollsA);
          if (callCount === 2) return diceEvaluate(nRollsD, hRollsD);
          return diceRoll(pool, hunger);
        },
      };
      const result = this.session._resolveCompel(attacker, defender, diceOverride, roundCtx);
      await this._postCombatChatMessage(result, nRollsA, hRollsA, nRollsD, hRollsD);
      Log.groupEnd();
      return result;

    } else if (type === 'contested') {
      // ── Contested: erst BEIDE würfeln, dann Willpower für beide ──────────────
      const defIntent       = defender.intent;
      const defActivePowers = defIntent.activePowers ?? [];

      if (!surgeResults.has(defender.id)) {
        const { surgeDice: ds } = await this._resolveBloodSurge(defender);
        surgeResults.set(defender.id, ds);
      }
      const defSurgeDice = surgeResults.get(defender.id);

      const defBd           = this.session._getAttackPool(defender, defIntent.actionType, defActivePowers);
      const defNumTargets   = defIntent.targetIds?.length || 1;
      const defTargetIndex  = defIntent.targetIds?.indexOf(attacker.id) ?? 0;
      const defBoostedTotal = defBd.total + defSurgeDice;
      const defSplitTotal   = defNumTargets > 1
        ? Math.max(1, Math.floor(defBoostedTotal / defNumTargets) + (defTargetIndex < defBoostedTotal % defNumTargets ? 1 : 0))
        : defBoostedTotal;
      const defSplitHunger  = Math.min(defender.hunger ?? 0, defSplitTotal);
      const defNormalDice   = defSplitTotal - defSplitHunger;

      Log.wod5eRequest(`${defender.name} — Gegenangriff`, defNormalDice, defSplitHunger);
      const foundryActorB = game.actors.get(defender.id);
      let { normalRolls: nRollsB, hungerRolls: hRollsB } = await this._wod5eRoll({
        basicDice:    defNormalDice,
        advancedDice: defSplitHunger,
        actor:        foundryActorB ?? undefined,
        data:         foundryActorB?.system ?? {},
        title:        `${defender.name} — Gegenangriff`,
        quickRoll:    true,
      }, { silent: true });

      // Beide gewürfelt — Willpower für beide anbieten; Gegner-Würfel jeweils sichtbar
      ({ normalRolls: nRollsA, hungerRolls: hRollsA } =
        await this._offerWillpowerReroll(attacker, nRollsA, hRollsA,
          { name: defender.name, normalRolls: nRollsB, hungerRolls: hRollsB }));
      Log.wod5eResult(`${attacker.name} — Angriff (final)`, nRollsA, hRollsA);

      ({ normalRolls: nRollsB, hungerRolls: hRollsB } =
        await this._offerWillpowerReroll(defender, nRollsB, hRollsB,
          { name: attacker.name, normalRolls: nRollsA, hungerRolls: hRollsA }));
      Log.wod5eResult(`${defender.name} — Gegenangriff (final)`, nRollsB, hRollsB);

      let callCount = 0;
      const diceOverride = {
        roll: () => {
          callCount++;
          if (callCount === 1) return diceEvaluate(nRollsA, hRollsA);
          if (callCount === 2) return diceEvaluate(nRollsB, hRollsB);
          return diceRoll(0, 0);
        },
      };
      const result = this.session._resolveContested(attacker, defender, diceOverride, roundCtx);
      await this._postCombatChatMessage(result, nRollsA, hRollsA, nRollsB, hRollsB);
      Log.groupEnd();
      return result;

    } else if (type === 'unhindered') {
      // ── Unhindered: kein Verteidiger-Wurf — Willpower sofort anbieten ─────────
      ({ normalRolls: nRollsA, hungerRolls: hRollsA } =
        await this._offerWillpowerReroll(attacker, nRollsA, hRollsA));
      Log.wod5eResult(`${attacker.name} — Angriff (final)`, nRollsA, hRollsA);

      let called = false;
      const diceOverride = {
        roll: (pool, hunger) => {
          if (!called) { called = true; return diceEvaluate(nRollsA, hRollsA); }
          return diceRoll(pool, hunger);
        },
      };
      const result = this.session._resolveUnhindered(attacker, defender, diceOverride, roundCtx);
      await this._postCombatChatMessage(result, nRollsA, hRollsA);
      Log.groupEnd();
      return result;

    } else {
      // ── Opposed: erst BEIDE würfeln, dann Willpower für beide ────────────────
      let nRollsD = [], hRollsD = [];

      const isDefenderActive = defender && !this.session._isIncapacitated(defender)
        && !defender.statusEffects?.includes('restrained')
        && !defender.statusEffects?.includes('surprised')
        && !(attacker.lightningStrikeActive && (attacker.disciplinePowers ?? []).includes('Lightning Strike'));

      if (isDefenderActive) {
        const prevDef            = roundCtx?.defenseCount.get(defender.id) ?? 0;
        const hasAttackedPenalty = (roundCtx?.hasAttacked.has(defender.id) && prevDef === 0) ? 1 : 0;
        const multiDefPenalty    = Math.max(0, prevDef + hasAttackedPenalty);
        const defTi              = defender.intent ?? { actionType: 'defend' };
        const defBd              = this.session._getDefensePool(defender, defTi, multiDefPenalty, { prevDefenses: prevDef, hasAttackedPenalty }, intent.actionType);

        // Blood Surge für Verteidiger (Rouse Check, 1× pro Runde)
        let defSurgeDice = 0;
        if (defTi.bloodSurge) {
          if (!surgeResults.has(`def_${defender.id}`)) {
            const { surgeDice: ds } = await this._resolveBloodSurge(defender);
            surgeResults.set(`def_${defender.id}`, ds);
          }
          defSurgeDice = surgeResults.get(`def_${defender.id}`) ?? 0;
        }
        const defPoolMod = defTi.poolModifier ?? 0;
        const defHunger  = defBd.hungerDice;
        const defNormal  = Math.max(0, defBd.total - defHunger + defSurgeDice + defPoolMod);
        Log.wod5eRequest(`${defender.name} — Verteidigung`, defNormal, defHunger);
        const defResult = await this._wod5eRoll({
          basicDice:    defNormal,
          advancedDice: defHunger,
          title:        `${defender.name} — Verteidigung`,
          quickRoll:    true,
        }, { silent: true });
        nRollsD = defResult.normalRolls;
        hRollsD = defResult.hungerRolls;
      }

      // Beide gewürfelt — Willpower für beide anbieten; Gegner-Würfel jeweils sichtbar
      ({ normalRolls: nRollsA, hungerRolls: hRollsA } =
        await this._offerWillpowerReroll(attacker, nRollsA, hRollsA,
          isDefenderActive ? { name: defender.name, normalRolls: nRollsD, hungerRolls: hRollsD } : null));
      Log.wod5eResult(`${attacker.name} — Angriff (final)`, nRollsA, hRollsA);

      if (isDefenderActive) {
        ({ normalRolls: nRollsD, hungerRolls: hRollsD } =
          await this._offerWillpowerReroll(defender, nRollsD, hRollsD,
            { name: attacker.name, normalRolls: nRollsA, hungerRolls: hRollsA }));
        Log.wod5eResult(`${defender.name} — Verteidigung (final)`, nRollsD, hRollsD);
      }

      let callCount = 0;
      const diceOverride = {
        roll: (pool, hunger) => {
          callCount++;
          if (callCount === 1) return diceEvaluate(nRollsA, hRollsA);
          if (callCount === 2 && isDefenderActive) return diceEvaluate(nRollsD, hRollsD);
          return diceRoll(pool, hunger);
        },
      };
      const result = this.session._resolveOpposed(attacker, defender, diceOverride, roundCtx);
      await this._postCombatChatMessage(result, nRollsA, hRollsA, nRollsD, hRollsD);
      Log.groupEnd();
      return result;
    }
  }

  /**
   * Wird von module.js aufgerufen wenn ein Spieler seine Würfelentscheidung gesendet hat.
   * @param {{ participantId: string, decision: string }} payload
   */
  _handleRollDecision({ participantId, decision }) {
    const resolve = this._pendingDecisions.get(participantId);
    if (resolve) {
      this._pendingDecisions.delete(participantId);
      resolve(decision);
    }
  }

  /**
   * Wird von module.js aufgerufen wenn ein Spieler seine Willpower-Reroll-Entscheidung gesendet hat.
   * @param {{ participantId: string, decision: { spent: boolean, indices: number[] } }} payload
   */
  _handleWillpowerRerollDecision({ participantId, decision }) {
    const resolve = this._pendingWillpowerDecisions.get(participantId);
    if (resolve) {
      this._pendingWillpowerDecisions.delete(participantId);
      resolve(decision);
    }
  }

  /**
   * Wartet auf die Willpower-Reroll-Entscheidung des Spielers.
   * Bei Spieler-Besitzer: Dialog per Socket senden, auf Antwort warten.
   * Bei GM-Besitzer: Dialog direkt anzeigen.
   *
   * @param {Object}   participant
   * @param {number[]} normalRolls
   * @param {number[]} hungerRolls
   * @returns {Promise<{ spent: boolean, indices: number[] }>}
   */
  async _awaitWillpowerRerollDecision(participant, normalRolls, hungerRolls, opponentInfo = null) {
    const rerollInfo = {
      participantId:  participant.id,
      name:           participant.name,
      img:            participant.img,
      normalRolls,
      hungerRolls,
      willpowerValue: participant.willpower?.value ?? 0,
      willpowerMax:   participant.willpower?.max   ?? 6,
      opponentInfo,
    };

    const ownerUser = game.users.find(u =>
      !u.isGM && u.active &&
      game.actors.get(participant.id)?.getUserLevel(u) >= (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3)
    );

    if (ownerUser) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this._pendingWillpowerDecisions.has(participant.id)) {
            this._pendingWillpowerDecisions.delete(participant.id);
            resolve({ spent: false, indices: [] });
          }
        }, 30_000);

        this._pendingWillpowerDecisions.set(participant.id, (decision) => {
          clearTimeout(timeout);
          resolve(decision);
        });
        emitSocket('showWillpowerRerollModal', { rerollInfo, targetUserId: ownerUser.id });
      });
    } else {
      return WillpowerRerollDialog.open(rerollInfo);
    }
  }

  /**
   * Bietet dem Teilnehmer an, Willpower auszugeben und bis zu 3 normale Würfel neu zu würfeln.
   * Gibt die (ggf. aktualisierten) Würfelergebnisse zurück.
   *
   * @param {Object}   participant
   * @param {number[]} normalRolls
   * @param {number[]} hungerRolls
   * @returns {Promise<{ normalRolls: number[], hungerRolls: number[] }>}
   */
  async _offerWillpowerReroll(participant, normalRolls, hungerRolls, opponentInfo = null) {
    // Kein Angebot wenn keine Willpower verfügbar oder keine normalen Würfel vorhanden
    if ((participant.willpower?.value ?? 0) <= 0) return { normalRolls, hungerRolls };
    if (normalRolls.length === 0)                 return { normalRolls, hungerRolls };

    const decision = await this._awaitWillpowerRerollDecision(participant, normalRolls, hungerRolls, opponentInfo);
    if (!decision.spent || decision.indices.length === 0) return { normalRolls, hungerRolls };

    // Willpower ausgeben
    const adapter = this._adapters.get(participant.id);
    if (adapter) {
      await adapter.spendWillpower();
      this._syncParticipantFromActor(participant.id);
      Log.debug(`${participant.name} gibt Willpower aus für Reroll von Würfeln: [${decision.indices.join(', ')}]`);
    }

    // Neu würfeln via WOD5E — mit Animation und Chat-Darstellung
    const rerollCount  = Math.min(decision.indices.length, 3);
    const foundryActor = game.actors.get(participant.id);
    Log.debug(`${participant.name} — Willpower Re-roll: ${rerollCount} Würfel via WOD5E`);
    const { normalRolls: rerolledValues } = await this._wod5eRoll({
      basicDice:    rerollCount,
      advancedDice: 0,
      actor:        foundryActor ?? undefined,
      data:         foundryActor?.system ?? {},
      title:        `${participant.name} — Willpower Re-roll`,
      quickRoll:    true,
    });

    // Ausgewählte Würfelpositionen durch die neuen Werte ersetzen
    const newNormal = [...normalRolls];
    decision.indices.slice(0, 3).forEach((idx, i) => {
      if (rerolledValues[i] !== undefined) newNormal[idx] = rerolledValues[i];
    });

    Log.debug(`Willpower Reroll — vorher: [${normalRolls.join(', ')}] → nachher: [${newNormal.join(', ')}]`);
    return { normalRolls: newNormal, hungerRolls };
  }

  // ─── Socket-Sync (Spieler-Seite) ──────────────────────────────────────────

  /**
   * Empfängt einen State-Snapshot vom GM und aktualisiert das Modal.
   * Wird von module.js aufgerufen wenn eine 'stateUpdate'-Nachricht ankommt.
   * @param {SessionState} state
   */
  _syncFromState(state) {
    this.session.loadState(state);
    this.render(true);
  }

  // ─── Hilfsmethoden ───────────────────────────────────────────────────────

  _syncParticipantFromActor(actorId) {
    const adapter = this._adapters.get(actorId);
    const p = this.session.getParticipant(actorId);
    if (!adapter || !p) return;
    const fresh = adapter.toPlainObject();
    Object.assign(p, {
      health:       fresh.health,
      willpower:    fresh.willpower,
      hunger:       fresh.hunger,
      statusEffects: fresh.statusEffects,
      bloodPotency: fresh.bloodPotency ?? p.bloodPotency,
    });
    // wod5e schreibt 'impaired', 'torpor' etc. nicht immer in actor.statuses —
    // status aus aktuellen Health-Werten neu berechnen und ergänzen.
    this.session._checkStatus(p, []);
    Log.debug(
      `Sync ${p.name}: HP ${p.health.value}/${p.health.max}` +
      ` (sup=${p.health.superficial} agg=${p.health.aggravated})` +
      ` Status: [${p.statusEffects.join(', ') || '—'}]`
    );
  }

  onActorUpdate(actor, _changes) {
    if (!this.session.participants.has(actor.id)) return;
    if (this._isGM) {
      // GM hat Adapter → direkt vom Actor lesen und State broadcasten
      this._syncParticipantFromActor(actor.id);
      emitSocket('stateUpdate', this.session.getState());
    }
    // Alle (GM + Spieler): Modal neu rendern
    this.render(false);
  }
}
