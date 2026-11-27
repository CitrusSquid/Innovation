import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Layers,
} from 'lucide-react';
import { ALL_FUNCTIONAL_ICONS } from '../engine/constants';
import type { CardSizeMode } from '../engine/settings';
import { getExposedSlots } from '../engine/splay';
import type {
  Age,
  CardBack,
  CardInstance,
  ColorStack,
  FunctionalIcon,
  SplayDirection,
} from '../engine/types';
import { COLOR_THEMES, ColorShapeMark, IconGlyph } from './IconGlyph';

const SPLAY_LABELS: Record<SplayDirection, string> = {
  none: 'Unsplayed',
  left: 'Splayed left',
  right: 'Splayed right',
  up: 'Splayed up',
  aslant: 'Splayed askew',
};

const SplayArrowIcon: React.FC<{ direction: SplayDirection; size?: number }> = ({
  direction,
  size = 11,
}) => {
  switch (direction) {
    case 'left':
      return <ArrowLeft style={{ width: size, height: size }} className="shrink-0 text-[#F6C945]" aria-hidden="true" />;
    case 'right':
      return <ArrowRight style={{ width: size, height: size }} className="shrink-0 text-[#F6C945]" aria-hidden="true" />;
    case 'up':
      return <ArrowUp style={{ width: size, height: size }} className="shrink-0 text-[#F6C945]" aria-hidden="true" />;
    case 'aslant':
      return <ArrowUpRight style={{ width: size, height: size }} className="shrink-0 text-[#F6C945]" aria-hidden="true" />;
    default:
      return null;
  }
};

type ExposedIconSummaryItem = {
  icon: FunctionalIcon;
  count: number;
};

const ExposedIconsStrip: React.FC<{
  exposedIconsList: FunctionalIcon[];
  iconSize: number;
}> = ({ exposedIconsList, iconSize }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const indivMeasureRef = useRef<HTMLDivElement | null>(null);
  const summaryMeasureRef = useRef<HTMLDivElement | null>(null);
  const ellipsisMeasureRef = useRef<HTMLSpanElement | null>(null);

  const { individualItems, summaryItems } = useMemo<{
    individualItems: FunctionalIcon[];
    summaryItems: ExposedIconSummaryItem[];
  }>(() => {
    if (exposedIconsList.length === 0) {
      return { individualItems: [], summaryItems: [] };
    }
    const countsByIcon = new Map<FunctionalIcon, number>();
    for (const ic of exposedIconsList) {
      countsByIcon.set(ic, (countsByIcon.get(ic) ?? 0) + 1);
    }
    const sortedEntries = Array.from(countsByIcon.entries()).sort(
      (a, b) =>
        b[1] - a[1] ||
        ALL_FUNCTIONAL_ICONS.indexOf(a[0]) - ALL_FUNCTIONAL_ICONS.indexOf(b[0])
    );
    const flat: FunctionalIcon[] = [];
    for (const [icon, count] of sortedEntries) {
      for (let i = 0; i < count; i++) {
        flat.push(icon);
      }
    }
    return {
      individualItems: flat,
      summaryItems: sortedEntries.map(([icon, count]) => ({ icon, count })),
    };
  }, [exposedIconsList]);

  const [displayState, setDisplayState] = useState<{
    mode: 'individual' | 'summary';
    visibleCount: number;
  }>(() => ({ mode: 'individual', visibleCount: individualItems.length }));

  useLayoutEffect(() => {
    setDisplayState({ mode: 'individual', visibleCount: individualItems.length });
  }, [individualItems]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indivMeasure = indivMeasureRef.current;
    const summaryMeasure = summaryMeasureRef.current;
    if (!container || !indivMeasure || !summaryMeasure || individualItems.length === 0) {
      setDisplayState({ mode: 'individual', visibleCount: individualItems.length });
      return;
    }

    const recalc = () => {
      const avail = container.getBoundingClientRect().width;
      if (avail < 4) return;

      const indivChildren = Array.from(indivMeasure.children) as HTMLElement[];
      if (indivChildren.length > 0) {
        const indivLeft = indivMeasure.getBoundingClientRect().left;
        const indivRight = indivChildren[indivChildren.length - 1].getBoundingClientRect().right;
        if (indivRight - indivLeft <= avail + 0.75) {
          setDisplayState((prev) =>
            prev.mode === 'individual' && prev.visibleCount === individualItems.length
              ? prev
              : { mode: 'individual', visibleCount: individualItems.length }
          );
          return;
        }
      }

      const sumChildren = Array.from(summaryMeasure.children) as HTMLElement[];
      if (sumChildren.length === 0) return;
      const sumLeft = summaryMeasure.getBoundingClientRect().left;
      const sumRight = sumChildren[sumChildren.length - 1].getBoundingClientRect().right;
      if (sumRight - sumLeft <= avail + 0.75) {
        setDisplayState((prev) =>
          prev.mode === 'summary' && prev.visibleCount === summaryItems.length
            ? prev
            : { mode: 'summary', visibleCount: summaryItems.length }
        );
        return;
      }

      const ellipsisWidth = ellipsisMeasureRef.current?.getBoundingClientRect().width ?? 8;
      const maxRight = Math.max(0, avail - ellipsisWidth - 2);
      let fit = 0;
      for (let i = 0; i < sumChildren.length; i++) {
        const childRight = sumChildren[i].getBoundingClientRect().right - sumLeft;
        if (childRight <= maxRight + 0.5) {
          fit = i + 1;
        } else {
          break;
        }
      }

      if (summaryItems.length === 1 && fit === 0 && avail >= iconSize - 2) {
        fit = 1;
      }

      setDisplayState((prev) =>
        prev.mode === 'summary' && prev.visibleCount === fit
          ? prev
          : { mode: 'summary', visibleCount: fit }
      );
    };

    recalc();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(recalc);
      ro.observe(container);
      return () => ro.disconnect();
    }
  }, [individualItems, summaryItems, iconSize]);

  if (individualItems.length === 0) {
    return <div className="flex-1 min-w-0" />;
  }

  const renderSummaryItem = (item: ExposedIconSummaryItem, idx: number) => (
    <span
      key={`${item.icon}_sum_${idx}`}
      className="inline-flex items-center gap-[1px] font-mono-num text-[9.5px] font-semibold text-[#F5EFE2] shrink-0 leading-none"
    >
      <IconGlyph slot={item.icon} size={iconSize} className="shrink-0" />
      {item.count > 1 && <span>{item.count}</span>}
    </span>
  );

  const isTruncated =
    displayState.mode === 'summary' && displayState.visibleCount < summaryItems.length;

  return (
    <div
      ref={containerRef}
      className={`relative flex-1 min-w-0 h-[16px] flex items-center ${
        displayState.mode === 'summary' ? 'gap-[2px]' : 'gap-[1px]'
      } overflow-hidden`}
    >
      {/* Hidden w-max measurers so ResizeObserver gets exact subpixel widths for all 3 tiers */}
      <div
        ref={indivMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 w-max flex items-center gap-[1px] whitespace-nowrap"
      >
        {individualItems.map((icon, idx) => (
          <IconGlyph key={`${icon}_mi_${idx}`} slot={icon} size={iconSize} className="shrink-0" />
        ))}
      </div>
      <div
        ref={summaryMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 w-max flex items-center gap-[2px] whitespace-nowrap"
      >
        {summaryItems.map((item, idx) => renderSummaryItem(item, idx))}
      </div>
      <span
        ref={ellipsisMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 font-mono-num text-[9.5px] leading-none"
      >
        …
      </span>

      {displayState.mode === 'individual'
        ? individualItems
            .slice(0, displayState.visibleCount)
            .map((icon, idx) => (
              <IconGlyph key={`${icon}_i_${idx}`} slot={icon} size={iconSize} className="shrink-0" />
            ))
        : summaryItems
            .slice(0, displayState.visibleCount)
            .map((item, idx) => renderSummaryItem(item, idx))}

      {isTruncated && (
        <span className="font-mono-num text-[9.5px] leading-none text-[#C8B9A6] shrink-0">
          …
        </span>
      )}
    </div>
  );
};

export interface AgeCountItem {
  age: Age;
  count: number;
}

export function groupCountByAge(items: ReadonlyArray<{ age: Age }>): AgeCountItem[] {
  const map = new Map<Age, number>();
  for (const item of items) {
    map.set(item.age, (map.get(item.age) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([age, count]) => ({ age, count }));
}

export function formatAgeCountsCompact(items: ReadonlyArray<{ age: Age }>): string {
  const grouped = groupCountByAge(items);
  if (grouped.length === 0) return 'Empty';
  return grouped.map((g) => `[${g.age}]×${g.count}`).join(' · ');
}

export const AbilityRows: React.FC<{
  abilities: CardInstance['abilities'];
  defId: string;
  color: CardInstance['color'];
  mode?: 'board' | 'hand' | 'full';
  cardSize?: CardSizeMode;
  ultraCompact?: boolean;
}> = ({ abilities, defId, color, mode = 'full', cardSize = 'small', ultraCompact = false }) => {
  if (abilities.length === 0) {
    const isDense = mode !== 'full';
    return (
      <div className="flex flex-col justify-between h-full text-[#6E6053]">
        <span className={isDense ? 'text-[9.5px] leading-tight' : 'text-xs leading-snug'}>
          {isDense ? 'No dogma effect' : 'No dogma effects.'}
        </span>
        {!isDense && (
          <span className="font-mono-num text-[11px] text-[#857668]">
            ID: {defId} · {color}
          </span>
        )}
      </div>
    );
  }

  const isDense = mode !== 'full';
  const count = abilities.length;

  const getLineClampClass = () => {
    if (mode === 'full') return '';
    if (mode === 'hand') {
      if (cardSize === 'large') {
        if (count >= 3) return 'line-clamp-2';
        if (count === 2) return 'line-clamp-4';
        return 'line-clamp-8';
      }
      if (cardSize === 'medium') {
        if (count >= 3) return 'line-clamp-2';
        if (count === 2) return 'line-clamp-3';
        return 'line-clamp-8';
      }
      if (count >= 3) return 'line-clamp-2';
      if (count === 2) return 'line-clamp-3';
      return 'line-clamp-7';
    }
    // mode === 'board'
    if (cardSize === 'large') {
      if (count >= 3) return ultraCompact ? 'line-clamp-1' : 'line-clamp-2';
      if (count === 2) return 'line-clamp-3';
      return 'line-clamp-6';
    }
    if (cardSize === 'medium') {
      if (count >= 3) return ultraCompact ? 'line-clamp-1' : 'line-clamp-2';
      if (count === 2) return ultraCompact ? 'line-clamp-2' : 'line-clamp-3';
      return 'line-clamp-6';
    }
    if (count >= 3) return 'line-clamp-1';
    if (count === 2) return 'line-clamp-2';
    return 'line-clamp-5';
  };

  const denseTextClass =
    cardSize === 'large'
      ? 'px-1.5 py-0.5 gap-1.5 text-[10.5px] leading-[1.22]'
      : cardSize === 'medium'
      ? 'px-1 py-0.5 gap-1 text-[9.8px] leading-[1.2]'
      : 'px-1 py-0.5 gap-1 text-[9px] sm:text-[9.5px] leading-[1.18]';

  const denseGlyphSize = cardSize === 'large' ? 12 : cardSize === 'medium' ? 11 : 10;
  const clampClass = getLineClampClass();

  return (
    <div className={isDense ? 'space-y-0.5' : 'space-y-2'}>
      {abilities.map((ab) => {
        const demandBody = ab.text.replace(/^I DEMAND\s*/i, '');
        return (
          <div
            key={ab.index}
            className={`rounded flex items-start overflow-hidden ${
              isDense ? denseTextClass : 'px-2.5 py-2 gap-2 text-[12.5px] leading-[1.35]'
            } ${
              ab.isDemand
                ? 'bg-[#2B221D] text-[#F5EFE2]'
                : 'bg-[#E9DFC9] text-[#1F1A17] border border-[#1F1A17]/10'
            }`}
          >
            <IconGlyph
              slot={ab.icon}
              size={isDense ? denseGlyphSize : 15}
              className="shrink-0 mt-[1px]"
            />
            <span className={`min-w-0 flex-1 ${clampClass}`}>
              {ab.isDemand ? (
                <>
                  <strong className="font-bold tracking-wide text-[#F6C945] mr-1">
                    I DEMAND
                  </strong>
                  <span>{demandBody}</span>
                </>
              ) : (
                <span>{ab.text}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export const CardTile: React.FC<{
  card: CardInstance;
  compact?: boolean;
  handCompact?: boolean;
  hideHexagonInHandCompact?: boolean;
  selected?: boolean;
  selectable?: boolean;
  disabled?: boolean;
  actionLabel?: string;
  confirmOverlay?: boolean;
  colorBlindMode?: boolean;
  cardSize?: CardSizeMode;
  onClick?: (e?: React.MouseEvent) => void;
  onAction?: () => void;
  onConfirmAction?: (e: React.MouseEvent) => void;
}> = ({
  card,
  compact = false,
  handCompact = false,
  hideHexagonInHandCompact = false,
  selected = false,
  selectable = false,
  disabled = false,
  actionLabel,
  confirmOverlay = false,
  colorBlindMode = false,
  cardSize = 'small',
  onClick,
  onAction,
  onConfirmAction,
}) => {
  const theme = COLOR_THEMES[card.color];

  if (compact) {
    const isNarrowMobileCompactHand = handCompact && hideHexagonInHandCompact;
    const widthClass = isNarrowMobileCompactHand
      ? 'w-[110px]'
      : handCompact
      ? 'w-[140px] sm:w-[152px]'
      : cardSize === 'large'
      ? 'w-[178px] sm:w-[196px]'
      : cardSize === 'medium'
      ? 'w-[162px] sm:w-[176px]'
      : 'w-[146px] sm:w-[158px]';
    const bodyHeightClass =
      cardSize === 'large'
        ? 'h-[126px] sm:h-[136px]'
        : cardSize === 'medium'
        ? 'h-[112px] sm:h-[120px]'
        : 'h-[100px] sm:h-[108px]';
    const iconSize = handCompact
      ? 16
      : cardSize === 'large'
      ? 19
      : cardSize === 'medium'
      ? 17
      : 16;

    return (
      <div className={`flex flex-col shrink-0 ${widthClass}`}>
        <div className="relative flex flex-col">
          <button
            type="button"
            onClick={onClick}
            disabled={disabled && !onClick}
            className={`group relative flex flex-col rounded-lg border overflow-hidden text-left transition-all duration-150 select-none cursor-pointer focus-visible:outline-2 focus-visible:outline-[#F6C945] ${
              selected || confirmOverlay
                ? 'ring-2 ring-[#F6C945] border-[#F6C945]'
                : selectable
                ? 'border-[#1F1A17]/75 hover:border-[#F6C945] hover:ring-2 hover:ring-[#F6C945]/60 hover:shadow-[0_0_12px_rgba(246,201,69,0.28)]'
                : 'border-[#1F1A17]/75 hover:border-[#F6C945]/80'
            }`}
            style={{
              backgroundColor: theme.soft,
              color: '#1F1A17',
            }}
            aria-label={
              selectable
                ? `Meld ${card.name}, Age ${card.age} ${card.color}`
                : `Inspect ${card.name}, Age ${card.age} ${card.color}`
            }
          >
            {selectable && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-[5] bg-[#F6C945]/0 group-hover:bg-[#F6C945]/14 transition-colors duration-150"
              />
            )}
            {/* Compact Header: Name + Age */}
            <div
              className={`w-full ${
                isNarrowMobileCompactHand ? 'px-1.5 gap-1' : 'px-2 gap-1.5'
              } py-1 flex items-center justify-between`}
              style={{ backgroundColor: theme.header, color: theme.text }}
            >
              <div className="flex items-center gap-1 min-w-0">
                {colorBlindMode && <ColorShapeMark color={card.color} size={10} />}
                <span
                  className={`font-display font-bold tracking-tight truncate ${
                    cardSize === 'large' && !handCompact ? 'text-[13px]' : 'text-[11px] sm:text-xs'
                  }`}
                >
                  {card.name}
                </span>
              </div>
              <span className="font-mono-num text-[10px] font-semibold px-1 py-0.5 rounded bg-black/30 shrink-0 leading-none">
                {card.age}
              </span>
            </div>

            {handCompact ? (
              isNarrowMobileCompactHand ? (
                <div className="px-1.5 py-1.5 flex items-center justify-evenly gap-1 bg-[#F5EFE2]/75">
                  {([card.icons.tl, card.icons.bl, card.icons.bc, card.icons.br] as const)
                    .filter((slot) => slot !== 'hexagon')
                    .map((slot, idx) => (
                      <IconGlyph key={`${slot}_${idx}`} slot={slot} size={iconSize} />
                    ))}
                </div>
              ) : (
                <div className="px-2 py-2 flex items-center justify-between gap-1 bg-[#F5EFE2]/75">
                  <IconGlyph slot={card.icons.tl} size={iconSize} />
                  <IconGlyph slot={card.icons.bl} size={iconSize} />
                  <IconGlyph slot={card.icons.bc} size={iconSize} />
                  <IconGlyph slot={card.icons.br} size={iconSize} />
                </div>
              )
            ) : (
              <>
                {/* L-Shaped Body: Left pale TL column + Fixed-height Parchment Effects Box */}
                <div className="flex min-h-0">
                  <div className="w-6 sm:w-7 shrink-0 flex flex-col items-center pt-1.5 px-0.5">
                    <IconGlyph slot={card.icons.tl} size={iconSize} />
                  </div>
                  <div
                    className={`flex-1 min-w-0 bg-[#F5EFE2] rounded-bl-md border-l border-b border-[#1F1A17]/15 p-1 ${bodyHeightClass} overflow-hidden flex flex-col justify-start`}
                  >
                    <AbilityRows
                      abilities={card.abilities}
                      defId={card.defId}
                      color={card.color}
                      mode="hand"
                      cardSize={cardSize}
                    />
                  </div>
                </div>

                {/* Bottom 3 Icon Slots (BL, BC, BR) */}
                <div className="flex items-center justify-between px-2 py-1">
                  <IconGlyph slot={card.icons.bl} size={iconSize} />
                  <IconGlyph slot={card.icons.bc} size={iconSize} />
                  <IconGlyph slot={card.icons.br} size={iconSize} />
                </div>
              </>
            )}
          </button>

          {confirmOverlay && onConfirmAction && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/55 backdrop-blur-[1px] p-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onConfirmAction(e);
                }}
                className="min-h-[38px] px-3.5 rounded-md bg-[#C88A1E] border border-[#1C1714] text-[#1C1714] text-xs font-bold shadow-lg hover:bg-[#d89928] cursor-pointer"
              >
                Confirm
              </button>
            </div>
          )}
        </div>

        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className="mt-1.5 w-full min-h-[38px] rounded-md px-2 py-1 text-xs font-semibold text-[#1C1714] bg-[#C88A1E] hover:bg-[#d89928] disabled:opacity-40 transition-colors cursor-pointer"
          >
            {actionLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col rounded-xl border border-[#1F1A17]/80 overflow-hidden w-full max-w-[344px] sm:max-w-[368px] select-none shadow-lg"
      style={{
        backgroundColor: theme.soft,
        color: '#1F1A17',
      }}
    >
      {/* Expanded Header strip */}
      <div
        className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-2"
        style={{ backgroundColor: theme.header, color: theme.text }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ColorShapeMark color={card.color} size={14} />
          <span className="font-display font-bold text-base tracking-tight truncate">
            {card.name}
          </span>
        </div>
        <span className="font-mono-num text-xs font-semibold px-2 py-0.5 rounded bg-black/30 shrink-0">
          {card.age}
        </span>
      </div>

      {/* L-Shaped Body: Left pale TL column + Generous Parchment Effects Box */}
      <div className="flex flex-1 min-h-0">
        <div className="w-11 sm:w-12 shrink-0 flex flex-col items-center pt-3 px-1">
          <IconGlyph slot={card.icons.tl} size={26} />
        </div>
        <div className="flex-1 min-w-0 bg-[#F5EFE2] rounded-bl-lg border-l border-b border-[#1F1A17]/15 p-3 min-h-[220px] flex flex-col justify-start gap-2">
          <AbilityRows
            abilities={card.abilities}
            defId={card.defId}
            color={card.color}
            mode="full"
          />
        </div>
      </div>

      {/* Bottom 3 Icon Slots (BL, BC, BR) */}
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <IconGlyph slot={card.icons.bl} size={26} />
        <IconGlyph slot={card.icons.bc} size={26} />
        <IconGlyph slot={card.icons.br} size={26} />
      </div>
    </div>
  );
};

export const ColorStackView: React.FC<{
  stack: ColorStack;
  canDogma?: boolean;
  dogmaSelectMode?: boolean;
  ultraCompact?: boolean;
  boardCompact?: boolean;
  confirmOverlay?: boolean;
  colorBlindMode?: boolean;
  cardSize?: CardSizeMode;
  highlightBorder?: boolean;
  onInspectStack: (stack: ColorStack) => void;
  onDogma?: () => void;
  onDogmaHoverChange?: (hovering: boolean) => void;
  onConfirmAction?: (e: React.MouseEvent) => void;
}> = ({
  stack,
  canDogma = false,
  dogmaSelectMode = false,
  ultraCompact = false,
  boardCompact = false,
  confirmOverlay = false,
  colorBlindMode = false,
  cardSize = 'small',
  highlightBorder = false,
  onInspectStack,
  onDogma,
  onDogmaHoverChange,
  onConfirmAction,
}) => {
  const theme = COLOR_THEMES[stack.color];
  const topCard = stack.cards.length > 0 ? stack.cards[stack.cards.length - 1] : null;
  const coveredCards = stack.cards.slice(0, -1);
  const exposedSlots = getExposedSlots(stack.splay);
  const isDogmaTargetable = dogmaSelectMode && canDogma;

  const handleCardPress = (e: React.MouseEvent) => {
    if (isDogmaTargetable && onDogma) {
      e.stopPropagation();
      onDogma();
      return;
    }
    onInspectStack(stack);
  };

  // Build exposed icon glyphs (in boardCompact mode, always include topCard's functional icons
  // so unsplayed stacks show all card icons and splayed stacks show splayed + top card icons)
  const exposedIconsList: FunctionalIcon[] = [];
  if (coveredCards.length > 0 && exposedSlots.length > 0) {
    for (const c of coveredCards) {
      for (const slot of exposedSlots) {
        const ic = c.icons[slot];
        if (ic !== 'hexagon') {
          exposedIconsList.push(ic);
        }
      }
    }
  }
  if (boardCompact && topCard) {
    for (const slot of ['tl', 'bl', 'bc', 'br'] as const) {
      const ic = topCard.icons[slot];
      if (ic !== 'hexagon') {
        exposedIconsList.push(ic);
      }
    }
  }

  if (boardCompact) {
    if (!topCard) {
      return (
        <div
          className="h-[56px] flex items-center justify-center rounded-lg border border-dashed border-[#D9C7A3]/15 bg-[#1C1714]/45 px-1.5 text-center"
          title={`Empty ${stack.color} stack`}
        >
          {colorBlindMode ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#8D7F70] capitalize">
              <ColorShapeMark color={stack.color} size={10} />
              <span>{stack.color}</span>
            </span>
          ) : (
            <span className="text-[10px] font-medium text-[#8D7F70] capitalize truncate">
              {stack.color}
            </span>
          )}
        </div>
      );
    }

    const firstAbility = topCard.abilities[0] ?? null;
    const firstDemandBody = firstAbility
      ? firstAbility.text.replace(/^I DEMAND\s*/i, '')
      : '';

    return (
      <div
        onMouseEnter={() => {
          if (isDogmaTargetable) onDogmaHoverChange?.(true);
        }}
        onMouseLeave={() => {
          if (isDogmaTargetable) onDogmaHoverChange?.(false);
        }}
        className={`relative h-[56px] flex flex-col justify-between rounded-lg border p-0.5 transition-all ${
          confirmOverlay
            ? 'border-[#F6C945] ring-2 ring-[#F6C945] bg-[#2A2117]'
            : highlightBorder
            ? 'border-[#E5B842]/55 bg-[#231C18]'
            : isDogmaTargetable
            ? 'border-[#D9C7A3]/30 bg-[#231C18] hover:border-[#F6C945]/80'
            : 'border-[#D9C7A3]/20 bg-[#231C18]'
        }`}
      >
        <button
          type="button"
          onClick={handleCardPress}
          style={{ backgroundColor: theme.soft, color: '#1F1A17' }}
          className="group relative w-full text-left rounded-[5px] overflow-hidden border border-[#1F1A17] cursor-pointer hover:brightness-105 transition focus-visible:outline-2 focus-visible:outline-[#F6C945] flex flex-col shrink-0"
          aria-label={
            isDogmaTargetable
              ? `Activate Dogma on ${topCard.name}`
              : `Inspect ${stack.color} stack: ${topCard.name} (${topCard.age}), ${stack.cards.length} cards`
          }
          title={`${topCard.name} (${topCard.age}) · ${stack.cards.length} cards · ${
            coveredCards.length > 0 ? SPLAY_LABELS[stack.splay] : 'Unsplayed'
          }`}
        >
          <div
            className="px-1.5 py-0.5 flex items-center justify-between gap-1"
            style={{ backgroundColor: theme.header, color: theme.text }}
          >
            <div className="flex items-center gap-1 min-w-0">
              {colorBlindMode && <ColorShapeMark color={stack.color} size={8} />}
              <span className="font-display font-bold text-[10.5px] leading-tight truncate">
                {topCard.name}
              </span>
            </div>
            <span className="font-mono-num text-[10px] font-semibold px-1 py-0.5 rounded bg-black/30 shrink-0 leading-none">
              {topCard.age}
            </span>
          </div>

          <div
            className={`pl-[3px] pr-1 py-[1.5px] text-[9.5px] leading-tight flex items-center gap-[3px] min-w-0 ${
              firstAbility?.isDemand
                ? 'bg-[#2B221D] text-[#F5EFE2]'
                : 'bg-[#F5EFE2] text-[#1F1A17]'
            }`}
          >
            {firstAbility ? (
              <>
                <IconGlyph slot={firstAbility.icon} size={11} className="shrink-0" />
                <span className="truncate min-w-0">
                  {firstAbility.isDemand ? (
                    <>
                      <strong className="font-bold text-[#F6C945] mr-[3px]">I DEMAND</strong>
                      <span>{firstDemandBody}</span>
                    </>
                  ) : (
                    <span>{firstAbility.text}</span>
                  )}
                </span>
              </>
            ) : (
              <span className="text-[#6E6053] truncate">No dogma effect</span>
            )}
          </div>
        </button>

        <div
          className="h-[16px] flex items-center justify-between gap-0.5 px-0.5 leading-none shrink-0"
          title={coveredCards.length > 0 ? SPLAY_LABELS[stack.splay] : 'Unsplayed'}
        >
          <div className="flex items-center gap-0.5 flex-1 min-w-0">
            {coveredCards.length > 0 && stack.splay !== 'none' && (
              <SplayArrowIcon direction={stack.splay} size={11} />
            )}
            <ExposedIconsStrip exposedIconsList={exposedIconsList} iconSize={12} />
          </div>
          <span
            className="inline-flex items-center gap-[1px] font-mono-num text-[9px] text-[#B8A996] shrink-0"
            title={`${stack.cards.length} card${stack.cards.length === 1 ? '' : 's'} in stack`}
          >
            <Layers className="w-2.5 h-2.5" />
            {stack.cards.length}
          </span>
        </div>

        {confirmOverlay && onConfirmAction && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/55 backdrop-blur-[1px] p-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onConfirmAction(e);
              }}
              className="min-h-[32px] px-3 rounded-md bg-[#C88A1E] border border-[#1C1714] text-[#1C1714] text-xs font-bold shadow-lg hover:bg-[#d89928] cursor-pointer"
            >
              Confirm
            </button>
          </div>
        )}
      </div>
    );
  }

  const stackFixedHeightClass =
    cardSize === 'large'
      ? ultraCompact
        ? 'h-[172px] sm:h-[182px]'
        : 'h-[190px] sm:h-[200px]'
      : cardSize === 'medium'
      ? ultraCompact
        ? 'h-[156px] sm:h-[166px]'
        : 'h-[172px] sm:h-[182px]'
      : ultraCompact
      ? 'h-[142px] sm:h-[148px]'
      : 'h-[150px] sm:h-[160px]';

  const boardBodyHeightClass =
    cardSize === 'large'
      ? ultraCompact
        ? 'h-[100px] sm:h-[108px]'
        : 'h-[114px] sm:h-[122px]'
      : cardSize === 'medium'
      ? ultraCompact
        ? 'h-[86px] sm:h-[94px]'
        : 'h-[98px] sm:h-[106px]'
      : ultraCompact
      ? 'h-[72px] sm:h-[78px]'
      : 'h-[78px] sm:h-[84px]';

  const iconSize =
    cardSize === 'large'
      ? ultraCompact
        ? 14
        : 17
      : cardSize === 'medium'
      ? ultraCompact
        ? 13
        : 16
      : ultraCompact
      ? 12
      : 15;

  if (!topCard) {
    return (
      <div
        className={`${stackFixedHeightClass} flex flex-col items-center justify-center rounded-lg border border-dashed border-[#D9C7A3]/15 bg-[#1C1714]/45 px-1.5 py-1.5 text-center`}
      >
        {colorBlindMode && <ColorShapeMark color={stack.color} size={11} />}
        <span
          className={`${colorBlindMode ? 'mt-1' : ''} text-[10.5px] font-medium text-[#9E8F7E] capitalize`}
        >
          {stack.color}
        </span>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => {
        if (isDogmaTargetable) onDogmaHoverChange?.(true);
      }}
      onMouseLeave={() => {
        if (isDogmaTargetable) onDogmaHoverChange?.(false);
      }}
      className={`relative ${stackFixedHeightClass} flex flex-col rounded-lg border ${
        ultraCompact ? 'p-0.5' : 'p-1'
      } transition-all ${
        confirmOverlay
          ? 'border-[#F6C945] ring-2 ring-[#F6C945] bg-[#2A2117]'
          : highlightBorder
          ? 'border-[#E5B842]/55 bg-[#231C18]'
          : isDogmaTargetable
          ? 'border-[#D9C7A3]/30 bg-[#231C18] hover:border-[#F6C945]/80'
          : 'border-[#D9C7A3]/20 bg-[#231C18]'
      }`}
    >
      {/* Top Card */}
      <button
        type="button"
        onClick={handleCardPress}
        className="group relative w-full text-left rounded-md overflow-hidden border border-[#1F1A17] cursor-pointer hover:brightness-105 transition focus-visible:outline-2 focus-visible:outline-[#F6C945] flex flex-col shrink-0"
        style={{ backgroundColor: theme.soft, color: '#1F1A17' }}
        aria-label={
          isDogmaTargetable
            ? `Activate Dogma on ${topCard.name}`
            : `Inspect ${stack.color} stack (${stack.cards.length} cards, ${SPLAY_LABELS[stack.splay]})`
        }
      >
        <div
          className="px-1.5 py-0.5 flex items-center justify-between gap-1"
          style={{ backgroundColor: theme.header, color: '#FFFFFF' }}
        >
          <div className="flex items-center gap-1 min-w-0">
            {colorBlindMode && <ColorShapeMark color={stack.color} size={9} />}
            <span
              className={`font-display font-bold truncate ${
                cardSize === 'large'
                  ? 'text-[12px]'
                  : cardSize === 'medium'
                  ? 'text-[11px] sm:text-[11.5px]'
                  : 'text-[10.5px] sm:text-[11px]'
              }`}
            >
              {topCard.name}
            </span>
          </div>
          <span className="font-mono-num text-[10px] font-semibold bg-black/30 px-1 rounded shrink-0">
            {topCard.age}
          </span>
        </div>

        <div className="flex min-h-0">
          <div
            className={`${
              ultraCompact ? 'w-4' : 'w-5 sm:w-6'
            } shrink-0 flex flex-col items-center pt-1 px-0.5`}
          >
            <IconGlyph slot={topCard.icons.tl} size={iconSize} />
          </div>
          <div
            className={`flex-1 min-w-0 bg-[#F5EFE2] rounded-bl-[4px] border-l border-b border-[#1F1A17]/15 p-1 overflow-hidden ${boardBodyHeightClass}`}
          >
            <AbilityRows
              abilities={topCard.abilities}
              defId={topCard.defId}
              color={topCard.color}
              mode="board"
              cardSize={cardSize}
              ultraCompact={ultraCompact}
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-1.5 py-0.5">
          <IconGlyph slot={topCard.icons.bl} size={iconSize} />
          <IconGlyph slot={topCard.icons.bc} size={iconSize} />
          <IconGlyph slot={topCard.icons.br} size={iconSize} />
        </div>
      </button>

      {/* Single-line Splay Arrow + Sorted Exposed Icons + Stack Depth Box */}
      <div
        className="mt-auto h-[20px] px-0.5 rounded bg-[#1C1714]/85 border border-[#D9C7A3]/10 flex items-center justify-between gap-0.5 overflow-hidden shrink-0"
        title={coveredCards.length > 0 ? SPLAY_LABELS[stack.splay] : 'Unsplayed'}
      >
        <div className="flex items-center gap-0.5 flex-1 min-w-0">
          {coveredCards.length > 0 && stack.splay !== 'none' && (
            <SplayArrowIcon direction={stack.splay} size={ultraCompact ? 11 : 12} />
          )}
          <ExposedIconsStrip
            exposedIconsList={exposedIconsList}
            iconSize={ultraCompact ? 12 : 13}
          />
        </div>
        <span
          className="inline-flex items-center gap-[1px] font-mono-num text-[9px] text-[#B8A996] shrink-0"
          title={`${stack.cards.length} card${stack.cards.length === 1 ? '' : 's'} in stack`}
        >
          <Layers className="w-2.5 h-2.5" />
          {stack.cards.length}
        </span>
      </div>

      {confirmOverlay && onConfirmAction && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/55 backdrop-blur-[1px] p-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onConfirmAction(e);
            }}
            className="min-h-[38px] px-3.5 rounded-md bg-[#C88A1E] border border-[#1C1714] text-[#1C1714] text-xs font-bold shadow-lg hover:bg-[#d89928] cursor-pointer"
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
};

export const CardBackChip: React.FC<{ back: CardBack; label?: string }> = ({ back, label }) => (
  <div
    className="inline-flex items-center gap-1.5 rounded border border-[#D9C7A3]/30 bg-[#2E251F] px-2 py-1 text-xs text-[#F5EFE2]"
    title={`Age ${back.age} (${back.set})`}
  >
    <span className="font-mono-num font-bold text-[#F6C945]">{back.age}</span>
    {label && <span className="text-[11px] text-[#C8B9A6]">{label}</span>}
  </div>
);
