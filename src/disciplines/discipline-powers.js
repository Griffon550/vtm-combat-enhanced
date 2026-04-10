/**
 * VTM V5 Discipline Powers Catalog
 * ─────────────────────────────────────────────────────────────────────────────
 * Einzige Quelle der Wahrheit für alle kampfrelevanten Disziplinkräfte.
 * Jede Kraft ist ein vollständig selbstbeschreibendes Objekt — kein Hard-Coding
 * in der Combat Loop.
 *
 * Felder:
 *   discipline     lowercase Disziplinname (Schlüssel in participant.disciplines)
 *   level          erforderliches Disziplinrating
 *   power          kanonischer Kraftname — dient als eindeutiger Schlüssel
 *   type           passive | modifier | action | reaction
 *   activation     passive | rouse_check | contest
 *   timing         Hook-Zeitpunkt (→ DisciplineEngine)
 *   duration       instant | one_turn | scene | sustained
 *   effect         maschinenlesbare Effektbeschreibung (Engine liest dies aus)
 *   notes          GM-Hinweise für Kräfte die Adjudikation erfordern
 *
 * Timing → Engine-Hook Mapping:
 *   beforeInitiative  rollInitiative()
 *   beforeRoll        _getAttackPool() / _getDefensePool()
 *   onHit             _resolveAttack() nach Trefferermittlung
 *   beforeDamageApply _applyDamageReduction()
 *   onTurnStart       Bewegung / Positionierung (narrativ)
 *   passive           wird über _allPassivePowers() abgerufen
 */

// ─── Potence ──────────────────────────────────────────────────────────────────

const POTENCE = [
  {
    discipline: 'potence',
    level:      1,
    power:      'Lethal Body',
    type:       'modifier',
    activation: 'passive',
    timing:     'onHit',
    duration:   'sustained',
    effect: {
      appliesTo:          ['attack_unarmed'],
      damageTypeOverride: 'aggravated',
      targetType:         'mortal',
    },
    notes: 'Unbewaffnete Treffer gegen Sterbliche gelten als aggravated. Passiv.',
  },
  {
    discipline: 'potence',
    level:      1,
    power:      'Soaring Leap',
    type:       'modifier',
    activation: 'passive',
    timing:     'onTurnStart',
    duration:   'instant',
    effect: {
      rangeControl:        true,
      canCloseRangeQuickly: true,
    },
    notes: 'Schließt Nahkampfdistanz ohne Bewegungskosten. Passiv.',
  },
  {
    discipline: 'potence',
    level:      2,
    power:      'Prowess',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'beforeRoll',
    duration:   'scene',
    effect: {
      appliesTo:   ['attack_unarmed', 'attack_unarmed_finesse', 'attack_light', 'attack_heavy', 'attack_melee'],
      diceBonus:   'scale_with_rating',
      damageBonus: 'scale_with_rating',
    },
    notes: '+Potence-Rating Würfel und Schadensbonus auf Nahkampfangriffe. Rouse Check.',
  },
  {
    discipline: 'potence',
    level:      3,
    power:      'Brutal Feed',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'instant',
    effect: {
      requiresGMRuling:           true,
      enhancesFeedAttack:         true,
    },
    notes: 'Erfordert Grapple oder freies Trefferfenster. GM-Entscheidung.',
  },
  {
    discipline: 'potence',
    level:      4,
    power:      'Spark of Rage',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'beforeRoll',
    duration:   'scene',
    effect: {
      appliesTo: 'all_physical',
      diceBonus: 2,
    },
    notes: '+2 Würfel auf alle physischen Angriffe für eine Szene. Rouse Check.',
  },
  {
    discipline: 'potence',
    level:      4,
    power:      'Crash',
    type:       'action',
    activation: 'passive',
    timing:     'onTurnStart',
    duration:   'instant',
    effect: {
      coverBreak:                   true,
      environmentalDestructionBonus: true,
    },
    notes: 'Zerstört Deckung und Hindernisse. GM bestimmt Bonus.',
  },
  {
    discipline: 'potence',
    level:      5,
    power:      'Fist of Caine',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'beforeRoll',
    duration:   'one_turn',
    effect: {
      appliesTo:          ['attack_unarmed'],
      damageTypeOverride: 'aggravated',
      targetType:         'vampire',
    },
    notes: 'Unbewaffnete Treffer gegen Vampire gelten als aggravated. Rouse Check pro Runde.',
  },
  {
    discipline: 'potence',
    level:      5,
    power:      'Earthshock',
    type:       'action',
    activation: 'rouse_check',
    timing:     'onHit',
    duration:   'instant',
    effect: {
      aoeControl:    true,
      aoeRadius:     2,
      statusApply:   ['destabilized'],
      requiresGMRuling: true,
    },
    notes: 'AoE-Erschütterung. Alle Ziele in Radius 2 → destabilized + Knockdown-Test.',
  },
];

// ─── Celerity ─────────────────────────────────────────────────────────────────

const CELERITY = [
  {
    discipline: 'celerity',
    level:      1,
    power:      "Cat's Grace",
    type:       'modifier',
    activation: 'passive',
    timing:     'onTurnStart',
    duration:   'sustained',
    effect: {
      movementPenaltyReduction: true,
    },
    notes: 'Kein Würfelabzug durch schwieriges Terrain. Passiv.',
  },
  {
    discipline: 'celerity',
    level:      1,
    power:      'Rapid Reflexes',
    type:       'passive',
    activation: 'passive',
    timing:     'beforeInitiative',
    duration:   'sustained',
    effect: {
      diceBonus:          1,
      surpriseResistance: true,
    },
    notes: '+1 Initiative-Würfel. Überraschungsangriffe ohne vollen Effekt. Passiv.',
  },
  {
    discipline: 'celerity',
    level:      2,
    power:      'Swiftness',
    type:       'passive',
    activation: 'passive',
    timing:     'passive',
    duration:   'sustained',
    effect: {
      // Reduziert kumulativen Mehrfachverteidigungsmalus um Celerity-Rating (min 0)
      multiDefensePenaltyReduction: 'scale_with_rating',
    },
    notes: 'Mehrfachverteidigungsmalus −Celerity-Rating pro Runde (min 0). Passiv.',
  },
  {
    discipline: 'celerity',
    level:      2,
    power:      'Fleetness',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'scene',
    effect: {
      rangeControl:  true,
      movementBonus: 'high',
    },
    notes: 'Freie Distanzänderung (melee ↔ ranged) als Bonusaktion. Rouse Check.',
  },
  {
    discipline: 'celerity',
    level:      3,
    power:      'Blink',
    type:       'action',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'instant',
    effect: {
      immediateEngage: true,
      rangeControl:    true,
    },
    notes: 'Sofortiger Nahkampfschluss ohne Aktionskosten. Rouse Check.',
  },
  {
    discipline: 'celerity',
    level:      4,
    power:      'Unerring Aim',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'beforeRoll',
    duration:   'instant',
    effect: {
      appliesTo: ['attack_ranged', 'attack_aimed'],
      diceBonus: 2,
    },
    notes: '+2 Würfel auf Fernkampfangriffe. Rouse Check.',
  },
  {
    discipline: 'celerity',
    level:      5,
    power:      'Lightning Strike',
    type:       'reaction',
    activation: 'rouse_check',
    timing:     'beforeInitiative',
    duration:   'instant',
    effect: {
      initiativeBonus: 5,
      preemptiveAttack: true,
    },
    notes: '+5 Initiative-Erfolge diesen Zug → handelt zuerst. Rouse Check.',
  },
];

// ─── Fortitude ────────────────────────────────────────────────────────────────

const FORTITUDE = [
  {
    discipline: 'fortitude',
    level:      1,
    power:      'Resilience',
    type:       'passive',
    activation: 'passive',
    timing:     'passive',
    duration:   'sustained',
    effect: {
      healthBonus: 'scale_with_rating',
    },
    notes: '+Fortitude-Rating auf effektiven HP-Puffer. Passiv.',
  },
  {
    discipline: 'fortitude',
    level:      1,
    power:      'Unswayable Mind',
    type:       'passive',
    activation: 'passive',
    timing:     'passive',
    duration:   'sustained',
    effect: {
      statusResistBonus: ['mental_control', 'mental_debuff', 'compelled', 'controlled'],
    },
    notes: 'Resistenz gegen mentale Zustände. Passiv.',
  },
  {
    discipline: 'fortitude',
    level:      2,
    power:      'Toughness',
    type:       'reaction',
    activation: 'passive',
    timing:     'beforeDamageApply',
    duration:   'instant',
    effect: {
      appliesTo:      ['superficial'],
      damageReduction: 'scale_with_rating',
    },
    notes: 'Reduziert oberflächlichen Schaden um Fortitude-Rating. Passiv (immer aktiv).',
  },
  {
    discipline: 'fortitude',
    level:      3,
    power:      'Defy Bane',
    type:       'reaction',
    activation: 'rouse_check',
    timing:     'beforeDamageApply',
    duration:   'instant',
    effect: {
      downgradeDamageType: true,
    },
    notes: 'Stuft einen Aggravated-Treffer auf Superficial herunter. Rouse Check.',
  },
  {
    discipline: 'fortitude',
    level:      4,
    power:      'Shatter',
    type:       'reaction',
    activation: 'contest',
    timing:     'onHit',
    duration:   'instant',
    effect: {
      reactiveCounter:  true,
      requiresGMRuling: true,
    },
    notes: 'Reaktiv wenn getroffen: Waffenbruch möglich. Contest + GM-Entscheidung.',
  },
  {
    discipline: 'fortitude',
    level:      5,
    power:      'Flesh of Marble',
    type:       'reaction',
    activation: 'rouse_check',
    timing:     'beforeDamageApply',
    duration:   'one_turn',
    effect: {
      damageReduction: 'scale_with_rating_doubled',
    },
    notes: 'Reduziert jedweden Schaden um Fortitude-Rating × 2 für eine Runde. Rouse Check.',
  },
  {
    discipline: 'fortitude',
    level:      5,
    power:      'Prowess from Pain',
    type:       'modifier',
    activation: 'passive',
    timing:     'beforeRoll',
    duration:   'scene',
    effect: {
      bonusFromDamageTaken: true,
      requiresGMRuling:     true,
    },
    notes: 'Erhaltener Schaden konvertiert in Angriffsboni. GM regelt Skalierung.',
  },
];

// ─── Presence ─────────────────────────────────────────────────────────────────

const PRESENCE = [
  {
    discipline: 'presence',
    level:      1,
    power:      'Daunt',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'scene',
    effect: {
      statusApply:      ['intimidated'],
      targetPoolPenalty: 2,
      requiresContest:  true,
    },
    notes: 'Contest: Charisma+Einschüchterung vs. Standhaftigkeit+Composure. Ziel: -2 Würfel.',
  },
  {
    discipline: 'presence',
    level:      2,
    power:      'Dread Gaze',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'one_turn',
    effect: {
      statusApply:     ['frightened', 'hesitating'],
      mayForceRetreat: true,
      requiresContest: true,
    },
    notes: 'Ziel: frightened + hesitating. Kann Rückzug erzwingen. Contest erforderlich.',
  },
  {
    discipline: 'presence',
    level:      3,
    power:      'Irresistible Voice',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'instant',
    effect: {
      statusApply:      ['compelled'],
      requiresContest:  true,
      requiresGMRuling: true,
    },
    notes: 'Einzelbefehl mit verbessertem Bonus. Contest + GM-Entscheidung über Inhalt.',
  },
  {
    discipline: 'presence',
    level:      4,
    power:      'Majesty',
    type:       'action',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'scene',
    effect: {
      statusApply:        ['majestic'],
      requiresTestToAttack: true,
    },
    notes: 'Nutzer erhält "majestic". Feinde müssen testen um anzugreifen. Rouse Check.',
  },
];

// ─── Dominate ─────────────────────────────────────────────────────────────────

const DOMINATE = [
  {
    discipline: 'dominate',
    level:      1,
    power:      'Compel',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'instant',
    effect: {
      statusApply:              ['compelled'],
      canOverrideImmediateAction: true,
      requiresContest:           true,
    },
    notes: 'Einmaliger einfacher Befehl. Contest: Manipulation+Dominieren vs. Standhaftigkeit+WP.',
  },
  {
    discipline: 'dominate',
    level:      2,
    power:      'Mesmerize',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'one_turn',
    effect: {
      statusApply:              ['controlled'],
      canOverrideTargetBehavior: true,
      requiresContest:           true,
    },
    notes: 'Stärkere Kontrolle für eine Runde. Contest erforderlich.',
  },
  {
    discipline: 'dominate',
    level:      4,
    power:      'Submerged Directive',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'scene',
    effect: {
      statusApply:                ['compelled'],
      implantedConditionalCommand: true,
      requiresContest:             true,
      requiresGMRuling:            true,
    },
    notes: 'Bedingter Befehl. Löst sich bei Trigger aus. GM regelt Bedingung.',
  },
  {
    discipline: 'dominate',
    level:      5,
    power:      'Terminal Decree',
    type:       'action',
    activation: 'contest',
    timing:     'onHit',
    duration:   'one_turn',
    effect: {
      statusApply:        ['controlled'],
      majorActionOverride: true,
      requiresContest:     true,
      requiresGMRuling:    true,
    },
    notes: 'Extremkontrolle. Kann lebensbedrohliche Befehle erzwingen. Sehr hohe Resistenz nötig.',
  },
];

// ─── Protean ──────────────────────────────────────────────────────────────────

const PROTEAN = [
  {
    discipline: 'protean',
    level:      2,
    power:      'Feral Weapons',
    type:       'modifier',
    activation: 'rouse_check',
    timing:     'beforeRoll',
    duration:   'scene',
    effect: {
      appliesTo:          ['attack_unarmed'],
      diceBonus:          2,
      damageBonus:        2,
      damageTypeOverride: 'aggravated',
      naturalWeapon:      true,
    },
    notes: 'Klauen: +2 Würfel, +2 Schaden (aggravated) auf Faustkampf. Rouse Check.',
  },
  {
    discipline: 'protean',
    level:      4,
    power:      'Metamorphosis',
    type:       'action',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'scene',
    effect: {
      formChange:       true,
      requiresGMRuling: true,
    },
    notes: 'Formwechsel mit massiven Kampfboni. GM bestimmt Form und Effekte.',
  },
  {
    discipline: 'protean',
    level:      5,
    power:      'Mist Form',
    type:       'reaction',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'scene',
    effect: {
      statusApply:     ['mist_form'],
      cannotBeTargeted: true,
      limitedOffense:   true,
    },
    notes: 'Nebelform: nicht normal angreifbar. Begrenzter eigener Angriff. Rouse Check.',
  },
];

// ─── Obfuscate ────────────────────────────────────────────────────────────────

const OBFUSCATE = [
  {
    discipline: 'obfuscate',
    level:      1,
    power:      'Cloak of Shadows',
    type:       'modifier',
    activation: 'passive',
    timing:     'passive',
    duration:   'sustained',
    effect: {
      hardToTargetIfHidden: true,
    },
    notes: 'Wenn versteckt: schwer zu zielen. Passiv.',
  },
  {
    discipline: 'obfuscate',
    level:      2,
    power:      'Unseen Passage',
    type:       'modifier',
    activation: 'passive',
    timing:     'onTurnStart',
    duration:   'sustained',
    effect: {
      stealthReposition: true,
    },
    notes: 'Repositionierung ohne Entdeckungsrisiko. Passiv.',
  },
  {
    discipline: 'obfuscate',
    level:      4,
    power:      'Vanish',
    type:       'reaction',
    activation: 'rouse_check',
    timing:     'onTurnStart',
    duration:   'instant',
    effect: {
      statusApply: ['vanished'],
      targetLoss:  true,
    },
    notes: 'Bricht sofort alle Zielanvisierungen. Rouse Check.',
  },
];

// ─── Build flat catalog keyed by power name ────────────────────────────────────

const ALL_POWERS = [
  ...POTENCE, ...CELERITY, ...FORTITUDE,
  ...PRESENCE, ...DOMINATE, ...PROTEAN, ...OBFUSCATE,
];

/**
 * Flat lookup: powerName → PowerDefinition.
 * Use this in DisciplineEngine and UI code.
 * @type {Readonly<Record<string, PowerDefinition>>}
 */
export const DISCIPLINE_POWERS = Object.freeze(
  Object.fromEntries(ALL_POWERS.map(p => [p.power, p]))
);

/**
 * Grouped by discipline name (lowercase) for UI listings.
 * @type {Readonly<Record<string, PowerDefinition[]>>}
 */
export const DISCIPLINES_BY_NAME = Object.freeze({
  potence:   POTENCE,
  celerity:  CELERITY,
  fortitude: FORTITUDE,
  presence:  PRESENCE,
  dominate:  DOMINATE,
  protean:   PROTEAN,
  obfuscate: OBFUSCATE,
});

/** All canonical power names as a Set — for fast membership checks. */
export const KNOWN_POWER_NAMES = Object.freeze(new Set(ALL_POWERS.map(p => p.power)));
