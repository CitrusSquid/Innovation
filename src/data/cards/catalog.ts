import age01Data from './age_01.json';
import age02Data from './age_02.json';
import age03Data from './age_03.json';
import age04Data from './age_04.json';
import age05Data from './age_05.json';
import age06Data from './age_06.json';
import age07Data from './age_07.json';
import age08Data from './age_08.json';
import age09Data from './age_09.json';
import age10Data from './age_10.json';
import age11Data from './age_11.json';
import type {
  Age,
  CardAbility,
  CardColor,
  CardDefinition,
  CardIcons,
  CardInstance,
  FunctionalIcon,
} from '../../engine/types';

interface RawAgeCardFile {
  age: number;
  set: 'base';
  cards: Array<{
    id: string;
    rawId: string;
    age: number;
    name: string;
    color: CardColor;
    icons: CardIcons;
    abilities: CardAbility[];
    notes?: string;
  }>;
}

function resolveFeaturedIcon(icons: CardIcons, abilities: CardAbility[]): FunctionalIcon {
  if (abilities.length > 0) {
    return abilities[0].icon;
  }
  const counts = new Map<FunctionalIcon, number>();
  for (const slot of ['tl', 'bl', 'bc', 'br'] as const) {
    const val = icons[slot];
    if (val !== 'hexagon') {
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
  }
  let best: FunctionalIcon = 'tower';
  let bestCount = -1;
  for (const [icon, count] of counts.entries()) {
    if (count > bestCount) {
      best = icon;
      bestCount = count;
    }
  }
  return best;
}

function hydrateAgeFile(file: RawAgeCardFile): CardDefinition[] {
  return file.cards.map((raw) => ({
    id: raw.id,
    rawId: raw.rawId,
    age: raw.age as Age,
    set: file.set,
    name: raw.name,
    color: raw.color,
    icons: { ...raw.icons },
    featuredIcon: resolveFeaturedIcon(raw.icons, raw.abilities),
    abilities: raw.abilities.map((ab) => ({ ...ab })),
    isPlaceholder: false,
  }));
}

const RAW_AGE_FILES: RawAgeCardFile[] = [
  age01Data as RawAgeCardFile,
  age02Data as RawAgeCardFile,
  age03Data as RawAgeCardFile,
  age04Data as RawAgeCardFile,
  age05Data as RawAgeCardFile,
  age06Data as RawAgeCardFile,
  age07Data as RawAgeCardFile,
  age08Data as RawAgeCardFile,
  age09Data as RawAgeCardFile,
  age10Data as RawAgeCardFile,
  age11Data as RawAgeCardFile,
];

export const BASE_CARD_DATABASE: CardDefinition[] = RAW_AGE_FILES.flatMap(hydrateAgeFile).sort(
  (a, b) => a.id.localeCompare(b.id)
);

export const AVAILABLE_DATABASE_AGES: Age[] = Array.from(
  new Set(BASE_CARD_DATABASE.map((c) => c.age))
).sort((a, b) => a - b);

export function instantiateCard(def: CardDefinition, instanceSuffix?: string): CardInstance {
  return {
    instanceId: instanceSuffix ? `${def.id}_${instanceSuffix}` : def.id,
    defId: def.id,
    age: def.age,
    set: def.set,
    name: def.name,
    color: def.color,
    icons: def.icons,
    featuredIcon: def.featuredIcon,
    abilities: def.abilities,
    isPlaceholder: false,
  };
}
