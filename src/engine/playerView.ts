import { getHighestTopCardAge, getVisibleIconCounts } from './splay';
import type {
  Age,
  CardBack,
  CardInstance,
  GameState,
  PlayerState,
  PlayerView,
  PublicPlayerView,
} from './types';
import { ALL_AGES } from './constants';

function toBack(card: CardInstance): CardBack {
  return {
    instanceId: card.instanceId,
    age: card.age,
    set: card.set,
  };
}

function toPublicPlayerView(player: PlayerState, revealHidden: boolean): PublicPlayerView {
  return {
    id: player.id,
    name: player.name,
    isAI: player.isAI,
    aiBackend: player.aiBackend,
    teamId: player.teamId,
    eliminated: player.eliminated,
    handCount: player.hand.length,
    handBacks: player.hand.map(toBack),
    board: {
      red: { ...player.board.red, cards: [...player.board.red.cards] },
      yellow: { ...player.board.yellow, cards: [...player.board.yellow.cards] },
      green: { ...player.board.green, cards: [...player.board.green.cards] },
      blue: { ...player.board.blue, cards: [...player.board.blue.cards] },
      purple: { ...player.board.purple, cards: [...player.board.purple.cards] },
    },
    visibleIcons: getVisibleIconCounts(player.board),
    highestTopAge: getHighestTopCardAge(player.board),
    scoreCount: player.scorePile.length,
    scoreTotal: player.scorePile.reduce((sum, c) => sum + c.age, 0),
    scoreBacks: player.scorePile.map(toBack),
    achievementCount: player.achievements.length,
    achievementBacks: player.achievements.map((ach) => ({
      id: ach.id,
      kind: ach.kind,
      age: ach.age,
      specialId: ach.specialId,
    })),
    ...(revealHidden
      ? {
          revealedHandCards: player.hand.map((c) => ({ ...c })),
          revealedScoreCards: player.scorePile.map((c) => ({ ...c })),
        }
      : {}),
  };
}

/**
 * Projects full authoritative GameState down to a viewer-specific PlayerView.
 * Guarantees ZERO hidden-information leakage by default:
 * - Other players' hands & score piles expose only backs (age + set), never card identities
 *   unless explicitly requested via `{ revealHidden: true }` for the UI Debug toggle.
 * - Decks, Standard Achievements, and Junk expose only backs/counts.
 */
export function projectPlayerView(
  state: GameState,
  viewerId: string,
  options?: { revealHidden?: boolean }
): PlayerView {
  const viewer = state.players.find((p) => p.id === viewerId);
  if (!viewer) {
    throw new Error(`Unknown viewerId: ${viewerId}`);
  }

  const revealHidden = Boolean(options?.revealHidden);

  const deckCounts = {} as Record<Age, number>;
  for (const age of ALL_AGES) {
    deckCounts[age] = state.decks[age].length;
  }

  const topPrompt = state.pendingPrompts[0] ?? null;
  const pendingPromptForViewer =
    topPrompt && topPrompt.playerId === viewerId ? topPrompt : null;

  const currentPlayer = state.players[state.currentPlayerIndex];

  const lastTurnActionsByPlayer: PlayerView['lastTurnActionsByPlayer'] = {};
  if (!state.fastSimulation && state.lastTurnActionsByPlayer) {
    for (const [pid, items] of Object.entries(state.lastTurnActionsByPlayer)) {
      lastTurnActionsByPlayer[pid] = items.map((x) => ({ ...x }));
    }
  }

  return {
    viewerId,
    variant: state.variant,
    controlMode: state.controlMode,
    phase: state.phase,
    turnNumber: state.turnNumber,
    currentPlayerId: currentPlayer.id,
    actionsRemaining: state.actionsRemaining,
    manualEndTurn: Boolean(state.manualEndTurn),
    achievementTarget: state.achievementTarget,
    viewer: {
      id: viewer.id,
      name: viewer.name,
      teamId: viewer.teamId,
      hand: viewer.hand.map((c) => ({ ...c })),
      board: {
        red: { ...viewer.board.red, cards: [...viewer.board.red.cards] },
        yellow: { ...viewer.board.yellow, cards: [...viewer.board.yellow.cards] },
        green: { ...viewer.board.green, cards: [...viewer.board.green.cards] },
        blue: { ...viewer.board.blue, cards: [...viewer.board.blue.cards] },
        purple: { ...viewer.board.purple, cards: [...viewer.board.purple.cards] },
      },
      visibleIcons: getVisibleIconCounts(viewer.board),
      highestTopAge: getHighestTopCardAge(viewer.board),
      scorePile: viewer.scorePile.map((c) => ({ ...c })),
      scoreTotal: viewer.scorePile.reduce((sum, c) => sum + c.age, 0),
      achievements: viewer.achievements.map((a) => ({ ...a })),
    },
    players: state.players.map((p) => toPublicPlayerView(p, revealHidden)),
    deckCounts,
    standardAchievementBacks: state.standardAchievements.map((c) => ({
      ...toBack(c),
      source: 'standard',
    })),
    availableSpecialAchievements: [...state.availableSpecialAchievements],
    junkCount: state.junk.length,
    junkBacks: state.junk.map(toBack),
    junkedStandardAges: state.junkedStandardAges ? [...state.junkedStandardAges] : [],
    pendingPromptForViewer,
    waitingOnPlayerId: topPrompt ? topPrompt.playerId : null,
    lastTurnActionsByPlayer,
    log: state.fastSimulation ? [] : [...state.log],
    victory: state.victory,
  };
}
