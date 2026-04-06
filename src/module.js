/**
 * vtm-combat-enhanced — Module Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers Foundry hooks, adds the toolbar button, and wires up live actor
 * sync so the combat modal stays up to date when actors change elsewhere.
 */

import { CombatModal }        from './ui/combat-modal.js';
import { registerHelpers }   from './ui/handlebars-helpers.js';

const MODULE_ID = 'vtm-combat-enhanced';

// Module-level singleton so all hooks share the same instance.
let _combatModal = null;

function getOrCreateModal() {
  if (!_combatModal || _combatModal._state === Application.RENDER_STATES.CLOSED) {
    _combatModal = new CombatModal();
  }
  return _combatModal;
}

// ─── Foundry: init ────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing VTM Combat Enhanced`);

  // Register Handlebars helpers before any template renders
  registerHelpers();

  // Register any module settings here
  game.settings.register(MODULE_ID, 'autoSyncActors', {
    name: 'Auto-sync actors on update',
    hint: 'Refresh combat modal when Foundry actors are updated.',
    scope:   'world',
    config:  true,
    type:    Boolean,
    default: true,
  });
});

// ─── Foundry: ready ───────────────────────────────────────────────────────────

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | Ready`);
});

// ─── Toolbar button ───────────────────────────────────────────────────────────

Hooks.on('getSceneControlButtons', (controls) => {
  // Add a button to the token controls group
  const tokenControls = controls.find(c => c.name === 'token');
  if (!tokenControls) return;

  tokenControls.tools.push({
    name:    'vtm-combat',
    title:   'VTM Combat Enhanced',
    icon:    'fas fa-khanda',
    visible: true,
    onClick: () => getOrCreateModal().render(true),
    button:  true,
  });
});

// ─── Actor update sync ────────────────────────────────────────────────────────

Hooks.on('updateActor', (actor, changes, _options, _userId) => {
  if (!game.settings.get(MODULE_ID, 'autoSyncActors')) return;
  if (!_combatModal) return;

  _combatModal.onActorUpdate(actor, changes);
});

// ─── Combat tracker integration (optional) ───────────────────────────────────

Hooks.on('createCombat', (_combat, _options, _userId) => {
  // Could pre-populate the modal from the Foundry combat tracker here
  console.log(`${MODULE_ID} | Combat created — open VTM Combat Enhanced to use the enhanced system.`);
});

Hooks.on('updateCombat', (_combat, _changes, _options, _userId) => {
  // If desired, sync initiative changes back from the tracker
});

// ─── Public API (accessible as game.modules.get('vtm-combat-enhanced').api) ──

Hooks.once('ready', () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      openCombatModal: () => getOrCreateModal().render(true),
      getModal:        () => _combatModal,
    };
  }
});
