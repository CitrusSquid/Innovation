import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { ALL_AGES, ALL_COLORS } from './constants';
import {
  appendLog,
  cloneGameState,
  computeScoreTotal,
  getPlayer,
} from './keywords';
import { normalizeStackSplay } from './splay';
import type { CardDefinition, GameState } from './types';

export interface DebugCardLocation {
  def: CardDefinition;
  locationLabel: string;
  canMove: boolean;
}

export function listAllCardsWithLocations(state: GameState, viewerId: string): DebugCardLocation[] {
  const locationByDefId = new Map<string, { label: string; canMove: boolean }>();

  for (const age of ALL_AGES) {
    for (const c of state.decks[age]) {
      locationByDefId.set(c.defId, { label: `Supply Deck [${age}]`, canMove: true });
    }
  }
  for (const c of state.standardAchievements) {
    locationByDefId.set(c.defId, { label: `Achievement [${c.age}]`, canMove: true });
  }
  for (const c of state.junk) {
    locationByDefId.set(c.defId, { label: 'Junk Pile', canMove: true });
  }

  for (const p of state.players) {
    const ownerTag = p.id === viewerId ? 'Your' : `${p.name}'s`;
    for (const c of p.hand) {
      locationByDefId.set(c.defId, {
        label: `${ownerTag} Hand`,
        canMove: p.id !== viewerId,
      });
    }
    for (const c of p.scorePile) {
      locationByDefId.set(c.defId, { label: `${ownerTag} Score`, canMove: true });
    }
    for (const color of ALL_COLORS) {
      const stack = p.board[color];
      stack.cards.forEach((c, idx) => {
        const isTop = idx === stack.cards.length - 1;
        locationByDefId.set(c.defId, {
          label: `${ownerTag} ${color} (${isTop ? 'Top' : 'Covered'})`,
          canMove: true,
        });
      });
    }
  }

  return BASE_CARD_DATABASE.map((def) => {
    const loc = locationByDefId.get(def.id);
    return {
      def,
      locationLabel: loc?.label ?? 'In Play / Copy',
      canMove: loc?.canMove ?? true,
    };
  });
}

export function debugTakeAnyCard(
  rawState: GameState,
  targetPlayerId: string,
  defId: string
): { nextState: GameState; mode: 'moved' | 'copied' } {
  const state = cloneGameState(rawState);
  const targetPlayer = getPlayer(state, targetPlayerId);
  const def = BASE_CARD_DATABASE.find((c) => c.id === defId);
  if (!def) {
    throw new Error(`Unknown card defId: ${defId}`);
  }

  let extracted = null as ReturnType<typeof instantiateCard> | null;

  // Prefer taking from non-target-hand zones so moving works cleanly without duplicate IDs
  const takeFromArray = (arr: typeof state.junk) => {
    const idx = arr.findIndex((c) => c.defId === defId);
    if (idx === -1) return null;
    return arr.splice(idx, 1)[0];
  };

  for (const age of ALL_AGES) {
    extracted = takeFromArray(state.decks[age]);
    if (extracted) break;
  }
  if (!extracted) {
    extracted = takeFromArray(state.standardAchievements);
  }
  if (!extracted) {
    extracted = takeFromArray(state.junk);
  }
  if (!extracted) {
    for (const p of state.players) {
      if (p.id !== targetPlayerId) {
        extracted = takeFromArray(p.hand);
        if (extracted) break;
      }
      extracted = takeFromArray(p.scorePile);
      if (extracted) break;
      for (const color of ALL_COLORS) {
        extracted = takeFromArray(p.board[color].cards);
        if (extracted) {
          p.board[color] = normalizeStackSplay(p.board[color]);
          break;
        }
      }
      if (extracted) break;
    }
  }

  let mode: 'moved' | 'copied' = 'moved';
  if (!extracted) {
    extracted = instantiateCard(def, `dbg_${Date.now()}_${state.log.length}`);
    mode = 'copied';
  }

  targetPlayer.hand.push(extracted);

  // Refresh setup prompt options if still in setup phase
  for (const prompt of state.pendingPrompts) {
    if (prompt.kind === 'setup_meld' && prompt.playerId === targetPlayerId) {
      prompt.options = [...targetPlayer.hand];
    }
  }

  appendLog(
    state,
    targetPlayerId,
    `${targetPlayer.name} took ${def.name} [${def.age}] (${mode}).`,
    'Debug'
  );

  return { nextState: state, mode };
}

export function debugTriggerEndGame(
  rawState: GameState,
  playerId: string,
  outcome: 'win' | 'lose'
): GameState {
  const state = cloneGameState(rawState);
  const actor = getPlayer(state, playerId);

  state.phase = 'gameover';
  state.actionsRemaining = 0;
  state.pendingPrompts = [];
  state.activeDogma = null;

  const finalScores: Record<string, number> = {};
  const finalAchievements: Record<string, number> = {};
  for (const p of state.players) {
    finalScores[p.id] = computeScoreTotal(p);
    finalAchievements[p.id] = p.achievements.length;
  }

  if (outcome === 'win') {
    const is2v2 = state.variant === '2v2';
    const winnerPlayerIds = is2v2
      ? state.players.filter((p) => p.teamId === actor.teamId).map((p) => p.id)
      : [actor.id];
    state.victory = {
      winnerPlayerIds,
      winnerTeamId: is2v2 ? actor.teamId : null,
      reason: 'card_effect',
      summary: is2v2
        ? `Team ${actor.teamId} wins via Debug End Game.`
        : `${actor.name} wins via Debug End Game.`,
      finalScores,
      finalAchievements,
    };
  } else {
    const is2v2 = state.variant === '2v2';
    const others = state.players.filter((p) =>
      is2v2 ? p.teamId !== actor.teamId && !p.eliminated : p.id !== actor.id && !p.eliminated
    );
    const winnerTeamId = is2v2 && others[0] ? others[0].teamId : null;
    const winnerPlayerIds =
      others.length > 0
        ? is2v2
          ? state.players.filter((p) => p.teamId === others[0].teamId).map((p) => p.id)
          : [others[0].id]
        : [];
    state.victory = {
      winnerPlayerIds,
      winnerTeamId,
      reason: 'card_effect',
      summary:
        others.length > 0
          ? is2v2
            ? `Team ${others[0].teamId} wins via Debug End Game.`
            : `${others[0].name} wins via Debug End Game.`
          : `${actor.name} conceded via Debug End Game.`,
      finalScores,
      finalAchievements,
    };
  }

  appendLog(state, playerId, `Match ended (${outcome}).`, 'Debug');
  return state;
}
