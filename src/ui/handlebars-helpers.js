/**
 * Handlebars Helpers
 * Registered once during module init.
 * All helpers are pure functions — no Foundry dependencies beyond registration.
 */

import { ActionType } from '../combat-engine.js';

const ACTION_LABELS = {
  [ActionType.ATTACK_MELEE]:  'Melee Attack',
  [ActionType.ATTACK_RANGED]: 'Ranged Attack',
  [ActionType.DEFEND]:        'Defend',
  [ActionType.DODGE]:         'Dodge',
  [ActionType.DISCIPLINE]:    'Discipline',
  [ActionType.SPECIAL]:       'Special',
  [ActionType.PASS]:          'Pass',
};

export function registerHelpers() {
  // Handlebars.registerHelper is a global in Foundry
  const H = Handlebars;

  // Equality check: {{#eq a b}}...{{/eq}}
  H.registerHelper('eq', (a, b) => a === b);

  // Human-readable action label
  H.registerHelper('intentLabel', (actionType) => {
    return ACTION_LABELS[actionType] ?? actionType ?? '—';
  });

  // Find a participant name from the session (passed via context)
  // Usage: {{targetName intent.targetId}} — falls back to the raw ID
  H.registerHelper('targetName', function (targetId) {
    if (!targetId) return '';
    // Try to find in Handlebars context (data root)
    const participants = this?.participants ?? [];
    const found = participants.find(p => p.id === targetId);
    return found ? found.name : targetId;
  });

  // Build an array of N items for pip loops
  H.registerHelper('healthPips', (max) => {
    return Array.from({ length: Number(max) || 10 }, (_, i) => i);
  });

  H.registerHelper('hungerPips', () => {
    return Array.from({ length: 5 }, (_, i) => i);
  });

  // Determine pip fill state
  H.registerHelper('pipClass', (currentValue, index) => {
    return index < Number(currentValue) ? 'filled' : '';
  });

  H.registerHelper('hungerPipClass', (hunger, index) => {
    return index < Number(hunger) ? 'filled' : '';
  });

  // Status → CSS class
  H.registerHelper('statusClass', (statusEffects) => {
    if (!statusEffects?.length) return '';
    const priority = ['torpor', 'disabled', 'impaired', 'dominated'];
    for (const s of priority) {
      if (statusEffects.includes(s)) return `vtm-status-${s}`;
    }
    return '';
  });
}
