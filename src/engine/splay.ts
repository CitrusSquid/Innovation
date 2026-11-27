import {
  ALL_COLORS,
  ALL_FUNCTIONAL_ICONS,
} from './constants';
import type {
  CardColor,
  CardInstance,
  ColorStack,
  FunctionalIcon,
  PlayerBoard,
  SlotPosition,
  SplayDirection,
} from './types';

/**
 * Per Innovation 4th Edition rulebook (p. 24-25):
 * - unsplayed: 0 covered slots exposed
 * - left: 1 slot exposed (BR)
 * - right: 2 slots exposed (TL, BL)
 * - up: 3 slots exposed (BL, BC, BR)
 * - aslant: 4 slots exposed (TL, BL, BC, BR)
 */
export function getExposedSlots(splay: SplayDirection): readonly SlotPosition[] {
  switch (splay) {
    case 'none':
      return [];
    case 'left':
      return ['br'];
    case 'right':
      return ['tl', 'bl'];
    case 'up':
      return ['bl', 'bc', 'br'];
    case 'aslant':
      return ['tl', 'bl', 'bc', 'br'];
  }
}

export function normalizeStackSplay(stack: ColorStack): ColorStack {
  if (stack.cards.length <= 1 && stack.splay !== 'none') {
    return { ...stack, splay: 'none' };
  }
  return stack;
}

export function canSplayStack(stack: ColorStack, direction: SplayDirection): boolean {
  if (direction === 'none') return false;
  if (stack.cards.length < 2) return false;
  if (stack.splay === direction) return false;
  return true;
}

export function getTopCard(stack: ColorStack): CardInstance | null {
  if (stack.cards.length === 0) return null;
  return stack.cards[stack.cards.length - 1];
}

export function getBottomCard(stack: ColorStack): CardInstance | null {
  if (stack.cards.length === 0) return null;
  return stack.cards[0];
}

export function getTopCards(board: PlayerBoard): CardInstance[] {
  const result: CardInstance[] = [];
  for (const color of ALL_COLORS) {
    const top = getTopCard(board[color]);
    if (top) result.push(top);
  }
  return result;
}

/**
 * Per confirmed rule: if player has no top cards on board, returns 0.
 */
export function getHighestTopCardAge(board: PlayerBoard): number {
  let highest = 0;
  for (const color of ALL_COLORS) {
    const top = getTopCard(board[color]);
    if (top && top.age > highest) {
      highest = top.age;
    }
  }
  return highest;
}

export function getStackVisibleIcons(stack: ColorStack): Record<FunctionalIcon, number> {
  const counts = createEmptyIconCounts();
  if (stack.cards.length === 0) return counts;

  // Top card always exposes all 4 slots
  const topIndex = stack.cards.length - 1;
  const topCard = stack.cards[topIndex];
  const allSlots: SlotPosition[] = ['tl', 'bl', 'bc', 'br'];
  for (const slot of allSlots) {
    const icon = topCard.icons[slot];
    if (icon !== 'hexagon') {
      counts[icon] += 1;
    }
  }

  // Covered cards expose slots determined by splay direction
  const exposed = getExposedSlots(stack.splay);
  if (exposed.length > 0) {
    for (let i = 0; i < topIndex; i++) {
      const card = stack.cards[i];
      for (const slot of exposed) {
        const icon = card.icons[slot];
        if (icon !== 'hexagon') {
          counts[icon] += 1;
        }
      }
    }
  }

  return counts;
}

export function getVisibleIconCounts(board: PlayerBoard): Record<FunctionalIcon, number> {
  const totals = createEmptyIconCounts();
  for (const color of ALL_COLORS) {
    const stackCounts = getStackVisibleIcons(board[color]);
    for (const icon of ALL_FUNCTIONAL_ICONS) {
      totals[icon] += stackCounts[icon];
    }
  }
  return totals;
}

export function createEmptyIconCounts(): Record<FunctionalIcon, number> {
  return {
    tower: 0,
    coin: 0,
    leaf: 0,
    lightbulb: 0,
    factory: 0,
    clock: 0,
    persona: 0,
  };
}

export function countDemandTopCards(board: PlayerBoard): number {
  let count = 0;
  for (const card of getTopCards(board)) {
    if (card.abilities.some((ab) => ab.isDemand)) {
      count += 1;
    }
  }
  return count;
}

export function countWonderEligibleColors(board: PlayerBoard): number {
  let count = 0;
  for (const color of ALL_COLORS) {
    const splay = board[color].splay;
    if (splay === 'right' || splay === 'up' || splay === 'aslant') {
      count += 1;
    }
  }
  return count;
}

export function createEmptyBoard(): PlayerBoard {
  return {
    red: { color: 'red', cards: [], splay: 'none' },
    yellow: { color: 'yellow', cards: [], splay: 'none' },
    green: { color: 'green', cards: [], splay: 'none' },
    blue: { color: 'blue', cards: [], splay: 'none' },
    purple: { color: 'purple', cards: [], splay: 'none' },
  };
}

export function cardHasIcon(card: CardInstance, icon: FunctionalIcon): boolean {
  return (
    card.icons.tl === icon ||
    card.icons.bl === icon ||
    card.icons.bc === icon ||
    card.icons.br === icon
  );
}

export function getColorsPresentOnBoard(board: PlayerBoard): CardColor[] {
  return ALL_COLORS.filter((c) => board[c].cards.length > 0);
}
