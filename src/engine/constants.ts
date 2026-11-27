import type {
  Age,
  CardColor,
  FunctionalIcon,
  SpecialAchievementDef,
  SpecialAchievementId,
} from './types';

export const ALL_AGES: readonly Age[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export const STANDARD_ACHIEVEMENT_AGES: readonly Age[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const ALL_COLORS: readonly CardColor[] = ['red', 'yellow', 'green', 'blue', 'purple'];

export const ALL_FUNCTIONAL_ICONS: readonly FunctionalIcon[] = [
  'tower',
  'coin',
  'leaf',
  'lightbulb',
  'factory',
  'clock',
  'persona',
];

export const EMPIRE_ICONS: readonly FunctionalIcon[] = [
  'tower',
  'coin',
  'leaf',
  'lightbulb',
  'factory',
  'clock',
];

export const AGE_NAMES: Record<Age, string> = {
  1: 'Prehistory',
  2: 'Classical',
  3: 'Medieval',
  4: 'Discovery',
  5: 'Exploration',
  6: 'Enlightenment',
  7: 'Romance',
  8: 'Modern',
  9: 'Postmodern',
  10: 'Information',
  11: 'Prudence',
};

export const COLOR_LABELS: Record<CardColor, string> = {
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

export const ICON_LABELS: Record<FunctionalIcon, string> = {
  tower: 'Tower',
  coin: 'Coin',
  leaf: 'Leaf',
  lightbulb: 'Lightbulb',
  factory: 'Factory',
  clock: 'Clock',
  persona: 'Persona',
};

export const SPECIAL_ACHIEVEMENTS: Record<SpecialAchievementId, SpecialAchievementDef> = {
  monument: {
    id: 'monument',
    name: 'Monument',
    description: 'Have at least 4 top cards with a DEMAND effect on your board.',
    altCardName: 'Masonry',
    altCardAge: 1,
  },
  empire: {
    id: 'empire',
    name: 'Empire',
    description: 'Have at least 3 visible icons of each of the 6 classic types (Tower, Coin, Leaf, Lightbulb, Factory, Clock).',
    altCardName: 'Construction',
    altCardAge: 2,
  },
  world: {
    id: 'world',
    name: 'World',
    description: 'Have at least 12 Clock icons visible on your board.',
    altCardName: 'Translation',
    altCardAge: 3,
  },
  wonder: {
    id: 'wonder',
    name: 'Wonder',
    description: 'Have 5 colors splayed on your board, each splayed Right, Up, or Aslant.',
    altCardName: 'Invention',
    altCardAge: 4,
  },
  universe: {
    id: 'universe',
    name: 'Universe',
    description: 'Have 5 top cards on your board, each of value at least 8.',
    altCardName: 'Astronomy',
    altCardAge: 5,
  },
};
