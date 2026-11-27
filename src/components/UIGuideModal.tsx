import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Eye,
  Monitor,
  Settings,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { ALL_COLORS, ALL_FUNCTIONAL_ICONS } from '../engine/constants';
import { getVisibleIconCounts } from '../engine/splay';
import type {
  CardColor,
  CardInstance,
  ColorStack,
  FunctionalIcon,
  PlayerBoard,
} from '../engine/types';
import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { CardTile, ColorStackView } from './CardView';
import { IconGlyph } from './IconGlyph';

interface UIGuideModalProps {
  onClose: () => void;
}

interface UIGuideLegendItem {
  id: number;
  title: string;
  summary: string;
}

const DESKTOP_LEGEND: UIGuideLegendItem[] = [
  {
    id: 1,
    title: 'Settings and Debug Unlock',
    summary:
      'Opens gameplay, display, saves, and offline export options. Hold down the Settings button for 5 seconds (here or on the Title Screen) to unlock or hide Debug Tools.',
  },
  {
    id: 2,
    title: 'Icon Tally and Comparison',
    summary:
      'Gold numbers highlight the sole leader for each icon (amber when tied). Hovering over a card with Dogma selected (or holding a finger over an icon on touch) highlights icons where colouring shows comparison to the player: Blue - Higher, Yellow - Tied, Red - Lower.',
  },
  {
    id: 3,
    title: 'Score, Achievements, and Hand',
    summary:
      'Click Score, Ach, or H on a player panel to view score pile age counts, claimed achievements, and hidden hand age counts.',
  },
  {
    id: 4,
    title: 'Board Stacks',
    summary:
      'Displays top cards, splay arrows, exposed covered icons, and stack size. Click any stack to inspect all cards in the stack.',
  },
  {
    id: 5,
    title: 'Hand and Controls',
    summary:
      'Displays cards in your hand. Use Compact/Expand, Sort (Newest vs Age, Colour, and Name), and the scroll arrows. Click a card to inspect it, or click a card while Meld is active to play it.',
  },
  {
    id: 6,
    title: 'Action Bar',
    summary:
      'Displays remaining actions and turn actions: Draw, Meld, Dogma, Achieve, and End Turn (or Pause/Play in Auto AI matches).',
  },
  {
    id: 7,
    title: 'Decks, Junk, and Achievements',
    summary:
      'Displays remaining cards in Ages 1–11 (gold highlight marks the next Draw age), the Junk pile button, available Standard Achievements (1–10), and Special Achievements (0–5).',
  },
  {
    id: 8,
    title: 'Chronicle Log and Order Toggle',
    summary:
      'Scrollable match history grouped by turn. Click the up/down arrow in the top-right corner of the Chronicle header to switch between Newest on top and Newest on bottom.',
  },
];

const MOBILE_LEGEND: UIGuideLegendItem[] = [
  ...DESKTOP_LEGEND.slice(0, 6),
  {
    id: 7,
    title: 'Decks and Achievements View',
    summary:
      'Tap Decks in the 6th board slot (or swipe right in Compact mode) to view Age 1–11 deck counts, Junk, Standard Achievements, and Special Achievements.',
  },
  {
    id: 8,
    title: 'Chronicle Log and Order Toggle',
    summary:
      'Tap Log in the 6th board slot (or swipe left in Compact mode) to read match history. The up/down arrow at the top-right switches between Newest on top and Newest on bottom.',
  },
  {
    id: 9,
    title: 'Mobile View Switcher',
    summary:
      'Cycles between Compact (3-pane swipeable board, decks, and log), Swipe (full-size board with a Rivals tab), and Vertical (stacked full boards).',
  },
];

const STANDARD_DECK_COUNTS: Array<[number, number]> = [
  [1, 6],
  [2, 5],
  [3, 9],
  [4, 9],
  [5, 9],
  [6, 9],
  [7, 9],
  [8, 9],
  [9, 9],
  [10, 9],
  [11, 10],
];

const noopInspect = (_stack: ColorStack) => {};

function buildSampleCard(cardId: string, suffix: string): CardInstance {
  const def = BASE_CARD_DATABASE.find((entry) => entry.id === cardId);
  if (!def) {
    throw new Error(`Missing card definition ${cardId} for UI Guide`);
  }
  return instantiateCard(def, suffix);
}

interface CalloutBadgeProps {
  id: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  className?: string;
}

const CalloutBadge: React.FC<CalloutBadgeProps> = ({
  id,
  selectedId,
  onSelect,
  className = '',
}) => {
  const isActive = selectedId === id;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onMouseEnter={() => onSelect(id)}
      aria-label={`Guide marker ${id}`}
      className={`pointer-events-auto z-30 w-6 h-6 rounded-full font-mono-num text-[11px] font-bold flex items-center justify-center transition-all cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.85)] border ${
        isActive
          ? 'bg-[#F6C945] text-[#18120B] border-white scale-110 ring-2 ring-[#F6C945]/60'
          : 'bg-[#18120B]/95 text-[#F6C945] border-[#F6C945] hover:bg-[#F6C945] hover:text-[#18120B]'
      } ${className}`}
    >
      {id}
    </button>
  );
};

interface GuideIconStripProps {
  counts: Record<FunctionalIcon, number>;
  leaderCounts: Record<FunctionalIcon, { max: number; tied: boolean }>;
  comparisonIcon: FunctionalIcon;
  comparisonOutcome: 'higher' | 'tied' | 'lower';
  size: number;
  compact?: boolean;
}

const GuideIconStrip: React.FC<GuideIconStripProps> = ({
  counts,
  leaderCounts,
  comparisonIcon,
  comparisonOutcome,
  size,
  compact = false,
}) => (
  <div className={`flex items-center ${compact ? 'gap-1.5' : 'gap-2'} min-w-0`}>
    {ALL_FUNCTIONAL_ICONS.map((icon) => {
      const value = counts[icon];
      const leader = leaderCounts[icon];
      const isSoleLeader = leader.max > 0 && value === leader.max && !leader.tied;
      const isTiedLeader = leader.max > 0 && value === leader.max && leader.tied;
      const isCompared = icon === comparisonIcon;

      let pillClass = '';
      if (isCompared) {
        if (comparisonOutcome === 'higher') {
          pillClass = 'border border-sky-400 bg-sky-500/25 text-sky-200';
        } else if (comparisonOutcome === 'tied') {
          pillClass = 'border border-[#F6C945] bg-[#F6C945]/25 text-[#F6C945]';
        } else {
          pillClass = 'border border-rose-400 bg-rose-500/25 text-rose-200';
        }
      }

      const numClass = isCompared
        ? ''
        : isSoleLeader
        ? 'text-[#F6C945] font-bold'
        : isTiedLeader
        ? 'text-amber-300 font-semibold'
        : value > 0
        ? 'text-[#E5DAC5]/90'
        : 'text-[#8C7B68]';

      return (
        <span
          key={icon}
          className={`inline-flex items-center ${compact ? 'gap-0.5 text-[10.5px]' : 'gap-1 text-[11px]'} font-mono-num rounded ${
            isCompared ? 'px-1 py-0.5' : ''
          } ${pillClass}`}
        >
          <IconGlyph slot={icon} size={size} />
          <span className={numClass}>{value}</span>
        </span>
      );
    })}
  </div>
);

interface ScaledPreviewFrameProps {
  designWidth: number;
  fitHeight?: boolean;
  children: React.ReactNode;
}

const ScaledPreviewFrame: React.FC<ScaledPreviewFrameProps> = ({
  designWidth,
  fitHeight = false,
  children,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState<number>(designWidth);
  const [hostHeight, setHostHeight] = useState<number>(0);
  const [contentHeight, setContentHeight] = useState<number>(0);

  useEffect(() => {
    const hostEl = hostRef.current;
    const contentEl = contentRef.current;
    const scrollParent = hostEl?.parentElement ?? null;
    if (!hostEl || !contentEl) return;

    const updateSizes = () => {
      const nextHostW = hostEl.clientWidth;
      const nextContentH = contentEl.scrollHeight;
      if (nextHostW > 0) setHostWidth(nextHostW);
      if (nextContentH > 0) setContentHeight(nextContentH);
      if (scrollParent) {
        const style = getComputedStyle(scrollParent);
        const padY =
          (parseFloat(style.paddingTop) || 0) +
          (parseFloat(style.paddingBottom) || 0);
        const availH = scrollParent.clientHeight - padY;
        if (availH > 0) setHostHeight(availH);
      }
    };

    updateSizes();
    const ro = new ResizeObserver(updateSizes);
    ro.observe(hostEl);
    ro.observe(contentEl);
    if (scrollParent) ro.observe(scrollParent);
    return () => ro.disconnect();
  }, [designWidth]);

  const widthScale = hostWidth / designWidth;
  const heightScale =
    fitHeight && hostHeight >= 360 && contentHeight > 0
      ? hostHeight / contentHeight
      : 1;
  const scale = Math.min(1, Math.max(0.25, Math.min(widthScale, heightScale)));
  const scaledWidth = Math.round(designWidth * scale);
  const scaledHeight =
    contentHeight > 0 ? Math.ceil(contentHeight * scale) : undefined;

  return (
    <div ref={hostRef} className="w-full flex justify-center">
      <div
        className="relative shrink-0"
        style={{
          width: `${scaledWidth}px`,
          height: scaledHeight ? `${scaledHeight}px` : 'auto',
        }}
      >
        <div
          ref={contentRef}
          style={{
            width: `${designWidth}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export const UIGuideModal: React.FC<UIGuideModalProps> = ({ onClose }) => {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop');
  const [selectedId, setSelectedId] = useState<number | null>(1);

  const legend = mode === 'desktop' ? DESKTOP_LEGEND : MOBILE_LEGEND;

  const sampleGame = useMemo(() => {
    const aiBoard: PlayerBoard = {
      red: { color: 'red', cards: [buildSampleCard('B001', 'ai-r1')], splay: 'none' },
      yellow: {
        color: 'yellow',
        cards: [buildSampleCard('B004', 'ai-y1'), buildSampleCard('B019', 'ai-y2')],
        splay: 'right',
      },
      green: { color: 'green', cards: [buildSampleCard('B008', 'ai-g1')], splay: 'none' },
      blue: { color: 'blue', cards: [buildSampleCard('B012', 'ai-b1')], splay: 'none' },
      purple: { color: 'purple', cards: [], splay: 'none' },
    };

    const playerBoard: PlayerBoard = {
      red: { color: 'red', cards: [], splay: 'none' },
      yellow: { color: 'yellow', cards: [buildSampleCard('B006', 'p1-y1')], splay: 'none' },
      green: {
        color: 'green',
        cards: [buildSampleCard('B009', 'p1-g1'), buildSampleCard('B021', 'p1-g2')],
        splay: 'left',
      },
      blue: { color: 'blue', cards: [buildSampleCard('B023', 'p1-b1')], splay: 'none' },
      purple: { color: 'purple', cards: [buildSampleCard('B015', 'p1-p1')], splay: 'none' },
    };

    const hand: CardInstance[] = [
      buildSampleCard('B022', 'hand-1'),
      buildSampleCard('B024', 'hand-2'),
      buildSampleCard('B025', 'hand-3'),
    ];

    const aiIcons = getVisibleIconCounts(aiBoard);
    const playerIcons = getVisibleIconCounts(playerBoard);

    const leaderCounts = {} as Record<
      FunctionalIcon,
      { max: number; tied: boolean }
    >;
    for (const icon of ALL_FUNCTIONAL_ICONS) {
      const a = aiIcons[icon];
      const p = playerIcons[icon];
      const max = Math.max(a, p);
      leaderCounts[icon] = { max, tied: max > 0 && a === p };
    }

    const comparisonIcon: FunctionalIcon = 'lightbulb';
    const aiCompOutcome: 'higher' | 'tied' | 'lower' =
      aiIcons[comparisonIcon] > playerIcons[comparisonIcon]
        ? 'higher'
        : aiIcons[comparisonIcon] < playerIcons[comparisonIcon]
        ? 'lower'
        : 'tied';

    return {
      aiBoard,
      playerBoard,
      hand,
      aiIcons,
      playerIcons,
      leaderCounts,
      comparisonIcon,
      aiCompOutcome,
    };
  }, []);

  const highlightRing = (id: number) =>
    selectedId === id ? 'ring-2 ring-[#F6C945]/90' : '';

  const renderDesktopPreview = () => (
    <ScaledPreviewFrame designWidth={1120} fitHeight={true}>
      <div className="w-[1120px] rounded-xl border border-[#D9C7A3]/25 bg-[#120F0D] shadow-2xl overflow-hidden text-[#F5EFE2]">
        {/* Desktop Top HUD */}
        <div className="px-3 py-1.5 bg-[#14110f] border-b border-[#2b241d] flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-display text-sm font-bold text-[#F5EFE2]">
              Turn 9 · Player 1
            </span>
            <span className="text-xs text-[#C8B9A6] font-mono-num">
              2 act left · Goal 6
            </span>
          </div>
          <div className={`relative shrink-0 rounded ${highlightRing(1)}`}>
            <button
              type="button"
              onClick={() => setSelectedId(1)}
              className="w-8 h-8 rounded bg-[#1f1915] border border-[#D9C7A3]/25 text-[#E5DAC5] flex items-center justify-center cursor-pointer"
              aria-label="Settings preview"
            >
              <Settings size={15} />
            </button>
            <CalloutBadge
              id={1}
              selectedId={selectedId}
              onSelect={setSelectedId}
              className="absolute -bottom-2 -left-2"
            />
          </div>
        </div>

        {/* Desktop Main Tabletop + Sidebar */}
        <div className="flex items-stretch gap-2 p-2">
          {/* Left Column */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {/* Opponent Panel */}
            <section className="rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/90 px-2.5 py-1.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-[140px] shrink-0 flex items-center gap-1.5 min-w-0">
                    <h3 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                      AI Archivist
                    </h3>
                    <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                      AI
                    </span>
                  </div>
                  <div
                    className={`relative flex items-center gap-1.5 rounded ${highlightRing(3)}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(3)}
                      className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 font-mono-num text-[11px] text-[#E5DAC5] cursor-pointer"
                    >
                      Score 6
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedId(3)}
                      className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 font-mono-num text-[11px] text-[#E5DAC5] cursor-pointer"
                    >
                      Ach 2/6
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedId(3)}
                      className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 font-mono-num text-[11px] text-[#E5DAC5] cursor-pointer"
                    >
                      H 3
                    </button>
                    <CalloutBadge
                      id={3}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      className="absolute top-1/2 -translate-y-1/2 -right-7"
                    />
                  </div>
                </div>

                <div
                  className={`relative rounded px-1 py-0.5 ${highlightRing(2)}`}
                >
                  <GuideIconStrip
                    counts={sampleGame.aiIcons}
                    leaderCounts={sampleGame.leaderCounts}
                    comparisonIcon={sampleGame.comparisonIcon}
                    comparisonOutcome={sampleGame.aiCompOutcome}
                    size={13}
                  />
                  <CalloutBadge
                    id={2}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    className="absolute top-1/2 -translate-y-1/2 -left-7"
                  />
                </div>
              </div>

              <div className="grid grid-cols-5 gap-1">
                {ALL_COLORS.map((color: CardColor) => (
                  <ColorStackView
                    key={`desk-ai-${color}`}
                    stack={sampleGame.aiBoard[color]}
                    cardSize="small"
                    highlightBorder={color === 'green'}
                    onInspectStack={noopInspect}
                  />
                ))}
              </div>
            </section>

            {/* Active Player Panel */}
            <section className="rounded-lg border border-[#F6C945]/50 bg-[#241C13]/95 shadow-[inset_0_0_24px_rgba(246,201,69,0.06)] px-2.5 py-1.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-[140px] shrink-0">
                    <h3 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                      Player 1
                    </h3>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 font-mono-num text-[11px] text-[#E5DAC5]">
                      Score 8
                    </span>
                    <span className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 font-mono-num text-[11px] text-[#E5DAC5]">
                      Ach 2/6
                    </span>
                  </div>
                </div>

                <GuideIconStrip
                  counts={sampleGame.playerIcons}
                  leaderCounts={sampleGame.leaderCounts}
                  comparisonIcon={sampleGame.comparisonIcon}
                  comparisonOutcome="tied"
                  size={13}
                />
              </div>

              <div className="relative grid grid-cols-5 gap-1">
                {ALL_COLORS.map((color: CardColor) => (
                  <div
                    key={`desk-p1-${color}`}
                    className={`relative rounded-lg ${
                      color === 'blue' ? highlightRing(4) : ''
                    }`}
                  >
                    <ColorStackView
                      stack={sampleGame.playerBoard[color]}
                      cardSize="small"
                      canDogma={sampleGame.playerBoard[color].cards.length > 0}
                      dogmaSelectMode={true}
                      highlightBorder={color === 'blue'}
                      onInspectStack={noopInspect}
                      onDogma={() => setSelectedId(4)}
                    />
                    {color === 'blue' && (
                      <CalloutBadge
                        id={4}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        className="absolute -top-2.5 right-1"
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Your Hand */}
            <section
              className={`relative rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/80 px-2.5 py-2 space-y-1.5 ${highlightRing(5)}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#C8B9A6]">
                    Your Hand
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="px-2 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 text-[11px] text-[#E5DAC5]">
                    Compact
                  </span>
                  <span className="px-2 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 text-[11px] text-[#E5DAC5]">
                    Sort
                  </span>
                  <span className="w-6 h-6 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 flex items-center justify-center text-[#9B8A76]">
                    <ChevronLeft size={13} />
                  </span>
                  <span className="w-6 h-6 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 flex items-center justify-center text-[#9B8A76]">
                    <ChevronRight size={13} />
                  </span>
                </div>
              </div>
              <CalloutBadge
                id={5}
                selectedId={selectedId}
                onSelect={setSelectedId}
                className="absolute -top-2.5 left-28"
              />
              <div className="flex items-start gap-2 overflow-hidden h-[178px]">
                {sampleGame.hand.map((card) => (
                  <CardTile
                    key={card.instanceId}
                    card={card}
                    compact={true}
                    cardSize="small"
                    onClick={() => setSelectedId(5)}
                  />
                ))}
              </div>
            </section>
          </div>

          {/* Right Command Sidebar */}
          <aside className="w-[252px] shrink-0 flex flex-col gap-2">
            {/* Decks + Achievements */}
            <div className={`relative rounded-lg space-y-2 ${highlightRing(7)}`}>
              <section className="rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/90 p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-display text-sm font-bold text-[#F5EFE2]">
                    Decks
                  </h4>
                  <span className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f] font-mono-num text-[11px] text-[#E5DAC5] inline-flex items-center gap-1">
                    <Trash2 size={11} className="text-[#C8B9A6]" />0
                  </span>
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {STANDARD_DECK_COUNTS.map(([age, count]) => {
                    const isNextDraw = age === 2;
                    return (
                      <div
                        key={`desk-deck-${age}`}
                        className={`rounded border py-1 text-center leading-tight font-mono-num ${
                          isNextDraw
                            ? 'border-[#F6C945]/70 bg-[#F6C945]/10 text-[#F6C945]'
                            : 'border-[#D9C7A3]/15 bg-[#14110f]/80 text-[#E5DAC5]'
                        }`}
                      >
                        <div className="text-[11px] font-bold">{age}</div>
                        <div className="text-[10px] opacity-80">{count}</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/90 p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-display text-sm font-bold text-[#F5EFE2]">
                    Achievements
                  </h4>
                  <span className="px-1.5 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f] font-mono-num text-[10.5px] text-[#E5DAC5]">
                    Special 4/5
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((age) => (
                    <div
                      key={`desk-ach-${age}`}
                      className={`rounded border py-1 text-center font-mono-num text-[11px] ${
                        age <= 2
                          ? 'border-[#D9C7A3]/10 bg-[#14110f]/30 text-[#6F6253] line-through'
                          : 'border-[#D9C7A3]/15 bg-[#14110f]/80 text-[#E5DAC5]'
                      }`}
                    >
                      {age}
                    </div>
                  ))}
                </div>
              </section>

              <CalloutBadge
                id={7}
                selectedId={selectedId}
                onSelect={setSelectedId}
                className="absolute -top-2.5 left-16"
              />
            </div>

            {/* Chronicle */}
            <section
              className={`relative flex-1 min-h-0 rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/90 p-2 flex flex-col gap-1.5 ${highlightRing(8)}`}
            >
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-display text-xs font-bold tracking-wider uppercase text-[#F5EFE2]">
                  Chronicle
                </h4>
                <button
                  type="button"
                  onClick={() => setSelectedId(8)}
                  className="w-6 h-6 rounded border border-[#D9C7A3]/20 bg-[#14110f] text-[#C8B9A6] flex items-center justify-center cursor-pointer"
                  aria-label="Chronicle order toggle preview"
                >
                  <ArrowDown size={12} />
                </button>
              </div>
              <CalloutBadge
                id={8}
                selectedId={selectedId}
                onSelect={setSelectedId}
                className="absolute -top-2 right-7"
              />
              <div className="space-y-1.5 overflow-hidden text-[11px]">
                <div className="rounded border border-[#D9C7A3]/15 bg-[#14110f]/75 p-2 space-y-1">
                  <div className="font-semibold text-[#F6C945]">Turn 8</div>
                  <div className="text-[#E5DAC5] font-medium">AI Archivist</div>
                  <div className="text-[#C8B9A6] leading-snug">
                    [Action 1] Melded FERMENTING (Age 2 yellow).
                  </div>
                  <div className="text-[#C8B9A6] leading-snug">
                    [Action 2] Activated FERMENTING (leaf).
                  </div>
                </div>
                <div className="rounded border border-[#D9C7A3]/15 bg-[#14110f]/75 p-2 space-y-1">
                  <div className="font-semibold text-[#C8B9A6]">Turn 7</div>
                  <div className="text-[#E5DAC5] font-medium">Player 1</div>
                  <div className="text-[#C8B9A6] leading-snug">
                    [Action 1] Claimed Standard Achievement 2.
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>

        {/* Desktop Action Bar */}
        <div
          className={`relative px-2.5 py-2 border-t border-[#2b241d] bg-[#14110f]/95 flex items-center gap-1.5 ${highlightRing(6)}`}
        >
          <CalloutBadge
            id={6}
            selectedId={selectedId}
            onSelect={setSelectedId}
            className="absolute -top-3 left-1/2 -translate-x-1/2"
          />
          <div className="px-2.5 py-1 rounded border border-[#D9C7A3]/20 bg-[#1C1714] flex flex-col items-center leading-tight shrink-0">
            <span className="text-[9px] uppercase tracking-wider text-[#C8B9A6]">
              Actions
            </span>
            <span className="text-xs font-mono-num font-bold text-[#F6C945]">
              2
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded-md font-display font-bold text-sm bg-[#D6A640] text-[#18120B] cursor-pointer"
          >
            Draw [2]
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded-md font-display font-bold text-sm bg-[#D6A640] text-[#18120B] cursor-pointer"
          >
            Meld
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded-md font-display font-bold text-sm bg-[#F6C945] text-[#18120B] ring-2 ring-[#F6C945]/50 cursor-pointer"
          >
            Dogma
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded-md font-display font-bold text-sm bg-[#241E19] border border-[#D9C7A3]/15 text-[#7A6B5B] cursor-pointer"
          >
            Achieve
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="w-14 h-9 rounded-md bg-[#1C1714] border border-[#D9C7A3]/20 text-[#9B8A76] flex items-center justify-center cursor-pointer"
            aria-label="End turn preview"
          >
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </ScaledPreviewFrame>
  );

  const renderMobilePreview = () => (
    <ScaledPreviewFrame designWidth={382} fitHeight={true}>
      <div className="w-[382px] rounded-[24px] border-[3px] border-[#3D3328] bg-[#120F0D] shadow-2xl overflow-hidden text-[#F5EFE2]">
        {/* Mobile Top HUD */}
        <div className="px-2.5 py-1.5 border-b border-[#2b241d] bg-[#14110f] flex items-center justify-between gap-2">
          <span className="font-display text-sm font-bold text-[#F5EFE2] truncate">
            T9 - Player 1
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className={`relative rounded ${highlightRing(9)}`}>
              <button
                type="button"
                onClick={() => setSelectedId(9)}
                className="px-2.5 py-1 rounded border border-[#F6C945]/50 bg-[#261E14] text-[#F6C945] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Eye size={13} />
                <span>Compact</span>
              </button>
              <CalloutBadge
                id={9}
                selectedId={selectedId}
                onSelect={setSelectedId}
                className="absolute -bottom-2 -left-2"
              />
            </div>

            <div className={`relative rounded ${highlightRing(1)}`}>
              <button
                type="button"
                onClick={() => setSelectedId(1)}
                className="w-8 h-8 rounded border border-[#D9C7A3]/25 bg-[#1C1714] text-[#E5DAC5] flex items-center justify-center cursor-pointer"
                aria-label="Mobile settings preview"
              >
                <Settings size={15} />
              </button>
              <CalloutBadge
                id={1}
                selectedId={selectedId}
                onSelect={setSelectedId}
                className="absolute -bottom-2 -right-1"
              />
            </div>
          </div>
        </div>

        {/* Mobile Scrollable Compact Content */}
        <div className="px-1.5 py-1.5 space-y-1.5">
          {/* Opponent Panel */}
          <section className="rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/90 px-1.5 py-1 space-y-1">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                  AI Archivist
                </h3>
                <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                  AI
                </span>
              </div>
              <div className={`relative rounded px-0.5 ${highlightRing(2)}`}>
                <GuideIconStrip
                  counts={sampleGame.aiIcons}
                  leaderCounts={sampleGame.leaderCounts}
                  comparisonIcon={sampleGame.comparisonIcon}
                  comparisonOutcome={sampleGame.aiCompOutcome}
                  size={11}
                  compact={true}
                />
                <CalloutBadge
                  id={2}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  className="absolute top-1/2 -translate-y-1/2 -left-6"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1">
              {ALL_COLORS.map((color: CardColor) => (
                <ColorStackView
                  key={`mob-ai-${color}`}
                  stack={sampleGame.aiBoard[color]}
                  boardCompact={true}
                  cardSize="small"
                  highlightBorder={color === 'yellow'}
                  onInspectStack={noopInspect}
                />
              ))}

              {/* 6th Slot: Score / Ach / H */}
              <div
                className={`relative h-[56px] flex flex-col justify-between gap-1 min-w-0 rounded ${highlightRing(3)}`}
              >
                <div className="grid grid-cols-2 gap-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(3)}
                    className="h-[25px] rounded border border-[#D9C7A3]/20 bg-[#14110f]/85 font-mono-num text-[10.5px] text-[#E5DAC5] cursor-pointer"
                  >
                    Score 6
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedId(3)}
                    className="h-[25px] rounded border border-[#D9C7A3]/20 bg-[#14110f]/85 font-mono-num text-[10.5px] text-[#E5DAC5] cursor-pointer"
                  >
                    Ach 2/6
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(3)}
                  className="h-[25px] w-full rounded border border-[#D9C7A3]/20 bg-[#14110f]/85 font-mono-num text-[10.5px] text-[#E5DAC5] cursor-pointer"
                >
                  H 3
                </button>
                <CalloutBadge
                  id={3}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  className="absolute top-1/2 -translate-y-1/2 -left-3"
                />
              </div>
            </div>
          </section>

          {/* Active Player Panel */}
          <section className="rounded-lg border border-[#F6C945]/50 bg-[#241C13]/95 px-1.5 py-1 space-y-1">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <h3 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                Player 1
              </h3>
              <GuideIconStrip
                counts={sampleGame.playerIcons}
                leaderCounts={sampleGame.leaderCounts}
                comparisonIcon={sampleGame.comparisonIcon}
                comparisonOutcome="tied"
                size={11}
                compact={true}
              />
            </div>

            <div className="grid grid-cols-2 gap-1">
              {ALL_COLORS.map((color: CardColor) => (
                <div
                  key={`mob-p1-${color}`}
                  className={`relative rounded ${
                    color === 'blue' ? highlightRing(4) : ''
                  }`}
                >
                  <ColorStackView
                    stack={sampleGame.playerBoard[color]}
                    boardCompact={true}
                    cardSize="small"
                    canDogma={sampleGame.playerBoard[color].cards.length > 0}
                    dogmaSelectMode={true}
                    highlightBorder={color === 'blue'}
                    onInspectStack={noopInspect}
                    onDogma={() => setSelectedId(4)}
                  />
                  {color === 'blue' && (
                    <CalloutBadge
                      id={4}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      className="absolute -top-2 right-1"
                    />
                  )}
                </div>
              ))}

              {/* 6th Slot: Score / Ach / Decks / Log */}
              <div className="h-[56px] flex flex-col justify-between gap-1 min-w-0">
                <div className="grid grid-cols-2 gap-1 min-w-0">
                  <span className="h-[25px] flex items-center justify-center rounded border border-[#D9C7A3]/20 bg-[#14110f]/85 font-mono-num text-[10.5px] text-[#E5DAC5]">
                    Score 8
                  </span>
                  <span className="h-[25px] flex items-center justify-center rounded border border-[#D9C7A3]/20 bg-[#14110f]/85 font-mono-num text-[10.5px] text-[#E5DAC5]">
                    Ach 2/6
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1 min-w-0">
                  <div className={`relative rounded ${highlightRing(7)}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(7)}
                      className="h-[25px] w-full rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10px] text-[#E5DAC5] cursor-pointer"
                    >
                      Decks
                    </button>
                    <CalloutBadge
                      id={7}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      className="absolute -bottom-2 -left-1.5"
                    />
                  </div>
                  <div className={`relative rounded ${highlightRing(8)}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(8)}
                      className="h-[25px] w-full rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10px] text-[#E5DAC5] cursor-pointer"
                    >
                      Log
                    </button>
                    <CalloutBadge
                      id={8}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      className="absolute -bottom-2 -right-1"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Your Hand */}
          <section
            className={`relative rounded-lg border border-[#D9C7A3]/20 bg-[#1B1612]/80 px-2 py-1.5 space-y-1.5 ${highlightRing(5)}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#C8B9A6]">
                Your Hand
              </span>
              <div className="flex items-center gap-1">
                <span className="px-2 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 text-[11px] text-[#E5DAC5]">
                  Compact
                </span>
                <span className="px-2 py-0.5 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 text-[11px] text-[#E5DAC5]">
                  Sort
                </span>
                <span className="w-6 h-6 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 flex items-center justify-center text-[#9B8A76]">
                  <ChevronLeft size={13} />
                </span>
                <span className="w-6 h-6 rounded border border-[#D9C7A3]/20 bg-[#14110f]/80 flex items-center justify-center text-[#9B8A76]">
                  <ChevronRight size={13} />
                </span>
              </div>
            </div>
            <CalloutBadge
              id={5}
              selectedId={selectedId}
              onSelect={setSelectedId}
              className="absolute -top-2.5 left-24"
            />
            <div className="flex items-start gap-2 overflow-hidden h-[168px] sm:h-[178px]">
              {sampleGame.hand.map((card) => (
                <CardTile
                  key={`mob-hand-${card.instanceId}`}
                  card={card}
                  compact={true}
                  hideHexagonInHandCompact={true}
                  cardSize="small"
                  onClick={() => setSelectedId(5)}
                />
              ))}
            </div>
          </section>
        </div>

        {/* Mobile Portrait Thumb-Zone Action Dock */}
        <div
          className={`relative mt-1 px-2 py-1.5 border-t border-[#2b241d] bg-[#14110f] flex items-center gap-1 ${highlightRing(6)}`}
        >
          <CalloutBadge
            id={6}
            selectedId={selectedId}
            onSelect={setSelectedId}
            className="absolute -top-3 left-1/2 -translate-x-1/2"
          />
          <div className="px-2 py-1 rounded border border-[#D9C7A3]/20 bg-[#1C1714] flex flex-col items-center leading-none shrink-0">
            <span className="text-[8px] uppercase tracking-wider text-[#C8B9A6]">
              Act
            </span>
            <span className="text-xs font-mono-num font-bold text-[#F6C945]">
              2
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded font-display font-bold text-xs bg-[#D6A640] text-[#18120B] cursor-pointer"
          >
            Draw [2]
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded font-display font-bold text-xs bg-[#D6A640] text-[#18120B] cursor-pointer"
          >
            Meld
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded font-display font-bold text-xs bg-[#F6C945] text-[#18120B] ring-1 ring-[#F6C945] cursor-pointer"
          >
            Dogma
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="flex-1 h-9 rounded font-display font-bold text-xs bg-[#241E19] border border-[#D9C7A3]/15 text-[#7A6B5B] cursor-pointer"
          >
            Achieve
          </button>
          <button
            type="button"
            onClick={() => setSelectedId(6)}
            className="w-9 h-9 rounded bg-[#1C1714] border border-[#D9C7A3]/20 text-[#9B8A76] flex items-center justify-center shrink-0 cursor-pointer"
            aria-label="Mobile end turn preview"
          >
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </ScaledPreviewFrame>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl bg-[#1C1714] border border-[#D9C7A3]/30 rounded-xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#D9C7A3]/15 bg-[#15110E] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div>
            <h2 className="font-display text-lg font-bold text-[#F5EFE2]">
              UI Guide
            </h2>
            <p className="text-xs text-[#C8B9A6]">
              Annotated mid-game overview. Click or hover over any numbered marker or legend entry to highlight it.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-[#D9C7A3]/20 bg-[#120F0C] p-0.5">
              <button
                type="button"
                onClick={() => {
                  setMode('desktop');
                  setSelectedId((prev) => (prev === 9 ? 1 : prev));
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                  mode === 'desktop'
                    ? 'bg-[#D6A640] text-[#18120B] font-semibold'
                    : 'text-[#C8B9A6] hover:text-[#F5EFE2]'
                }`}
              >
                <Monitor size={14} />
                <span>Desktop</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('mobile')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                  mode === 'mobile'
                    ? 'bg-[#D6A640] text-[#18120B] font-semibold'
                    : 'text-[#C8B9A6] hover:text-[#F5EFE2]'
                }`}
              >
                <Smartphone size={14} />
                <span>Mobile</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] text-[#C8B9A6] hover:text-[#F5EFE2] flex items-center justify-center cursor-pointer"
              aria-label="Close UI Guide"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body: Preview + Legend Sidebar */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
          <div className="flex-1 min-w-0 bg-[#0F0C0A] p-3 sm:p-4 overflow-y-auto overflow-x-hidden flex flex-col items-center justify-start">
            {mode === 'desktop' ? renderDesktopPreview() : renderMobilePreview()}
          </div>

          <aside className="w-full lg:w-[340px] xl:w-[360px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#D9C7A3]/15 bg-[#171310] overflow-y-auto p-3 sm:p-4 space-y-2 max-h-[38vh] lg:max-h-none">
            <div className="flex items-center justify-between pb-1 border-b border-[#D9C7A3]/10">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
                {mode === 'desktop' ? 'Desktop Legend' : 'Mobile Legend'}
              </span>
              <span className="text-[11px] font-mono-num text-[#9B8A76]">
                {legend.length} items
              </span>
            </div>

            {legend.map((item) => {
              const isActive = selectedId === item.id;
              return (
                <button
                  key={`${mode}-${item.id}`}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  onMouseEnter={() => setSelectedId(item.id)}
                  className={`w-full text-left rounded-lg border p-2.5 transition-colors cursor-pointer ${
                    isActive
                      ? 'border-[#F6C945]/80 bg-[#261E14]'
                      : 'border-[#D9C7A3]/15 bg-[#1C1714]/80 hover:border-[#D9C7A3]/35'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`mt-0.5 w-5 h-5 rounded-full font-mono-num text-[11px] font-bold flex items-center justify-center shrink-0 ${
                        isActive
                          ? 'bg-[#F6C945] text-[#18120B]'
                          : 'bg-[#120F0C] text-[#F6C945] border border-[#F6C945]/60'
                      }`}
                    >
                      {item.id}
                    </span>
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-xs font-semibold text-[#F5EFE2]">
                        {item.title}
                      </div>
                      <p className="text-[11.5px] leading-relaxed text-[#C8B9A6]">
                        {item.summary}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </aside>
        </div>
      </div>
    </div>
  );
};
