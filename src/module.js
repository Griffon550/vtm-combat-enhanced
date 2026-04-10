/**
 * vtm-combat-enhanced — Module Entry Point
 */

import { CombatModal }             from './ui/combat-modal.js';
import { RollConfirmDialog }       from './ui/roll-confirm-dialog.js';
import { WillpowerRerollDialog }   from './ui/willpower-reroll-dialog.js';
import { registerHelpers }         from './ui/handlebars-helpers.js';
import { Log }                     from './logger.js';

const MODULE_ID    = 'vtm-combat-enhanced';
const SOCKET_EVENT = `module.${MODULE_ID}`;

let _combatModal = null;

function openModal() {
  const closed = _combatModal === null || _combatModal.rendered === false;
  if (closed) _combatModal = new CombatModal();
  _combatModal.render(true);
  return _combatModal;
}

// ─── Socket ───────────────────────────────────────────────────────────────────

/**
 * Emit a socket message to all OTHER clients.
 * @param {string} type
 * @param {Object} payload
 */
export function emitSocket(type, payload = {}) {
  game.socket.emit(SOCKET_EVENT, { type, payload });
}

async function _handleSocket(msg) {
  switch (msg.type) {

    // GM tells everyone to open the modal
    case 'openModal':
      if (!game.user.isGM) openModal();
      break;

    // GM tells everyone to close the modal
    case 'closeModal':
      if (!game.user.isGM) _combatModal?.close();
      break;

    // GM broadcasts full session state — players update their view
    case 'stateUpdate':
      if (!game.user.isGM) {
        const modal = _combatModal ?? openModal();
        modal._syncFromState(msg.payload);
      }
      break;

    // Player sends their intent to the GM
    case 'setIntent':
      if (game.user.isGM && _combatModal) {
        const { participantId, intent } = msg.payload;
        try {
          _combatModal.session.setIntent(participantId, intent);
          // session.onUpdate will broadcast the new state automatically
        } catch (e) {
          console.warn(`${MODULE_ID} | setIntent from player failed:`, e.message);
        }
      }
      break;

    // GM → Spieler: Würfel-Bestätigungsdialog anzeigen
    case 'showRollModal':
      if (!game.user.isGM && msg.payload.targetUserId === game.user.id) {
        const { rollInfo } = msg.payload;
        const decision = await RollConfirmDialog.open(rollInfo);
        // Entscheidung zurück an GM senden
        game.socket.emit(SOCKET_EVENT, {
          type:    'rollDecision',
          payload: { participantId: rollInfo.participantId, decision },
        });
      }
      break;

    // Spieler → GM: Würfelentscheidung verarbeiten
    case 'rollDecision':
      if (game.user.isGM && _combatModal) {
        _combatModal._handleRollDecision(msg.payload);
      }
      break;

    // GM → Spieler: Willpower-Reroll-Dialog anzeigen
    case 'showWillpowerRerollModal':
      if (!game.user.isGM && msg.payload.targetUserId === game.user.id) {
        const { rerollInfo } = msg.payload;
        const decision = await WillpowerRerollDialog.open(rerollInfo);
        game.socket.emit(SOCKET_EVENT, {
          type:    'willpowerRerollDecision',
          payload: { participantId: rerollInfo.participantId, decision },
        });
      }
      break;

    // Spieler → GM: Willpower-Reroll-Entscheidung verarbeiten
    case 'willpowerRerollDecision':
      if (game.user.isGM && _combatModal) {
        _combatModal._handleWillpowerRerollDecision(msg.payload);
      }
      break;

    // Spieler → GM: Lightning Strike aktivieren/deaktivieren
    case 'setLightningStrike':
      if (game.user.isGM && _combatModal) {
        const { participantId, active } = msg.payload;
        try {
          _combatModal.session.setLightningStrike(participantId, active);
        } catch (e) {
          console.warn(`${MODULE_ID} | setLightningStrike from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Fleetness aktivieren/deaktivieren
    case 'setFleetness':
      if (game.user.isGM && _combatModal) {
        const { participantId, active } = msg.payload;
        try {
          _combatModal.session.setFleetness(participantId, active);
        } catch (e) {
          console.warn(`${MODULE_ID} | setFleetness from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Prowess aktivieren/deaktivieren
    case 'setProwess':
      if (game.user.isGM && _combatModal) {
        const { participantId, active } = msg.payload;
        try {
          _combatModal.session.setProwess(participantId, active);
        } catch (e) {
          console.warn(`${MODULE_ID} | setProwess from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Spark of Rage aktivieren/deaktivieren
    case 'setSparkOfRage':
      if (game.user.isGM && _combatModal) {
        const { participantId, active } = msg.payload;
        try {
          _combatModal.session.setSparkOfRage(participantId, active);
        } catch (e) {
          console.warn(`${MODULE_ID} | setSparkOfRage from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Fist of Caine aktivieren/deaktivieren
    case 'setFistOfCaine':
      if (game.user.isGM && _combatModal) {
        const { participantId, active } = msg.payload;
        try {
          _combatModal.session.setFistOfCaine(participantId, active);
        } catch (e) {
          console.warn(`${MODULE_ID} | setFistOfCaine from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Deckungsstatus ändern
    case 'setCover':
      if (game.user.isGM && _combatModal) {
        const { participantId, inCover } = msg.payload;
        try {
          _combatModal.session.setInCover(participantId, inCover);
        } catch (e) {
          console.warn(`${MODULE_ID} | setCover from player failed:`, e.message);
        }
      }
      break;

    // Spieler → GM: Teilnehmer entfernen
    case 'removeParticipant':
      if (game.user.isGM && _combatModal) {
        const { participantId } = msg.payload;
        try {
          _combatModal.session.removeParticipant(participantId);
          _combatModal._adapters.delete(participantId);
        } catch (e) {
          console.warn(`${MODULE_ID} | removeParticipant from player failed:`, e.message);
        }
      }
      break;
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing (Foundry ${game.version})`);

  registerHelpers();

  loadTemplates([
    `modules/${MODULE_ID}/templates/combat-modal.html`,
    `modules/${MODULE_ID}/templates/action-dialog.html`,
    `modules/${MODULE_ID}/templates/dice-popup.html`,
    `modules/${MODULE_ID}/templates/roll-confirm-dialog.html`,
    `modules/${MODULE_ID}/templates/willpower-reroll-dialog.html`,
    `modules/${MODULE_ID}/templates/partials/participant-card.html`,
  ]);

  // Socket listener
  game.socket.on(SOCKET_EVENT, _handleSocket);

  // Keybinding Alt+V
  game.keybindings.register(MODULE_ID, 'openCombat', {
    name:     'Open VTM Combat Enhanced',
    hint:     'Opens the VTM Combat Enhanced modal',
    editable: [{ key: 'KeyV', modifiers: ['Alt'] }],
    onDown:   () => { openModal(); if (game.user.isGM) emitSocket('openModal'); return true; },
  });

  game.settings.register(MODULE_ID, 'autoSyncActors', {
    name:    'Auto-sync actors on update',
    hint:    'Refresh combat modal when Foundry actors are updated.',
    scope:   'world',
    config:  true,
    type:    Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'debugLogging', {
    name:     'Debug-Logging',
    hint:     'Aktiviert detailliertes Logging aller Würfe und Berechnungen in der Browser-Konsole (F12).',
    scope:    'world',
    config:   true,
    type:     Boolean,
    default:  false,
    onChange: val => Log.setDebug(val),
  });
});

// ─── ready ────────────────────────────────────────────────────────────────────

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | Ready`);
  Log.setDebug(game.settings.get(MODULE_ID, 'debugLogging'));

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open:       openModal,
      getModal:   () => _combatModal,
      emitSocket,
    };
  }

  // Chat command /vtmcombat
  Hooks.on('chatMessage', (_log, message) => {
    if (message.trim().toLowerCase() !== '/vtmcombat') return true;
    openModal();
    // If GM opens via chat, also open for players
    if (game.user.isGM) emitSocket('openModal');
    return false;
  });
});

// ─── Scene controls ───────────────────────────────────────────────────────────

Hooks.on('getSceneControlButtons', (controls) => {
  if (Array.isArray(controls)) {
    const group = controls.find(c => c.name === 'token');
    if (group) {
      group.tools.push({
        name: 'vtm-combat', title: 'VTM Combat Enhanced',
        icon: 'fas fa-khanda', visible: true, button: true,
        onClick: () => {
          openModal();
          if (game.user.isGM) emitSocket('openModal');
        },
      });
    }
  } else if (controls && typeof controls === 'object') {
    const group = controls.token ?? controls.tokens ?? Object.values(controls)[0];
    if (group?.tools) {
      group.tools['vtm-combat'] = {
        name: 'vtm-combat', title: 'VTM Combat Enhanced',
        icon: 'fas fa-khanda', visible: true, button: true,
        onChange: () => {
          openModal();
          if (game.user.isGM) emitSocket('openModal');
        },
      };
    }
  }
});

// ─── Actor sync ───────────────────────────────────────────────────────────────

Hooks.on('updateActor', (actor, changes) => {
  if (!game.settings.get(MODULE_ID, 'autoSyncActors')) return;
  _combatModal?.onActorUpdate(actor, changes);
});

Hooks.on('createCombat', () => {
  console.log(`${MODULE_ID} | Alt+V oder /vtmcombat zum Öffnen.`);
});
