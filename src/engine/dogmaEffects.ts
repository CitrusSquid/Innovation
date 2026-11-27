import { ALL_COLORS } from './constants';
import { resolvePromptAges3to5, startDogmaStepAges3to5 } from './dogmaAges3to5';
import { resolvePromptAges6to8, startDogmaStepAges6to8 } from './dogmaAges6to8';
import { resolvePromptAges9to11, startDogmaStepAges9to11 } from './dogmaAges9to11';
import {
  logStep,
  makePromptId,
  parseSplayDirectionFromText,
  promptSplayColor,
  recordChange,
  recordDemandTransfer,
  recordRepeatDrawStep,
  resolveMultiOrderPrompt,
  transferCardFromHandToZone,
  validateChooseCardsSelection,
  type DogmaStepOutcome,
} from './dogmaHelpers';
import {
  appendLog,
  claimSpecialAchievement,
  drawCardFromAge,
  exchangeCards,
  getOpponents,
  getPlayer,
  junkCardInstance,
  junkDeck,
  junkStandardAchievementByAge,
  meldCardInstance,
  removeCardFromHand,
  removeTopCardFromBoard,
  returnCardInstance,
  scoreCardInstance,
  splayPlayerColor,
  transferCard,
  tuckCardInstance,
} from './keywords';
import {
  canSplayStack,
  cardHasIcon,
  getStackVisibleIcons,
  getTopCard,
  getTopCards,
  getVisibleIconCounts,
} from './splay';
import type {
  Age,
  CardAbility,
  CardInstance,
  DogmaExecutionContext,
  GameState,
  PlayerState,
  TurnAction,
} from './types';

export type { DogmaStepOutcome };
export { parseSplayDirectionFromText };

function applyFermentingFallback(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean
): boolean {
  const junkedDeckCount = junkDeck(state, 2);
  const junkedBoards: string[] = [];
  for (const p of state.players) {
    if (p.eliminated) continue;
    const topYellow = getTopCard(p.board.yellow);
    if (topYellow && topYellow.defId === 'B019') {
      const removed = removeTopCardFromBoard(p, 'yellow');
      junkCardInstance(state, removed);
      junkedBoards.push(p.name);
    }
  }
  const changed = junkedDeckCount > 0 || junkedBoards.length > 0;
  logStep(
    state,
    ctx,
    execPlayer.id,
    isDemand,
    `Did not tuck a green card; junked ${junkedDeckCount} card(s) from [2] deck${
      junkedBoards.length > 0 ? ` and Fermenting from ${junkedBoards.join(', ')}` : ''
    }.`
  );
  recordChange(ctx, execPlayer.id, isDemand, changed);
  return changed;
}

function continueOarsDemandLoop(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  ability: CardAbility
): DogmaStepOutcome {
  while (state.phase !== 'gameover') {
    const coinCards = execPlayer.hand.filter((c) => cardHasIcon(c, 'coin'));
    if (coinCards.length === 0) {
      logStep(state, ctx, execPlayer.id, true, 'No card with Coin in hand.');
      ctx.subState = null;
      return 'completed';
    }
    if (coinCards.length > 1) {
      ctx.subState = { phase: 'oars_loop' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'oars', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (${ctx.sourceCardName})`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: coinCards,
        sourceLabel: 'Hand (with Coin)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }
    const transferred = transferCardFromHandToZone(
      state,
      execPlayer.id,
      'score',
      ctx.activatingPlayerId,
      coinCards[0].instanceId
    );
    recordDemandTransfer(ctx, ability.index);
    const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
    if (drawRes.gameEnded) {
      ctx.subState = null;
      return 'gameover';
    }
    logStep(
      state,
      ctx,
      execPlayer.id,
      true,
      `Transferred ${transferred.name} [${transferred.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
    );
  }
  return 'gameover';
}

export function startDogmaStep(
  state: GameState,
  ctx: DogmaExecutionContext,
  ability: CardAbility,
  execPlayer: PlayerState,
  isDemand: boolean,
  overrideDefId?: string,
  overrideCardName?: string
): DogmaStepOutcome {
  const defId = overrideDefId ?? ctx.sourceCardDefId;
  const cardName = overrideCardName ?? ctx.sourceCardName;
  const tagPrefix = execPlayer.id !== ctx.activatingPlayerId && !isDemand ? 'Share' : isDemand ? 'Demand' : 'Dogma';

  switch (defId) {
    // (1) ARCHERY [Red] B001
    case 'B001': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Hand is empty after draw attempt.');
          return 'completed';
        }
        const maxAge = Math.max(...execPlayer.hand.map((c) => c.age));
        const highest = execPlayer.hand.filter((c) => c.age === maxAge);
        if (highest.length === 1) {
          const moved = transferCardFromHandToZone(
            state,
            execPlayer.id,
            'hand',
            ctx.activatingPlayerId,
            highest[0].instanceId
          );
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Drew [${drawRes.drawnFromAge}] and transferred highest card (${moved.name} [${moved.age}]) to ${getPlayer(state, ctx.activatingPlayerId).name}.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'archery_pick', chosenValue: drawRes.drawnFromAge ?? 1 };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'archery', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (ARCHERY)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: highest,
          sourceLabel: 'Highest cards in Hand',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      // Ability 2: Junk an available achievement of value 1 or 2.
      const availAges = ([1, 2] as Age[]).filter((age) =>
        state.standardAchievements.some((c) => c.age === age)
      );
      if (availAges.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No available achievement of value 1 or 2 to junk.');
        return 'completed';
      }
      if (availAges.length === 1) {
        const junked = junkStandardAchievementByAge(state, availAges[0]);
        if (junked) {
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Junked Standard Achievement [${availAges[0]}].`);
        }
        return 'completed';
      }
      ctx.subState = { phase: 'archery_junk' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'archery_junk', execPlayer.id),
        kind: 'choose_value',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ARCHERY)`,
        subtitle: ability.text,
        options: availAges,
      });
      return 'awaiting_prompt';
    }

    // (1) METALWORKING [Red] B002
    case 'B002': {
      let scored = 0;
      let stepNumber = 0;
      const scoredAges: number[] = [];
      let keptCard: CardInstance | null = null;
      while (state.phase !== 'gameover') {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'reveal_hand');
        if (drawRes.gameEnded) return 'gameover';
        if (!drawRes.card) break;
        stepNumber += 1;
        recordChange(ctx, execPlayer.id, isDemand, true);
        if (cardHasIcon(drawRes.card, 'tower')) {
          const card = removeCardFromHand(execPlayer, drawRes.card.instanceId);
          scoreCardInstance(state, execPlayer.id, card);
          scored += 1;
          scoredAges.push(card.age);
          recordRepeatDrawStep(state, {
            actorId: execPlayer.id,
            actorName: execPlayer.name,
            sourceCardDefId: defId,
            sourceCardName: cardName,
            stepNumber,
            card,
            repeats: true,
            badge: 'Scored · Keep Drawing',
            outcomeText: `Has Tower — scored [${card.age}] and repeating Metalworking.`,
          });
        } else {
          keptCard = drawRes.card;
          recordRepeatDrawStep(state, {
            actorId: execPlayer.id,
            actorName: execPlayer.name,
            sourceCardDefId: defId,
            sourceCardName: cardName,
            stepNumber,
            card: keptCard,
            repeats: false,
            badge: 'Kept in Hand · Stop',
            outcomeText: `No Tower — kept ${keptCard.name} [${keptCard.age}] in hand. Effect ends.`,
          });
          break;
        }
      }
      const parts: string[] = [];
      if (scored > 0) parts.push(`revealed & scored ${scored} card(s) with Tower (${scoredAges.map((a) => `[${a}]`).join(', ')})`);
      if (keptCard) parts.push(`revealed ${keptCard.name} [${keptCard.age}] (no Tower; kept in hand)`);
      logStep(state, ctx, execPlayer.id, isDemand, parts.join('; ') || 'No cards left to draw.');
      return 'completed';
    }

    // (1) OARS [Red] B003
    case 'B003': {
      if (ability.index === 1) {
        return continueOarsDemandLoop(state, ctx, execPlayer, ability);
      }
      // Ability 2: If no cards were transferred due to this demand, draw a [1].
      if (ctx.demandTransferredByAbility?.[1]) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Skipped [1] draw (a card was transferred by Oars demand).');
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}] (no cards transferred on demand).`);
      }
      return 'completed';
    }

    // (1) AGRICULTURE [Yellow] B004
    case 'B004': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No cards in hand to return.');
        return 'completed';
      }
      ctx.subState = { phase: 'agriculture_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'agri', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (AGRICULTURE)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand',
        allowSkip: true,
        skipLabel: 'Return Nothing',
      });
      return 'awaiting_prompt';
    }

    // (1) DOMESTICATION [Yellow] B005
    case 'B005': {
      if (execPlayer.hand.length === 0) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, Boolean(drawRes.card));
        logStep(state, ctx, execPlayer.id, isDemand, `Hand empty (no meld); drew [${drawRes.drawnFromAge}].`);
        return 'completed';
      }
      const minAge = Math.min(...execPlayer.hand.map((c) => c.age));
      const lowest = execPlayer.hand.filter((c) => c.age === minAge);
      if (lowest.length === 1) {
        const card = removeCardFromHand(execPlayer, lowest[0].instanceId);
        meldCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Melded lowest card (${card.name} [${card.age}]) and drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'domestication_meld' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'dom', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (DOMESTICATION)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: lowest,
        sourceLabel: 'Lowest cards in Hand',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (1) MASONRY [Yellow] B006
    case 'B006': {
      if (ability.index === 1) {
        const towerCards = execPlayer.hand.filter((c) => cardHasIcon(c, 'tower'));
        if (towerCards.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No cards with Tower in hand to meld.');
          return 'completed';
        }
        ctx.subState = { phase: 'masonry_meld' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'masonry', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (MASONRY)`,
          subtitle: ability.text,
          min: 0,
          max: towerCards.length,
          candidates: towerCards,
          sourceLabel: 'Hand cards with Tower (click order = meld order)',
          allowSkip: true,
          skipLabel: 'Meld None',
        });
        return 'awaiting_prompt';
      }
      // Ability 2: If you have exactly three red cards on your board, claim the Monument achievement.
      if (
        execPlayer.board.red.cards.length === 3 &&
        state.availableSpecialAchievements.includes('monument')
      ) {
        const claimed = claimSpecialAchievement(state, execPlayer.id, 'monument');
        recordChange(ctx, execPlayer.id, isDemand, claimed);
        logStep(state, ctx, execPlayer.id, isDemand, 'Had 3 Red cards on board — claimed Monument!');
      } else {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          execPlayer.board.red.cards.length === 3
            ? 'Monument already claimed.'
            : `Has ${execPlayer.board.red.cards.length} Red card(s) (needs exactly 3 for Monument).`
        );
      }
      return 'completed';
    }

    // (1) CLOTHING [Green] B007
    case 'B007': {
      if (ability.index === 1) {
        const eligible = execPlayer.hand.filter(
          (c) => execPlayer.board[c.color].cards.length === 0
        );
        if (eligible.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No hand card of a color absent from board.');
          return 'completed';
        }
        if (eligible.length === 1) {
          const card = removeCardFromHand(execPlayer, eligible[0].instanceId);
          meldCardInstance(state, execPlayer.id, card);
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Melded ${card.name} (${card.color}).`);
          return 'completed';
        }
        ctx.subState = { phase: 'clothing_meld' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'clothing', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (CLOTHING)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligible,
          sourceLabel: 'Colors not yet on your board',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      // Ability 2: Draw and score a [1] for every color present on your board that no opponent has on their board.
      const opponents = getOpponents(state, execPlayer.id);
      const exclusive = ALL_COLORS.filter(
        (col) =>
          execPlayer.board[col].cards.length > 0 &&
          opponents.every((opp) => opp.board[col].cards.length === 0)
      );
      if (exclusive.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No exclusive board colors (scored 0).');
        return 'completed';
      }
      const scoredAges: number[] = [];
      for (let i = 0; i < exclusive.length; i++) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'score');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.drawnFromAge) scoredAges.push(drawRes.drawnFromAge);
      }
      recordChange(ctx, execPlayer.id, isDemand, scoredAges.length > 0);
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Scored ${scoredAges.length} card(s) (${scoredAges.map((a) => `[${a}]`).join(', ')}) for exclusive colors (${exclusive.join(', ')}).`
      );
      return 'completed';
    }

    // (1) SAILING [Green] B008
    case 'B008': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew and melded ${drawRes.card.name} [${drawRes.card.age}] (${drawRes.card.color}).`
        );
      }
      return 'completed';
    }

    // (1) THE WHEEL [Green] B009
    case 'B009': {
      const drawn: number[] = [];
      for (let i = 0; i < 2; i++) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.drawnFromAge) drawn.push(drawRes.drawnFromAge);
      }
      recordChange(ctx, execPlayer.id, isDemand, drawn.length > 0);
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Drew ${drawn.length} card(s) (${drawn.map((a) => `[${a}]`).join(', ')}).`
      );
      return 'completed';
    }

    // (1) POTTERY [Blue] B010
    case 'B010': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no cards to return).');
          return 'completed';
        }
        const maxPick = Math.min(3, execPlayer.hand.length);
        ctx.subState = { phase: 'pottery_return' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'pottery', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (POTTERY)`,
          subtitle: ability.text,
          min: 0,
          max: maxPick,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand (click order = return order; scores card of value = count)',
          allowSkip: true,
          skipLabel: 'Return None',
        });
        return 'awaiting_prompt';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.drawnFromAge) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (1) TOOLS [Blue] B011
    case 'B011': {
      if (ability.index === 1) {
        if (execPlayer.hand.length < 3) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Fewer than 3 cards in hand to return.');
          return 'completed';
        }
        ctx.subState = { phase: 'tools_return3' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'tools1', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (TOOLS)`,
          subtitle: ability.text,
          min: 3,
          max: 3,
          candidates: execPlayer.hand,
          sourceLabel: 'Select 3 cards (click order = return order) or Decline',
          allowSkip: true,
          skipLabel: 'Decline',
        });
        return 'awaiting_prompt';
      }
      const threes = execPlayer.hand.filter((c) => c.age === 3);
      if (threes.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No [3] in hand to return.');
        return 'completed';
      }
      ctx.subState = { phase: 'tools_return_age3' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'tools2', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (TOOLS)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: threes,
        sourceLabel: 'Age 3 cards in Hand',
        allowSkip: true,
        skipLabel: 'Decline',
      });
      return 'awaiting_prompt';
    }

    // (1) WRITING [Blue] B012
    case 'B012': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.drawnFromAge) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (1) CITY STATES [Purple] B013
    case 'B013': {
      const towerCount = getVisibleIconCounts(execPlayer.board).tower;
      if (towerCount < 4) {
        logStep(state, ctx, execPlayer.id, true, `Has ${towerCount} Tower (needs >= 4); immune to demand.`);
        return 'completed';
      }
      const topsWithTower = getTopCards(execPlayer.board).filter((c) =>
        cardHasIcon(c, 'tower')
      );
      if (topsWithTower.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'Has >= 4 Tower, but no top card has Tower.');
        return 'completed';
      }
      if (topsWithTower.length === 1) {
        const target = topsWithTower[0];
        transferCard(
          state,
          { zone: 'board', playerId: execPlayer.id, color: target.color },
          { zone: 'board', playerId: ctx.activatingPlayerId },
          target.instanceId
        );
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred top ${target.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'city_states_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'city', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (CITY STATES)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: topsWithTower,
        sourceLabel: 'Your top cards with Tower',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (1) CODE OF LAWS [Purple] B014
    case 'B014': {
      const tuckable = execPlayer.hand.filter((c) => execPlayer.board[c.color].cards.length > 0);
      if (tuckable.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No hand card matches a color on board.');
        return 'completed';
      }
      ctx.subState = { phase: 'code_of_laws_tuck' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'laws_tuck', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CODE OF LAWS)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: tuckable,
        sourceLabel: 'Hand cards matching a color on your board',
        allowSkip: true,
        skipLabel: 'Tuck Nothing',
      });
      return 'awaiting_prompt';
    }

    // (1) MYSTICISM [Purple] B015
    case 'B015': {
      const draw1 = drawCardFromAge(state, execPlayer.id, 1, 'reveal_hand');
      if (draw1.gameEnded) return 'gameover';
      if (!draw1.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      const revealed = draw1.card;
      if (execPlayer.board[revealed.color].cards.length > 0) {
        const card = removeCardFromHand(execPlayer, revealed.instanceId);
        meldCardInstance(state, execPlayer.id, card);
        const draw2 = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (draw2.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Revealed & melded ${card.name} [${card.age}] (${card.color} matched board) and drew [${draw2.drawnFromAge}].`
        );
      } else {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Revealed ${revealed.name} [${revealed.age}] (${revealed.color} not on board; kept in hand).`
        );
      }
      return 'completed';
    }

    // (2) CONSTRUCTION [Red] B016
    case 'B016': {
      if (ability.index === 1) {
        if (execPlayer.hand.length <= 2) {
          const moved: string[] = [];
          while (execPlayer.hand.length > 0) {
            const c = transferCardFromHandToZone(
              state,
              execPlayer.id,
              'hand',
              ctx.activatingPlayerId,
              execPlayer.hand[0].instanceId
            );
            moved.push(`${c.name} [${c.age}]`);
          }
          const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'hand');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.length} card(s) to ${getPlayer(state, ctx.activatingPlayerId).name} and drew [${drawRes.drawnFromAge}].`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'construction_transfer' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'constr', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (CONSTRUCTION): To ${getPlayer(state, ctx.activatingPlayerId).name}`,
          subtitle: ability.text,
          min: 2,
          max: 2,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand (choose 2)',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      // Ability 2: If you are the only player with five top cards, claim the Empire achievement.
      const withFive = state.players.filter(
        (p) => !p.eliminated && getTopCards(p.board).length === 5
      );
      if (
        withFive.length === 1 &&
        withFive[0].id === execPlayer.id &&
        state.availableSpecialAchievements.includes('empire')
      ) {
        const claimed = claimSpecialAchievement(state, execPlayer.id, 'empire');
        recordChange(ctx, execPlayer.id, isDemand, claimed);
        logStep(state, ctx, execPlayer.id, isDemand, 'Only player with 5 top cards — claimed Empire!');
      } else {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Did not claim Empire (${getTopCards(execPlayer.board).length}/5 top cards${
            withFive.length > 1 ? ', tied' : ''
          }).`
        );
      }
      return 'completed';
    }

    // (2) ROAD BUILDING [Red] B017
    case 'B017': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no cards to meld).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        const card = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
        meldCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Melded 1 card (${card.name} [${card.age}]).`);
        return 'completed';
      }
      ctx.subState = { phase: 'road_building_meld' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'road_meld', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ROAD BUILDING)`,
        subtitle: ability.text,
        min: 1,
        max: 2,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (click order = meld order)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (2) CANAL BUILDING [Yellow] B018
    case 'B018': {
      const maxHand = execPlayer.hand.length > 0 ? Math.max(...execPlayer.hand.map((c) => c.age)) : 0;
      const highHandCount = execPlayer.hand.filter((c) => c.age === maxHand).length;
      const maxScore = execPlayer.scorePile.length > 0 ? Math.max(...execPlayer.scorePile.map((c) => c.age)) : 0;
      const highScoreCount = execPlayer.scorePile.filter((c) => c.age === maxScore).length;

      ctx.subState = { phase: 'canal_choice' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'canal', execPlayer.id),
        kind: 'choose_option',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CANAL BUILDING)`,
        subtitle: ability.text,
        options: [
          {
            id: 'exchange',
            label: 'Exchange highest Hand & Score cards',
            description: `${highHandCount} hand [${maxHand || '-'}] ↔ ${highScoreCount} score [${maxScore || '-'}]`,
          },
          {
            id: 'junk3',
            label: 'Junk all cards in [3] deck',
            description: `${state.decks[3].length} card(s) currently in Age 3 deck`,
          },
          {
            id: 'decline',
            label: 'Do nothing',
          },
        ],
      });
      return 'awaiting_prompt';
    }

    // (2) FERMENTING [Yellow] B019
    case 'B019': {
      if (ability.index === 1) {
        const leafColorCount = ALL_COLORS.filter(
          (col) => getStackVisibleIcons(execPlayer.board[col]).leaf > 0
        ).length;
        if (leafColorCount === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No board color has Leaf (drew 0).');
          return 'completed';
        }
        const drawn: number[] = [];
        for (let i = 0; i < leafColorCount; i++) {
          const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'hand');
          if (drawRes.gameEnded) return 'gameover';
          if (drawRes.drawnFromAge) drawn.push(drawRes.drawnFromAge);
        }
        recordChange(ctx, execPlayer.id, isDemand, drawn.length > 0);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew ${drawn.length} card(s) (${drawn.map((a) => `[${a}]`).join(', ')}) for ${leafColorCount} color(s) with Leaf.`
        );
        return 'completed';
      }
      // Ability 2: You may tuck a green card from your hand. If you don't, junk [2] deck + any top Fermenting.
      const greenCards = execPlayer.hand.filter((c) => c.color === 'green');
      if (greenCards.length === 0) {
        applyFermentingFallback(state, ctx, execPlayer, isDemand);
        return 'completed';
      }
      ctx.subState = { phase: 'fermenting_tuck' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'ferm', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (FERMENTING)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: greenCards,
        sourceLabel: 'Green cards in Hand',
        allowSkip: true,
        skipLabel: "Don't Tuck (Junk [2] & Fermenting)",
      });
      return 'awaiting_prompt';
    }

    // (2) CURRENCY [Green] B020
    case 'B020': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no cards to return).');
        return 'completed';
      }
      ctx.subState = { phase: 'currency_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'currency', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CURRENCY)`,
        subtitle: ability.text,
        min: 0,
        max: execPlayer.hand.length,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (click order = return order; scores [2] per distinct value)',
        allowSkip: true,
        skipLabel: 'Return None',
      });
      return 'awaiting_prompt';
    }

    // (2) MAPMAKING [Green] B021
    case 'B021': {
      if (ability.index === 1) {
        const ones = execPlayer.scorePile.filter((c) => c.age === 1);
        if (ones.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No [1] in score pile.');
          return 'completed';
        }
        if (ones.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'score', playerId: execPlayer.id },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            ones[0].instanceId
          );
          recordDemandTransfer(ctx, 1);
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} [1] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'mapmaking_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'map', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (MAPMAKING)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: ones,
          sourceLabel: 'Age 1 cards in Score Pile',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (!ctx.demandTransferredByAbility?.[1]) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Skipped [1] draw & score (no card transferred on demand).');
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'score');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.drawnFromAge) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew and scored [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (2) CALENDAR [Blue] B022
    case 'B022': {
      if (execPlayer.scorePile.length > execPlayer.hand.length) {
        const drawn: number[] = [];
        for (let i = 0; i < 2; i++) {
          const drawRes = drawCardFromAge(state, execPlayer.id, 3, 'hand');
          if (drawRes.gameEnded) return 'gameover';
          if (drawRes.drawnFromAge) drawn.push(drawRes.drawnFromAge);
        }
        recordChange(ctx, execPlayer.id, isDemand, drawn.length > 0);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Score count (${execPlayer.scorePile.length}) > Hand (${execPlayer.hand.length - drawn.length}); drew ${drawn.map((a) => `[${a}]`).join(', ')}.`
        );
      } else {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Condition not met (Score ${execPlayer.scorePile.length} <= Hand ${execPlayer.hand.length}).`
        );
      }
      return 'completed';
    }

    // (2) MATHEMATICS [Blue] B023
    case 'B023': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to return).');
        return 'completed';
      }
      ctx.subState = { phase: 'math_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'math', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (MATHEMATICS)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand',
        allowSkip: true,
        skipLabel: 'Return Nothing',
      });
      return 'awaiting_prompt';
    }

    // (2) MONOTHEISM [Purple] B024
    case 'B024': {
      if (ability.index === 1) {
        const actPlayer = getPlayer(state, ctx.activatingPlayerId);
        const eligibleTops = ALL_COLORS.filter(
          (col) => execPlayer.board[col].cards.length > 0 && actPlayer.board[col].cards.length === 0
        ).map((col) => getTopCard(execPlayer.board[col])!);

        if (eligibleTops.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top card of a color absent from attacker board.');
          return 'completed';
        }
        if (eligibleTops.length === 1) {
          const target = eligibleTops[0];
          transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: target.color },
            { zone: 'score', playerId: actPlayer.id },
            target.instanceId
          );
          const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'tuck');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${target.name} [${target.age}] to ${actPlayer.name}'s score pile and tucked [${drawRes.drawnFromAge}].`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'monotheism_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'mono', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (MONOTHEISM): To ${actPlayer.name}`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligibleTops,
          sourceLabel: 'Eligible top cards on your board',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'tuck');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew and tucked ${drawRes.card.name} [${drawRes.card.age}].`
        );
      }
      return 'completed';
    }

    // (2) PHILOSOPHY [Purple] B025
    case 'B025': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'left', cardName);
      }
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to score).');
        return 'completed';
      }
      ctx.subState = { phase: 'philosophy_score' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'phil', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (${cardName})`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand',
        allowSkip: true,
        skipLabel: 'Score Nothing',
      });
      return 'awaiting_prompt';
    }

    default:
      break;
  }

  const out3to5 = startDogmaStepAges3to5(state, ctx, defId, cardName, ability, execPlayer, isDemand);
  if (out3to5 !== null) return out3to5;

  const out6to8 = startDogmaStepAges6to8(state, ctx, defId, cardName, ability, execPlayer, isDemand);
  if (out6to8 !== null) return out6to8;

  const out9to11 = startDogmaStepAges9to11(state, ctx, defId, cardName, ability, execPlayer, isDemand);
  if (out9to11 !== null) return out9to11;

  // Generic splay fallback for custom test cards
  const splayDir = parseSplayDirectionFromText(ability.text);
  if (splayDir) {
    return promptSplayColor(state, ctx, execPlayer, isDemand, ability, splayDir, cardName);
  }

  return 'completed';
}

/**
 * Resolves a player's answer to a Dogma PendingPrompt and returns:
 * - `'completed'` when the current Dogma step is finished and ready to increment `currentStepIndex`
 * - `'awaiting_prompt'` when another prompt inside the same Dogma step was queued
 * - `'gameover'` if an Age 12+ or card-effect win triggered victory
 * - `'dogma_complete'` if the card text terminates the remaining dogma action (e.g. Fission)
 */
export function resolveDogmaPromptAnswer(
  state: GameState,
  ctx: DogmaExecutionContext,
  prompt: NonNullable<GameState['pendingPrompts'][number]>,
  action: Extract<TurnAction, { type: 'answer_prompt' }>
): DogmaStepOutcome {
  const step = ctx.steps[ctx.currentStepIndex];
  const ability = step.sourceAbility ?? ctx.lockedAbilities.find((a) => a.index === step.abilityIndex)!;
  const stepCardName = step.sourceCardName ?? ctx.sourceCardName;
  const execPlayer = getPlayer(state, step.executingPlayerId);
  const isDemand = step.isDemand;
  const phase = ctx.subState?.phase;
  const prevSubState = ctx.subState;
  ctx.subState = null;

  // Generic splay prompt handler (only when no custom card-specific subState phase owns it)
  if (prompt.kind === 'choose_color' && prompt.splayDirection && !prevSubState) {
    const dirLabel = prompt.splayDirection === 'aslant' ? 'askew' : prompt.splayDirection;
    const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
    if (action.selectedColor) {
      if (!prompt.options.includes(action.selectedColor)) {
        throw new Error(`Invalid color selection: ${action.selectedColor}`);
      }
      const changed = splayPlayerColor(
        state,
        execPlayer.id,
        action.selectedColor,
        prompt.splayDirection,
        isSharing ? 'Share' : 'Dogma',
        ctx.parentLogId
      );
      recordChange(ctx, execPlayer.id, isDemand, changed);
    } else if (prompt.allowSkip) {
      logStep(state, ctx, execPlayer.id, isDemand, `Declined to splay ${dirLabel}.`);
    } else {
      throw new Error('Must select a color.');
    }
    return 'completed';
  }

  // Validate choose_cards selections cleanly
  const selectedIds = action.selectedCardIds ?? [];
  if (prompt.kind === 'choose_cards') {
    validateChooseCardsSelection(prompt, selectedIds);
  }

  // Multi-card meld/tuck order prompt continuation
  if (phase === 'multi_meld_order' || phase === 'multi_tuck_order') {
    if (prompt.kind !== 'choose_order') {
      throw new Error('Expected choose_order prompt.');
    }
    const mode = phase === 'multi_meld_order' ? 'meld' : 'tuck';
    return resolveMultiOrderPrompt(
      state,
      ctx,
      prompt,
      action,
      execPlayer,
      isDemand,
      mode,
      prevSubState?.tempCards ?? [],
      stepCardName
    );
  }

  switch (phase) {
    case 'archery_pick': {
      const moved = transferCardFromHandToZone(
        state,
        execPlayer.id,
        'hand',
        ctx.activatingPlayerId,
        selectedIds[0]
      );
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Drew [${prevSubState?.chosenValue ?? 1}] and transferred highest card (${moved.name} [${moved.age}]) to ${getPlayer(state, ctx.activatingPlayerId).name}.`
      );
      return 'completed';
    }

    case 'archery_junk': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must select an eligible achievement value.');
      }
      const junked = junkStandardAchievementByAge(state, action.selectedValue);
      if (junked) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Junked Standard Achievement [${action.selectedValue}].`);
      }
      return 'completed';
    }

    case 'oars_loop': {
      const transferred = transferCardFromHandToZone(
        state,
        execPlayer.id,
        'score',
        ctx.activatingPlayerId,
        selectedIds[0]
      );
      recordDemandTransfer(ctx, ability.index);
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred ${transferred.name} [${transferred.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
      );
      return continueOarsDemandLoop(state, ctx, execPlayer, ability);
    }

    case 'agriculture_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return a card.');
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawRes = drawCardFromAge(state, execPlayer.id, card.age + 1, 'score');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${card.name} [${card.age}] and scored [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'domestication_meld': {
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      meldCardInstance(state, execPlayer.id, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Melded ${card.name} [${card.age}] and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'masonry_meld': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to meld any Tower cards.');
        return 'completed';
      }
      const meldedNames: string[] = [];
      for (const cid of selectedIds) {
        const card = removeCardFromHand(execPlayer, cid);
        meldCardInstance(state, execPlayer.id, card);
        meldedNames.push(`${card.name} [${card.age}]`);
      }
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Melded ${meldedNames.join(', ')}.`);
      return 'completed';
    }

    case 'clothing_meld': {
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      meldCardInstance(state, execPlayer.id, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Melded ${card.name} (${card.color}).`);
      return 'completed';
    }

    case 'pottery_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return any cards.');
        return 'completed';
      }
      const returnedNames: string[] = [];
      for (const cid of selectedIds) {
        const card = removeCardFromHand(execPlayer, cid);
        returnCardInstance(state, card);
        returnedNames.push(`${card.name} [${card.age}]`);
      }
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawRes = drawCardFromAge(state, execPlayer.id, selectedIds.length, 'score');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${returnedNames.join(', ')} and scored [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'tools_return3': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return 3 cards.');
        return 'completed';
      }
      for (const cid of selectedIds) {
        const card = removeCardFromHand(execPlayer, cid);
        returnCardInstance(state, card);
      }
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawRes = drawCardFromAge(state, execPlayer.id, 3, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned 3 cards and drew & melded ${drawRes.card?.name ?? '[3]'} [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'tools_return_age3': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return a [3].');
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawn: number[] = [];
      for (let i = 0; i < 3; i++) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.drawnFromAge) drawn.push(drawRes.drawnFromAge);
      }
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${card.name} [3] and drew ${drawn.map((a) => `[${a}]`).join(', ')}.`
      );
      return 'completed';
    }

    case 'city_states_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      transferCard(
        state,
        { zone: 'board', playerId: execPlayer.id, color: target.color },
        { zone: 'board', playerId: ctx.activatingPlayerId },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred top ${target.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'code_of_laws_tuck': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to tuck a matching card.');
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      tuckCardInstance(state, execPlayer.id, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      if (!canSplayStack(execPlayer.board[card.color], 'left')) {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Tucked ${card.name} [${card.age}] (${card.color} already splayed left).`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'code_of_laws_splay', tuckedColor: card.color };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'laws_splay', execPlayer.id),
        kind: 'choose_yes_no',
        playerId: execPlayer.id,
        title: `${execPlayer.id !== ctx.activatingPlayerId && !isDemand ? 'Share' : 'Dogma'} (CODE OF LAWS)`,
        subtitle: `Tucked ${card.name} [${card.age}]. You may splay ${card.color} left.`,
        confirmLabel: `Splay ${card.color} Left`,
        declineLabel: "Don't Splay",
      });
      return 'awaiting_prompt';
    }

    case 'code_of_laws_splay': {
      const color = prevSubState?.tuckedColor;
      if (action.confirmed && color) {
        const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
        const splayed = splayPlayerColor(
          state,
          execPlayer.id,
          color,
          'left',
          isSharing ? 'Share' : 'Dogma',
          ctx.parentLogId
        );
        recordChange(ctx, execPlayer.id, isDemand, splayed);
      } else {
        logStep(state, ctx, execPlayer.id, isDemand, `Tucked card; declined to splay ${color ?? ''} left.`);
      }
      return 'completed';
    }

    case 'construction_transfer': {
      const moved: string[] = [];
      for (const cid of selectedIds) {
        const c = transferCardFromHandToZone(
          state,
          execPlayer.id,
          'hand',
          ctx.activatingPlayerId,
          cid
        );
        moved.push(`${c.name} [${c.age}]`);
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred ${moved.length} card(s) to ${getPlayer(state, ctx.activatingPlayerId).name} and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'road_building_meld': {
      const meldedNames: string[] = [];
      for (const cid of selectedIds) {
        const card = removeCardFromHand(execPlayer, cid);
        meldCardInstance(state, execPlayer.id, card);
        meldedNames.push(`${card.name} [${card.age}]`);
      }
      recordChange(ctx, execPlayer.id, isDemand, meldedNames.length > 0);
      logStep(state, ctx, execPlayer.id, isDemand, `Melded ${meldedNames.join(', ')}.`);

      if (selectedIds.length === 2) {
        const topRed = getTopCard(execPlayer.board.red);
        const others = state.players.filter((p) => p.id !== execPlayer.id && !p.eliminated);
        if (topRed && others.length > 0) {
          ctx.subState = { phase: 'road_building_transfer', meldedCount: 2 };
          state.pendingPrompts.push({
            id: makePromptId(state, ctx, 'road_xfer', execPlayer.id),
            kind: 'choose_option',
            playerId: execPlayer.id,
            title: `${execPlayer.id !== ctx.activatingPlayerId && !isDemand ? 'Share' : 'Dogma'} (ROAD BUILDING)`,
            subtitle: 'If you transfer your top Red card to another player\'s board, you meld that player\'s top Green card.',
            options: [
              ...others.map((opp) => {
                const oppGreen = getTopCard(opp.board.green);
                return {
                  id: `target_${opp.id}`,
                  label: `Transfer ${topRed.name} to ${opp.name}`,
                  description: oppGreen
                    ? `You will meld ${opp.name}'s top Green: ${oppGreen.name} [${oppGreen.age}]`
                    : `${opp.name} currently has no Green card`,
                };
              }),
              {
                id: 'decline',
                label: 'Keep top Red card',
              },
            ],
          });
          return 'awaiting_prompt';
        }
      }
      return 'completed';
    }

    case 'road_building_transfer': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) {
        throw new Error('Must choose an option.');
      }
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, execPlayer.id, isDemand, 'Chose not to transfer top Red card.');
        return 'completed';
      }
      if (!action.selectedOptionId.startsWith('target_')) {
        throw new Error(`Invalid option: ${action.selectedOptionId}`);
      }
      const targetId = action.selectedOptionId.slice('target_'.length);
      const targetPlayer = getPlayer(state, targetId);
      const topRed = getTopCard(execPlayer.board.red);
      if (topRed) {
        transferCard(
          state,
          { zone: 'board', playerId: execPlayer.id, color: 'red' },
          { zone: 'board', playerId: targetPlayer.id },
          topRed.instanceId
        );
        recordChange(ctx, execPlayer.id, isDemand, true);
        const oppGreen = getTopCard(targetPlayer.board.green);
        if (oppGreen) {
          const greenCard = removeTopCardFromBoard(targetPlayer, 'green');
          meldCardInstance(state, execPlayer.id, greenCard);
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Transferred ${topRed.name} to ${targetPlayer.name}'s board and melded their top Green (${greenCard.name} [${greenCard.age}]).`
          );
        } else {
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Transferred ${topRed.name} to ${targetPlayer.name}'s board (${targetPlayer.name} had no Green card).`
          );
        }
      }
      return 'completed';
    }

    case 'canal_choice': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) {
        throw new Error('Must select a Canal Building option.');
      }
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, execPlayer.id, isDemand, 'Chose to do nothing.');
        return 'completed';
      }
      if (action.selectedOptionId === 'junk3') {
        const junkedCount = junkDeck(state, 3);
        recordChange(ctx, execPlayer.id, isDemand, junkedCount > 0);
        logStep(state, ctx, execPlayer.id, isDemand, `Junked ${junkedCount} card(s) from [3] deck.`);
        return 'completed';
      }
      if (action.selectedOptionId === 'exchange') {
        const maxHand = execPlayer.hand.length > 0 ? Math.max(...execPlayer.hand.map((c) => c.age)) : 0;
        const highHandIds = execPlayer.hand.filter((c) => c.age === maxHand).map((c) => c.instanceId);
        const maxScore = execPlayer.scorePile.length > 0 ? Math.max(...execPlayer.scorePile.map((c) => c.age)) : 0;
        const highScoreIds = execPlayer.scorePile.filter((c) => c.age === maxScore).map((c) => c.instanceId);

        if (highHandIds.length + highScoreIds.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Exchanged 0 cards (Hand & Score empty).');
          return 'completed';
        }
        exchangeCards(
          state,
          { zone: 'hand', playerId: execPlayer.id },
          highHandIds,
          { zone: 'score', playerId: execPlayer.id },
          highScoreIds
        );
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Exchanged ${highHandIds.length} highest hand card(s) [${maxHand || '-'}] with ${highScoreIds.length} highest score card(s) [${maxScore || '-'}].`
        );
        return 'completed';
      }
      throw new Error(`Invalid Canal Building option: ${action.selectedOptionId}`);
    }

    case 'fermenting_tuck': {
      if (selectedIds.length === 0) {
        applyFermentingFallback(state, ctx, execPlayer, isDemand);
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      tuckCardInstance(state, execPlayer.id, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Tucked Green card (${card.name} [${card.age}]).`);
      return 'completed';
    }

    case 'currency_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return any cards.');
        return 'completed';
      }
      const distinctAges = new Set<number>();
      for (const cid of selectedIds) {
        const card = removeCardFromHand(execPlayer, cid);
        distinctAges.add(card.age);
        returnCardInstance(state, card);
      }
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawn: number[] = [];
      for (let i = 0; i < distinctAges.size; i++) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'score');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.drawnFromAge) drawn.push(drawRes.drawnFromAge);
      }
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${selectedIds.length} card(s) (${distinctAges.size} distinct value(s)) and scored ${drawn.map((a) => `[${a}]`).join(', ')}.`
      );
      return 'completed';
    }

    case 'mapmaking_pick': {
      const moved = transferCard(
        state,
        { zone: 'score', playerId: execPlayer.id },
        { zone: 'score', playerId: ctx.activatingPlayerId },
        selectedIds[0]
      );
      recordDemandTransfer(ctx, ability.index);
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred ${moved.name} [1] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
      );
      return 'completed';
    }

    case 'math_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to return a card.');
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      const drawRes = drawCardFromAge(state, execPlayer.id, card.age + 1, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${card.name} [${card.age}] and drew & melded ${drawRes.card?.name ?? ''} [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'monotheism_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      transferCard(
        state,
        { zone: 'board', playerId: execPlayer.id, color: target.color },
        { zone: 'score', playerId: actPlayer.id },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, execPlayer.id, 1, 'tuck');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred ${target.name} [${target.age}] to ${actPlayer.name}'s score pile and tucked [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'philosophy_score': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Declined to score a card.');
        return 'completed';
      }
      const card = removeCardFromHand(execPlayer, selectedIds[0]);
      scoreCardInstance(state, execPlayer.id, card);
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Scored ${card.name} [${card.age}] from hand.`);
      return 'completed';
    }

    default: {
      if (phase) {
        const res3to5 = resolvePromptAges3to5(
          state,
          ctx,
          prompt,
          action,
          phase,
          prevSubState,
          execPlayer,
          ability,
          isDemand
        );
        if (res3to5 !== null) return res3to5;

        const res6to8 = resolvePromptAges6to8(
          state,
          ctx,
          prompt,
          action,
          phase,
          prevSubState,
          execPlayer,
          ability,
          isDemand
        );
        if (res6to8 !== null) return res6to8;

        const res9to11 = resolvePromptAges9to11(
          state,
          ctx,
          prompt,
          action,
          phase,
          prevSubState,
          execPlayer,
          ability,
          isDemand
        );
        if (res9to11 !== null) return res9to11;
      }
      throw new Error(`Unhandled Dogma prompt phase: ${phase}`);
    }
  }
}
