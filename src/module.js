/**
 * vtm-combat-enhanced — Module Entry Point
 */

import { CombatModal }     from './ui/combat-modal.js';
import { registerHelpers } from './ui/handlebars-helpers.js';

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

function _handleSocket(msg) {
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
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing (Foundry ${game.version})`);

  registerHelpers();

  loadTemplates([
    `modules/${MODULE_ID}/templates/combat-modal.html`,
    `modules/${MODULE_ID}/templates/action-dialog.html`,
    `modules/${MODULE_ID}/templates/partials/participant-card.html`,
  ]);

  // Socket listener
  game.socket.on(SOCKET_EVENT, _handleSocket);

  // Keybinding Alt+V
  game.keybindings.register(MODULE_ID, 'openCombat', {
    name:     'Open VTM Combat Enhanced',
    hint:     'Opens the VTM Combat Enhanced modal',
    editable: [{ key: 'KeyV', modifiers: ['Alt'] }],
    onDown:   () => { openModal(); return true; },
  });

  game.settings.register(MODULE_ID, 'autoSyncActors', {
    name:    'Auto-sync actors on update',
    hint:    'Refresh combat modal when Foundry actors are updated.',
    scope:   'world',
    config:  true,
    type:    Boolean,
    default: true,
  });
});

// ─── ready ────────────────────────────────────────────────────────────────────

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | Ready`);

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
