import { ALL_AGES, ALL_COLORS, SPECIAL_ACHIEVEMENTS } from './constants';
import {
  applyMultiZoneWithOrderCheck,
  clearBoardColor,
  countColorsWithIcon,
  drawMultiple,
  getSingleExtremePlayer,
  getTagPrefix,
  logStep,
  makePromptId,
  pickTopKWithTieSplit,
  promptSplayColor,
  recordChange,
  recordDemandReturn,
  recordPlayerReturn,
  removeScoreCardsByAge,
  type DogmaStepOutcome,
} from './dogmaHelpers';
import {
  computeScoreTotal,
  drawCardFromAge,
  exchangeCards,
  getJunkedSpecialAchievements,
  getOpponents,
  getPlayer,
  junkDeck,
  junkSpecialAchievement,
  junkStandardAchievementByAge,
  meldCardInstance,
  removeBottomCardFromBoard,
  removeCardFromHand,
  removeCardFromScore,
  removeTopCardFromBoard,
  resolveCardEffectVictory,
  returnCardInstance,
  scoreCardInstance,
  splayPlayerColor,
  transferCard,
  tuckCardInstance,
  unsplayPlayerColor,
} from './keywords';
import {
  cardHasIcon,
  getTopCard,
  getTopCards,
  getVisibleIconCounts,
} from './splay';
import type {
  Age,
  CardAbility,
  CardColor,
  CardInstance,
  DogmaExecutionContext,
  GameState,
  PlayerState,
  SpecialAchievementId,
  TurnAction,
} from './types';

function executeClassificationColor(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  chosenColor: CardColor
): DogmaStepOutcome {
  let stolenCount = 0;
  for (const opp of getOpponents(state, execPlayer.id)) {
    const matching = opp.hand.filter((c) => c.color === chosenColor);
    for (const c of matching) {
      transferCard(
        state,
        { zone: 'hand', playerId: opp.id },
        { zone: 'hand', playerId: execPlayer.id },
        c.instanceId
      );
      stolenCount += 1;
    }
  }
  const toMeld = execPlayer.hand.filter((c) => c.color === chosenColor);
  for (const c of toMeld) {
    removeCardFromHand(execPlayer, c.instanceId);
  }
  logStep(
    state,
    ctx,
    execPlayer.id,
    isDemand,
    `Revealed ${chosenColor}; transferred ${stolenCount} ${chosenColor} card(s) from opponents' hands.`
  );
  return applyMultiZoneWithOrderCheck(state, ctx, execPlayer, isDemand, toMeld, 'meld', 'CLASSIFICATION');
}

function finishSanitationExchange(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  victimCardIds: string[],
  attackerCardId: string | null
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  const aIds = attackerCardId ? [attackerCardId] : [];
  exchangeCards(
    state,
    { zone: 'hand', playerId: victim.id },
    victimCardIds,
    { zone: 'hand', playerId: actPlayer.id },
    aIds
  );
  logStep(
    state,
    ctx,
    victim.id,
    true,
    `Exchanged ${victimCardIds.length} highest hand card(s) with ${actPlayer.name}'s ${aIds.length} lowest hand card.`
  );
  return 'completed';
}

function resolveSanitationAttackerSide(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  victimCardIds: string[],
  ability: CardAbility
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  if (actPlayer.hand.length === 0) {
    return finishSanitationExchange(state, ctx, victim, victimCardIds, null);
  }
  const minAct = Math.min(...actPlayer.hand.map((c) => c.age));
  const lowAct = actPlayer.hand.filter((c) => c.age === minAct);
  if (lowAct.length === 1) {
    return finishSanitationExchange(state, ctx, victim, victimCardIds, lowAct[0].instanceId);
  }
  const tempCards = victimCardIds
    .map((id) => victim.hand.find((c) => c.instanceId === id))
    .filter((c): c is CardInstance => Boolean(c));
  ctx.subState = { phase: 'sanitation_attacker_pick', tempCards };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'sanit_a', actPlayer.id),
    kind: 'choose_cards',
    playerId: actPlayer.id,
    title: `SANITATION: ${actPlayer.name}'s hand`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: lowAct,
    sourceLabel: 'Lowest cards in your hand',
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function executeSkyscrapersOnTarget(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  target: CardInstance
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  transferCard(
    state,
    { zone: 'board', playerId: victim.id, color: target.color },
    { zone: 'board', playerId: actPlayer.id },
    target.instanceId
  );
  let scoredName = 'none';
  if (victim.board[target.color].cards.length > 0) {
    const sc = removeTopCardFromBoard(victim, target.color);
    scoreCardInstance(state, victim.id, sc);
    scoredName = `${sc.name} [${sc.age}]`;
  }
  const returnedCount = clearBoardColor(state, victim, target.color);
  let tookSkyscrapers = false;
  for (const p of state.players) {
    if (p.eliminated) continue;
    const topYellow = getTopCard(p.board.yellow);
    if (topYellow && topYellow.defId === 'B079') {
      transferCard(
        state,
        { zone: 'board', playerId: p.id, color: 'yellow' },
        { zone: 'hand', playerId: actPlayer.id },
        topYellow.instanceId
      );
      tookSkyscrapers = true;
      break;
    }
  }
  logStep(
    state,
    ctx,
    victim.id,
    true,
    `Transferred ${target.name} to ${actPlayer.name}'s board; scored ${scoredName}; returned ${returnedCount} ${target.color} card(s)${
      tookSkyscrapers ? `; transferred Skyscrapers to ${actPlayer.name}'s hand` : ''
    }.`
  );
  return 'completed';
}

function advanceRocketryStep(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  remainingCount: number,
  ability: CardAbility
): DogmaStepOutcome {
  while (remainingCount > 0) {
    const opps = getOpponents(state, execPlayer.id);
    const pairOptions: Array<{ id: string; label: string; oppId: string; age: Age }> = [];
    for (const opp of opps) {
      const countsByAge = new Map<Age, number>();
      for (const c of opp.scorePile) {
        countsByAge.set(c.age, (countsByAge.get(c.age) ?? 0) + 1);
      }
      const ages = Array.from(countsByAge.keys()).sort((a, b) => a - b);
      for (const age of ages) {
        const cnt = countsByAge.get(age)!;
        pairOptions.push({
          id: `${opp.id}::${age}`,
          label: `${opp.name}: Score card [${age}] (×${cnt})`,
          oppId: opp.id,
          age,
        });
      }
    }
    if (pairOptions.length === 0) {
      logStep(state, ctx, execPlayer.id, isDemand, 'All opponents score piles empty.');
      return 'completed';
    }
    if (pairOptions.length === 1) {
      const only = pairOptions[0];
      const opp = getPlayer(state, only.oppId);
      const card = opp.scorePile.find((c) => c.age === only.age)!;
      const removed = removeCardFromScore(opp, card.instanceId);
      returnCardInstance(state, removed);
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Returned a [${only.age}] from ${opp.name}'s score pile.`);
      remainingCount -= 1;
      continue;
    }
    ctx.subState = { phase: 'rocketry_pick', remainingCount };
    state.pendingPrompts.push({
      id: makePromptId(state, ctx, `rock_${remainingCount}`, execPlayer.id),
      kind: 'choose_option',
      playerId: execPlayer.id,
      title: `${getTagPrefix(ctx, execPlayer.id, isDemand)} (ROCKETRY) (${remainingCount} left)`,
      subtitle: ability.text,
      options: pairOptions.map(({ id, label }) => ({ id, label })),
    });
    return 'awaiting_prompt';
  }
  return 'completed';
}

export function startDogmaStepAges6to8(
  state: GameState,
  ctx: DogmaExecutionContext,
  defId: string,
  cardName: string,
  ability: CardAbility,
  execPlayer: PlayerState,
  isDemand: boolean
): DogmaStepOutcome | null {
  const tagPrefix = getTagPrefix(ctx, execPlayer.id, isDemand);

  switch (defId) {
    // (6) INDUSTRIALIZATION [Red] B056
    case 'B056': {
      if (ability.index === 1) {
        const res = drawMultiple(state, execPlayer.id, 3, 6, 'tuck');
        if (res.gameEnded) return 'gameover';
        if (res.drawn.length > 0) recordChange(ctx, execPlayer.id, isDemand, true);
        const mostClock = getSingleExtremePlayer(
          state,
          (p) => getVisibleIconCounts(p.board).clock,
          'max'
        );
        let returnedRed: string | null = null;
        if (mostClock?.id === execPlayer.id && execPlayer.board.red.cards.length > 0) {
          const r = removeTopCardFromBoard(execPlayer, 'red');
          returnCardInstance(state, r);
          returnedRed = `${r.name} [${r.age}]`;
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Tucked ${res.drawn.map((c) => c.name).join(', ')}${
            returnedRed ? ` and returned top Red (${returnedRed}; single most Clock)` : ''
          }.`
        );
        return 'completed';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['red', 'purple']);
    }

    // (6) MACHINE TOOLS [Red] B057
    case 'B057': {
      const maxS = execPlayer.scorePile.length > 0 ? Math.max(...execPlayer.scorePile.map((c) => c.age)) : 0;
      const drawRes = drawCardFromAge(state, execPlayer.id, Math.max(1, maxS), 'score');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & scored [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (6) CANNING [Yellow] B058
    case 'B058': {
      if (ability.index === 1) {
        ctx.subState = { phase: 'canning_confirm' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'can', execPlayer.id),
          kind: 'choose_yes_no',
          playerId: execPlayer.id,
          title: `${tagPrefix} (CANNING)`,
          subtitle: ability.text,
          confirmLabel: 'Draw & Tuck [6]',
          declineLabel: 'Decline',
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['yellow']);
    }

    // (6) VACCINATION [Yellow] B059
    case 'B059': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Score pile empty.');
          return 'completed';
        }
        const ages = new Set(execPlayer.scorePile.map((c) => c.age));
        if (ages.size === 1) {
          const val = Array.from(ages)[0];
          const removed = removeScoreCardsByAge(execPlayer, val);
          for (const c of removed) returnCardInstance(state, c);
          recordDemandReturn(ctx, 1);
          const drawRes = drawCardFromAge(state, execPlayer.id, 6, 'meld');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Returned ${removed.length} score card(s) of value [${val}] and drew & melded ${drawRes.card?.name ?? '[6]'}.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'vaccination_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'vacc', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (VACCINATION)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: execPlayer.scorePile,
          sourceLabel: 'Your Score Pile',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (!ctx.demandReturnedByAbility?.[1]) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Skipped [7] draw & meld (nothing returned on demand).');
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 7, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      }
      return 'completed';
    }

    // (6) CLASSIFICATION [Green] B060
    case 'B060': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (nothing to reveal).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        state.revealedCardIds.push(execPlayer.hand[0].instanceId);
        return executeClassificationColor(state, ctx, execPlayer, isDemand, execPlayer.hand[0].color);
      }
      ctx.subState = { phase: 'classification_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'class', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CLASSIFICATION)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (choose color to take & meld)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (6) METRIC SYSTEM [Green] B061
    case 'B061': {
      if (ability.index === 1) {
        if (execPlayer.board.green.splay !== 'right') {
          logStep(state, ctx, execPlayer.id, isDemand, 'Green is not splayed right.');
          return 'completed';
        }
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName);
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['green']);
    }

    // (6) ATOMIC THEORY [Blue] B062
    case 'B062': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['blue']);
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 7, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      }
      return 'completed';
    }

    // (6) ENCYCLOPEDIA [Blue] B063
    case 'B063': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Score pile empty.');
          return 'completed';
        }
        const distinctAges = Array.from(new Set(execPlayer.scorePile.map((c) => c.age))).sort(
          (a, b) => a - b
        );
        ctx.subState = { phase: 'encyclopedia_meld_val' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'encyc_m', execPlayer.id),
          kind: 'choose_option',
          playerId: execPlayer.id,
          title: `${tagPrefix} (ENCYCLOPEDIA)`,
          subtitle: ability.text,
          options: [
            ...distinctAges.map((age) => {
              const count = execPlayer.scorePile.filter((c) => c.age === age).length;
              return {
                id: `age_${age}`,
                label: `Meld all [${age}] (${count} card${count > 1 ? 's' : ''})`,
              };
            }),
            { id: 'decline', label: 'Meld Nothing' },
          ],
        });
        return 'awaiting_prompt';
      }
      const availAges = ([5, 6, 7] as Age[]).filter((age) =>
        state.standardAchievements.some((c) => c.age === age)
      );
      if (availAges.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No available achievement of value 5, 6, or 7 to junk.');
        return 'completed';
      }
      ctx.subState = { phase: 'encyclopedia_junk' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'encyc_j', execPlayer.id),
        kind: 'choose_option',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ENCYCLOPEDIA)`,
        subtitle: ability.text,
        options: [
          ...availAges.map((age) => ({ id: `junk_${age}`, label: `Junk [${age}] Achievement` })),
          { id: 'decline', label: 'Junk Nothing' },
        ],
      });
      return 'awaiting_prompt';
    }

    // (6) DEMOCRACY [Purple] B064
    case 'B064': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (returned 0 cards).');
        return 'completed';
      }
      ctx.subState = { phase: 'democracy_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'democ', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (DEMOCRACY)`,
        subtitle: ability.text,
        min: 0,
        max: execPlayer.hand.length,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (scores [8] if strictly more than any opponent returned)',
        allowSkip: true,
        skipLabel: 'Return None',
      });
      return 'awaiting_prompt';
    }

    // (6) EMANCIPATION [Purple] B065
    case 'B065': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Hand empty.');
          return 'completed';
        }
        if (execPlayer.hand.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'hand', playerId: execPlayer.id },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            execPlayer.hand[0].instanceId
          );
          const drawRes = drawCardFromAge(state, execPlayer.id, 6, 'hand');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'emancipation_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'eman', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (EMANCIPATION)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['red', 'purple']);
    }

    // (7) COMBUSTION [Red] B066
    case 'B066': {
      if (ability.index === 1) {
        const actPlayer = getPlayer(state, ctx.activatingPlayerId);
        const coinColors = countColorsWithIcon(actPlayer.board, 'coin');
        const count = Math.min(coinColors, execPlayer.scorePile.length);
        if (count === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Transferred 0 cards.');
          return 'completed';
        }
        if (execPlayer.scorePile.length <= count) {
          const names: string[] = [];
          while (execPlayer.scorePile.length > 0) {
            const c = transferCard(
              state,
              { zone: 'score', playerId: execPlayer.id },
              { zone: 'score', playerId: actPlayer.id },
              execPlayer.scorePile[0].instanceId
            );
            names.push(`[${c.age}]`);
          }
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${names.join(', ')} to ${actPlayer.name}'s score pile.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'combustion_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'comb', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (COMBUSTION)`,
          subtitle: ability.text,
          min: count,
          max: count,
          candidates: execPlayer.scorePile,
          sourceLabel: `Your Score Pile (choose ${count})`,
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (execPlayer.board.red.cards.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No Red card on board to return.');
        return 'completed';
      }
      const bottom = removeBottomCardFromBoard(execPlayer, 'red');
      returnCardInstance(state, bottom);
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Returned bottom Red card (${bottom.name} [${bottom.age}]).`);
      return 'completed';
    }

    // (7) EXPLOSIVES [Red] B067
    case 'B067': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'Hand empty.');
        return 'completed';
      }
      const { auto, tied, needFromTied } = pickTopKWithTieSplit(execPlayer.hand, 3);
      if (needFromTied === 0) {
        for (const c of auto) {
          transferCard(
            state,
            { zone: 'hand', playerId: execPlayer.id },
            { zone: 'hand', playerId: ctx.activatingPlayerId },
            c.instanceId
          );
        }
        let drewMsg = '';
        if (auto.length > 0 && execPlayer.hand.length === 0) {
          const drawRes = drawCardFromAge(state, execPlayer.id, 7, 'hand');
          if (drawRes.gameEnded) return 'gameover';
          drewMsg = ` and drew [${drawRes.drawnFromAge}]`;
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred ${auto.length} highest hand card(s) to ${getPlayer(state, ctx.activatingPlayerId).name}${drewMsg}.`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'explosives_pick', tempCards: auto };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'expl', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (EXPLOSIVES)`,
        subtitle: ability.text,
        min: needFromTied,
        max: needFromTied,
        candidates: tied,
        sourceLabel: `Tied highest cards (${auto.length} higher already selected)`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (7) REFRIGERATION [Yellow] B068
    case 'B068': {
      if (ability.index === 1) {
        if (execPlayer.hand.length <= 1) {
          logStep(state, ctx, execPlayer.id, true, `Has ${execPlayer.hand.length} card in hand (kept all).`);
          return 'completed';
        }
        ctx.subState = { phase: 'refrigeration_keep' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'refrig_k', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (REFRIGERATION): Choose 1 card to KEEP`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: execPlayer.hand,
          sourceLabel: 'Choose 1 card to keep in hand',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to score).');
        return 'completed';
      }
      ctx.subState = { phase: 'refrigeration_score' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'refrig_s', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (REFRIGERATION)`,
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

    // (7) SANITATION [Yellow] B069
    case 'B069': {
      if (ability.index === 1) {
        const { auto, tied, needFromTied } = pickTopKWithTieSplit(execPlayer.hand, 2);
        if (needFromTied === 0) {
          return resolveSanitationAttackerSide(
            state,
            ctx,
            execPlayer,
            auto.map((c) => c.instanceId),
            ability
          );
        }
        ctx.subState = { phase: 'sanitation_victim_pick', tempCards: auto };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'sanit_v', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (SANITATION)`,
          subtitle: ability.text,
          min: needFromTied,
          max: needFromTied,
          candidates: tied,
          sourceLabel: 'Tied highest cards in Hand',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      ctx.subState = { phase: 'sanitation_junk' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'sanit_j', execPlayer.id),
        kind: 'choose_value',
        playerId: execPlayer.id,
        title: `${tagPrefix} (SANITATION)`,
        subtitle: ability.text,
        options: [7, 8],
      });
      return 'awaiting_prompt';
    }

    // (7) BICYCLE [Green] B070
    case 'B070': {
      if (execPlayer.hand.length === 0 && execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand and score pile both empty.');
        return 'completed';
      }
      ctx.subState = { phase: 'bicycle_confirm' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'bike', execPlayer.id),
        kind: 'choose_yes_no',
        playerId: execPlayer.id,
        title: `${tagPrefix} (BICYCLE)`,
        subtitle: ability.text,
        confirmLabel: 'Exchange Hand & Score Pile',
        declineLabel: 'Decline',
      });
      return 'awaiting_prompt';
    }

    // (7) ELECTRICITY [Green] B071
    case 'B071': {
      const noFactoryTops = getTopCards(execPlayer.board).filter((c) => !cardHasIcon(c, 'factory'));
      if (noFactoryTops.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No top card without Factory to return.');
        return 'completed';
      }
      const names: string[] = [];
      for (const c of noFactoryTops) {
        const rem = removeTopCardFromBoard(execPlayer, c.color);
        returnCardInstance(state, rem);
        names.push(`${rem.name} [${rem.age}]`);
      }
      recordChange(ctx, execPlayer.id, isDemand, true);
      const res = drawMultiple(state, execPlayer.id, noFactoryTops.length, 8, 'hand');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Returned ${names.join(', ')} and drew ${res.drawn.length} [8].`
      );
      return 'completed';
    }

    // (7) EVOLUTION [Blue] B072
    case 'B072': {
      const maxS = execPlayer.scorePile.length > 0 ? Math.max(...execPlayer.scorePile.map((c) => c.age)) : 0;
      ctx.subState = { phase: 'evolution_choice' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'evol', execPlayer.id),
        kind: 'choose_option',
        playerId: execPlayer.id,
        title: `${tagPrefix} (EVOLUTION)`,
        subtitle: ability.text,
        options: [
          {
            id: 'score_8_return',
            label: 'Draw & score [8], then return 1 score card',
          },
          {
            id: 'draw_plus_1',
            label: `Draw a [${Math.min(11, maxS + 1)}]`,
          },
          { id: 'decline', label: 'Do nothing' },
        ],
      });
      return 'awaiting_prompt';
    }

    // (7) PUBLICATIONS [Blue] B073
    case 'B073': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['yellow', 'blue']);
      }
      const avail = [...state.availableSpecialAchievements];
      const junked = getJunkedSpecialAchievements(state);
      if (avail.length === 0 && junked.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No available or junked special achievements to move.');
        return 'completed';
      }
      ctx.subState = { phase: 'publications_special' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'pubs', execPlayer.id),
        kind: 'choose_option',
        playerId: execPlayer.id,
        title: `${tagPrefix} (PUBLICATIONS)`,
        subtitle: ability.text,
        options: [
          ...avail.map((id) => ({
            id: `junk_${id}`,
            label: `Junk ${SPECIAL_ACHIEVEMENTS[id].name}`,
          })),
          ...junked.map((id) => ({
            id: `restore_${id}`,
            label: `Restore ${SPECIAL_ACHIEVEMENTS[id].name} from Junk`,
          })),
          { id: 'decline', label: 'Do nothing' },
        ],
      });
      return 'awaiting_prompt';
    }

    // (7) LIGHTING [Purple] B074
    case 'B074': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no cards to tuck).');
        return 'completed';
      }
      const maxPick = Math.min(3, execPlayer.hand.length);
      ctx.subState = { phase: 'lighting_tuck' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'light', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (LIGHTING)`,
        subtitle: ability.text,
        min: 0,
        max: maxPick,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (scores [7] per distinct value tucked)',
        allowSkip: true,
        skipLabel: 'Tuck Nothing',
      });
      return 'awaiting_prompt';
    }

    // (7) RAILROAD [Purple] B075
    case 'B075': {
      if (ability.index === 1) {
        const retCount = execPlayer.hand.length;
        for (const c of [...execPlayer.hand]) {
          returnCardInstance(state, removeCardFromHand(execPlayer, c.instanceId));
        }
        recordChange(ctx, execPlayer.id, isDemand, retCount > 0);
        logStep(state, ctx, execPlayer.id, isDemand, `Returned all ${retCount} card(s) from hand.`);
        return 'completed';
      }
      if (ability.index === 2) {
        const res = drawMultiple(state, execPlayer.id, 3, 6, 'hand');
        if (res.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, res.drawn.length > 0);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew ${res.drawn.map((c) => `[${c.age}]`).join(', ')}.`);
        return 'completed';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ALL_COLORS, 'right');
    }

    // (8) FLIGHT [Red] B076
    case 'B076': {
      if (ability.index === 1) {
        if (execPlayer.board.red.splay !== 'up') {
          logStep(state, ctx, execPlayer.id, isDemand, 'Red is not splayed up.');
          return 'completed';
        }
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName);
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['red']);
    }

    // (8) MOBILITY [Red] B077
    case 'B077': {
      const eligible = getTopCards(execPlayer.board).filter(
        (c) => c.color !== 'red' && !cardHasIcon(c, 'factory')
      );
      if (eligible.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No qualifying non-red top card without Factory.');
        return 'completed';
      }
      const { auto, tied, needFromTied } = pickTopKWithTieSplit(eligible, 2);
      if (needFromTied === 0) {
        for (const c of auto) {
          transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: c.color },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            c.instanceId
          );
        }
        const drawRes = drawCardFromAge(state, execPlayer.id, 8, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred ${auto.map((c) => c.name).join(', ')} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'mobility_pick', tempCards: auto };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'mob', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (MOBILITY)`,
        subtitle: ability.text,
        min: needFromTied,
        max: needFromTied,
        candidates: tied,
        sourceLabel: 'Tied highest non-red top cards without Factory',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (8) ANTIBIOTICS [Yellow] B078
    case 'B078': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty.');
        return 'completed';
      }
      const maxPick = Math.min(3, execPlayer.hand.length);
      ctx.subState = { phase: 'antibiotics_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'anti', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ANTIBIOTICS)`,
        subtitle: ability.text,
        min: 0,
        max: maxPick,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (draws two [8] per distinct value)',
        allowSkip: true,
        skipLabel: 'Return Nothing',
      });
      return 'awaiting_prompt';
    }

    // (8) SKYSCRAPERS [Yellow] B079
    case 'B079': {
      const eligible = getTopCards(execPlayer.board).filter(
        (c) => c.color !== 'yellow' && cardHasIcon(c, 'clock')
      );
      if (eligible.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No top non-yellow card with Clock on board.');
        return 'completed';
      }
      if (eligible.length === 1) {
        return executeSkyscrapersOnTarget(state, ctx, execPlayer, eligible[0]);
      }
      ctx.subState = { phase: 'skyscrapers_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'sky', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (SKYSCRAPERS)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: eligible,
        sourceLabel: 'Top non-yellow cards with Clock',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (8) CORPORATIONS [Green] B080
    case 'B080': {
      if (ability.index === 1) {
        const eligible = getTopCards(execPlayer.board).filter(
          (c) => c.color !== 'green' && cardHasIcon(c, 'factory')
        );
        if (eligible.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top non-green card with Factory on board.');
          return 'completed';
        }
        if (eligible.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: eligible[0].color },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            eligible[0].instanceId
          );
          const drawRes = drawCardFromAge(state, execPlayer.id, 8, 'meld');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and melded ${drawRes.card?.name ?? '[8]'}.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'corporations_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'corp', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (CORPORATIONS)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligible,
          sourceLabel: 'Top non-green cards with Factory',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 8, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      }
      return 'completed';
    }

    // (8) MASS MEDIA [Green] B081
    case 'B081': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to return).');
          return 'completed';
        }
        ctx.subState = { phase: 'mass_media_return' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'mass_r', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (MASS MEDIA)`,
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
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['purple']);
    }

    // (8) QUANTUM THEORY [Blue] B082
    case 'B082': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty.');
        return 'completed';
      }
      const maxPick = Math.min(2, execPlayer.hand.length);
      ctx.subState = { phase: 'quantum_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'quant', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (QUANTUM THEORY)`,
        subtitle: ability.text,
        min: 0,
        max: maxPick,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (return 2 to draw [10] + draw & score [10])',
        allowSkip: true,
        skipLabel: 'Return Nothing',
      });
      return 'awaiting_prompt';
    }

    // (8) ROCKETRY [Blue] B083
    case 'B083': {
      const clockColors = countColorsWithIcon(execPlayer.board, 'clock');
      if (clockColors === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No board color has Clock.');
        return 'completed';
      }
      return advanceRocketryStep(state, ctx, execPlayer, isDemand, clockColors, ability);
    }

    // (8) EMPIRICISM [Purple] B084
    case 'B084': {
      if (ability.index === 1) {
        ctx.subState = { phase: 'empiricism_c1' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'emp_c1', execPlayer.id),
          kind: 'choose_color',
          playerId: execPlayer.id,
          title: `${tagPrefix} (EMPIRICISM): First color`,
          subtitle: ability.text,
          options: [...ALL_COLORS],
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const bulbCount = getVisibleIconCounts(execPlayer.board).lightbulb;
      if (bulbCount >= 20) {
        resolveCardEffectVictory(
          state,
          [execPlayer.id],
          `${execPlayer.name} wins via Empiricism (${bulbCount} Lightbulb icons)!`
        );
        return 'gameover';
      }
      logStep(state, ctx, execPlayer.id, isDemand, `Has ${bulbCount}/20 Lightbulb icons.`);
      return 'completed';
    }

    // (8) SOCIALISM [Purple] B085
    case 'B085': {
      if (ability.index === 1) {
        const tops = getTopCards(execPlayer.board);
        if (tops.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No top cards on board to tuck.');
          return 'completed';
        }
        ctx.subState = { phase: 'socialism_tuck' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'soc_t', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (SOCIALISM)`,
          subtitle: ability.text,
          min: 0,
          max: 1,
          candidates: tops,
          sourceLabel: 'Your top cards on board',
          allowSkip: true,
          skipLabel: 'Tuck Nothing',
        });
        return 'awaiting_prompt';
      }
      const availAges = ([8, 9, 10] as Age[]).filter((age) =>
        state.standardAchievements.some((c) => c.age === age)
      );
      if (availAges.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No available achievement of value 8, 9, or 10 to junk.');
        return 'completed';
      }
      ctx.subState = { phase: 'socialism_junk' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'soc_j', execPlayer.id),
        kind: 'choose_option',
        playerId: execPlayer.id,
        title: `${tagPrefix} (SOCIALISM)`,
        subtitle: ability.text,
        options: [
          ...availAges.map((age) => ({ id: `junk_${age}`, label: `Junk [${age}] Achievement` })),
          { id: 'decline', label: 'Junk Nothing' },
        ],
      });
      return 'awaiting_prompt';
    }

    default:
      return null;
  }
}

export function resolvePromptAges6to8(
  state: GameState,
  ctx: DogmaExecutionContext,
  prompt: NonNullable<GameState['pendingPrompts'][number]>,
  action: Extract<TurnAction, { type: 'answer_prompt' }>,
  phase: string,
  prevSubState: NonNullable<DogmaExecutionContext['subState']> | null | undefined,
  stepExecPlayer: PlayerState,
  ability: CardAbility,
  isDemand: boolean
): DogmaStepOutcome | null {
  const selectedIds = action.selectedCardIds ?? [];
  const isSharing = stepExecPlayer.id !== ctx.activatingPlayerId && !isDemand;

  switch (phase) {
    case 'canning_confirm': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to draw and tuck a [6].');
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 6, 'tuck');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const noFactory = getTopCards(stepExecPlayer.board).filter((c) => !cardHasIcon(c, 'factory'));
      const scoredNames: string[] = [];
      for (const c of noFactory) {
        const removed = removeTopCardFromBoard(stepExecPlayer, c.color);
        scoreCardInstance(state, stepExecPlayer.id, removed);
        scoredNames.push(`${removed.name} [${removed.age}]`);
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Tucked ${drawRes.card.name} [${drawRes.card.age}] and scored top card(s) without Factory: ${
          scoredNames.join(', ') || 'none'
        }.`
      );
      return 'completed';
    }

    case 'vaccination_pick': {
      const picked = stepExecPlayer.scorePile.find((c) => c.instanceId === selectedIds[0])!;
      const removed = removeScoreCardsByAge(stepExecPlayer, picked.age);
      for (const c of removed) returnCardInstance(state, c);
      recordDemandReturn(ctx, ability.index);
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 6, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Returned ${removed.length} score card(s) of value [${picked.age}] and drew & melded ${drawRes.card?.name ?? '[6]'}.`
      );
      return 'completed';
    }

    case 'classification_pick': {
      const picked = stepExecPlayer.hand.find((c) => c.instanceId === selectedIds[0])!;
      state.revealedCardIds.push(picked.instanceId);
      return executeClassificationColor(state, ctx, stepExecPlayer, isDemand, picked.color);
    }

    case 'encyclopedia_meld_val': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an option.');
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to meld cards from score pile.');
        return 'completed';
      }
      const val = Number(action.selectedOptionId.slice('age_'.length)) as Age;
      const toMeld = removeScoreCardsByAge(stepExecPlayer, val);
      return applyMultiZoneWithOrderCheck(state, ctx, stepExecPlayer, isDemand, toMeld, 'meld', 'ENCYCLOPEDIA');
    }

    case 'encyclopedia_junk':
    case 'socialism_junk': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an option.');
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to junk an achievement.');
        return 'completed';
      }
      const val = Number(action.selectedOptionId.slice('junk_'.length)) as Age;
      const junked = junkStandardAchievementByAge(state, val);
      if (junked) {
        recordChange(ctx, stepExecPlayer.id, isDemand, true);
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked Standard Achievement [${val}].`);
      }
      return 'completed';
    }

    case 'democracy_return': {
      const retNames: string[] = [];
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        returnCardInstance(state, c);
        retNames.push(`${c.name} [${c.age}]`);
      }
      if (retNames.length > 0) recordChange(ctx, stepExecPlayer.id, isDemand, true);
      recordPlayerReturn(ctx, stepExecPlayer.id, retNames.length);
      const myCount = ctx.returnedByPlayer?.[stepExecPlayer.id] ?? 0;
      const opps = getOpponents(state, stepExecPlayer.id);
      const maxOpp = opps.reduce((m, o) => Math.max(m, ctx.returnedByPlayer?.[o.id] ?? 0), 0);
      let scoredMsg = '';
      if (myCount > maxOpp) {
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, 8, 'score');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, stepExecPlayer.id, isDemand, true);
        scoredMsg = ` and drew & scored [${drawRes.drawnFromAge}] (${myCount} > ${maxOpp})`;
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned ${retNames.length} card(s)${scoredMsg}.`
      );
      return 'completed';
    }

    case 'emancipation_pick': {
      const moved = transferCard(
        state,
        { zone: 'hand', playerId: stepExecPlayer.id },
        { zone: 'score', playerId: ctx.activatingPlayerId },
        selectedIds[0]
      );
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 6, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'combustion_pick': {
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const ages: string[] = [];
      for (const cid of selectedIds) {
        const moved = transferCard(
          state,
          { zone: 'score', playerId: stepExecPlayer.id },
          { zone: 'score', playerId: actPlayer.id },
          cid
        );
        ages.push(`[${moved.age}]`);
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${ages.join(', ')} to ${actPlayer.name}'s score pile.`
      );
      return 'completed';
    }

    case 'explosives_pick': {
      const autoIds = (prevSubState?.tempCards ?? []).map((c) => c.instanceId);
      const allIds = [...autoIds, ...selectedIds];
      for (const cid of allIds) {
        transferCard(
          state,
          { zone: 'hand', playerId: stepExecPlayer.id },
          { zone: 'hand', playerId: ctx.activatingPlayerId },
          cid
        );
      }
      let drewMsg = '';
      if (allIds.length > 0 && stepExecPlayer.hand.length === 0) {
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, 7, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        drewMsg = ` and drew [${drawRes.drawnFromAge}]`;
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${allIds.length} highest hand card(s) to ${getPlayer(state, ctx.activatingPlayerId).name}${drewMsg}.`
      );
      return 'completed';
    }

    case 'refrigeration_keep': {
      const keepId = selectedIds[0];
      const toReturn = stepExecPlayer.hand.filter((c) => c.instanceId !== keepId);
      for (const c of toReturn) {
        removeCardFromHand(stepExecPlayer, c.instanceId);
        returnCardInstance(state, c);
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Kept 1 card in hand and returned ${toReturn.length} card(s).`
      );
      return 'completed';
    }

    case 'refrigeration_score': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to score a card.');
        return 'completed';
      }
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored ${card.name} [${card.age}] from hand.`);
      return 'completed';
    }

    case 'sanitation_victim_pick': {
      const autoIds = (prevSubState?.tempCards ?? []).map((c) => c.instanceId);
      return resolveSanitationAttackerSide(state, ctx, stepExecPlayer, [...autoIds, ...selectedIds], ability);
    }

    case 'sanitation_attacker_pick': {
      const vicIds = (prevSubState?.tempCards ?? []).map((c) => c.instanceId);
      return finishSanitationExchange(state, ctx, stepExecPlayer, vicIds, selectedIds[0]);
    }

    case 'sanitation_junk': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose [7] or [8].');
      }
      const cnt = junkDeck(state, action.selectedValue);
      recordChange(ctx, stepExecPlayer.id, isDemand, cnt > 0);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked ${cnt} card(s) from [${action.selectedValue}] deck.`);
      return 'completed';
    }

    case 'bicycle_confirm': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to exchange hand and score pile.');
        return 'completed';
      }
      const hIds = stepExecPlayer.hand.map((c) => c.instanceId);
      const sIds = stepExecPlayer.scorePile.map((c) => c.instanceId);
      exchangeCards(
        state,
        { zone: 'hand', playerId: stepExecPlayer.id },
        hIds,
        { zone: 'score', playerId: stepExecPlayer.id },
        sIds
      );
      recordChange(ctx, stepExecPlayer.id, isDemand, hIds.length + sIds.length > 0);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Exchanged all ${hIds.length} hand card(s) with all ${sIds.length} score card(s).`
      );
      return 'completed';
    }

    case 'evolution_choice': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an option.');
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined Evolution.');
        return 'completed';
      }
      if (action.selectedOptionId === 'draw_plus_1') {
        const maxS =
          stepExecPlayer.scorePile.length > 0 ? Math.max(...stepExecPlayer.scorePile.map((c) => c.age)) : 0;
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, Math.max(1, maxS + 1), 'hand');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, stepExecPlayer.id, isDemand, Boolean(drawRes.card));
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}].`);
        return 'completed';
      }
      if (action.selectedOptionId === 'score_8_return') {
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, 8, 'score');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, stepExecPlayer.id, isDemand, Boolean(drawRes.card));
        if (stepExecPlayer.scorePile.length === 0) return 'completed';
        if (stepExecPlayer.scorePile.length === 1) {
          const ret = removeCardFromScore(stepExecPlayer, stepExecPlayer.scorePile[0].instanceId);
          returnCardInstance(state, ret);
          logStep(
            state,
            ctx,
            stepExecPlayer.id,
            isDemand,
            `Drew & scored [${drawRes.drawnFromAge}] and returned ${ret.name} [${ret.age}].`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'evolution_return', chosenValue: drawRes.drawnFromAge ?? 8 };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'evol_r', stepExecPlayer.id),
          kind: 'choose_cards',
          playerId: stepExecPlayer.id,
          title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (EVOLUTION): Score pile return`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: stepExecPlayer.scorePile,
          sourceLabel: 'Your Score Pile',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      throw new Error(`Invalid option: ${action.selectedOptionId}`);
    }

    case 'evolution_return': {
      const card = removeCardFromScore(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Drew & scored [${prevSubState?.chosenValue ?? 8}] and returned ${card.name} [${card.age}].`
      );
      return 'completed';
    }

    case 'publications_special': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an option.');
      if (action.selectedOptionId === 'decline') {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to alter special achievements.');
        return 'completed';
      }
      if (action.selectedOptionId.startsWith('junk_')) {
        const id = action.selectedOptionId.slice('junk_'.length) as SpecialAchievementId;
        if (junkSpecialAchievement(state, id)) {
          recordChange(ctx, stepExecPlayer.id, isDemand, true);
          logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked special achievement ${SPECIAL_ACHIEVEMENTS[id].name}.`);
        }
        return 'completed';
      }
      if (action.selectedOptionId.startsWith('restore_')) {
        const id = action.selectedOptionId.slice('restore_'.length) as SpecialAchievementId;
        if (!state.availableSpecialAchievements.includes(id)) {
          state.availableSpecialAchievements.push(id);
          recordChange(ctx, stepExecPlayer.id, isDemand, true);
          logStep(state, ctx, stepExecPlayer.id, isDemand, `Made ${SPECIAL_ACHIEVEMENTS[id].name} available again.`);
        }
        return 'completed';
      }
      throw new Error(`Invalid Publications option: ${action.selectedOptionId}`);
    }

    case 'lighting_tuck': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to tuck cards.');
        return 'completed';
      }
      const ages = new Set<number>();
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        ages.add(c.age);
        tuckCardInstance(state, stepExecPlayer.id, c);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const res = drawMultiple(state, stepExecPlayer.id, ages.size, 7, 'score');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Tucked ${selectedIds.length} card(s) (${ages.size} distinct value(s)) and scored ${res.drawn.length} [7].`
      );
      return 'completed';
    }

    case 'mobility_pick': {
      const auto = prevSubState?.tempCards ?? [];
      const extra = (prompt.kind === 'choose_cards'
        ? selectedIds.map((id) => prompt.candidates.find((c) => c.instanceId === id)!)
        : []);
      const allTargets = [...auto, ...extra];
      for (const c of allTargets) {
        transferCard(
          state,
          { zone: 'board', playerId: stepExecPlayer.id, color: c.color },
          { zone: 'score', playerId: ctx.activatingPlayerId },
          c.instanceId
        );
      }
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 8, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${allTargets.map((c) => c.name).join(', ')} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'antibiotics_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return cards.');
        return 'completed';
      }
      const ages = new Set<number>();
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        ages.add(c.age);
        returnCardInstance(state, c);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const res = drawMultiple(state, stepExecPlayer.id, ages.size * 2, 8, 'hand');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned ${selectedIds.length} card(s) (${ages.size} distinct value(s)) and drew ${res.drawn.length} [8].`
      );
      return 'completed';
    }

    case 'skyscrapers_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      return executeSkyscrapersOnTarget(state, ctx, stepExecPlayer, target);
    }

    case 'corporations_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const moved = transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'score', playerId: ctx.activatingPlayerId },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 8, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile and melded ${drawRes.card?.name ?? '[8]'}.`
      );
      return 'completed';
    }

    case 'mass_media_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return a card.');
        return 'completed';
      }
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      ctx.subState = { phase: 'mass_media_value' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'mass_v', stepExecPlayer.id),
        kind: 'choose_value',
        playerId: stepExecPlayer.id,
        title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (MASS MEDIA): Choose value`,
        subtitle: ability.text,
        options: [...ALL_AGES],
      });
      return 'awaiting_prompt';
    }

    case 'mass_media_value': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !ALL_AGES.includes(action.selectedValue)) {
        throw new Error('Must choose a valid value.');
      }
      const val = action.selectedValue;
      let removedCount = 0;
      for (const p of state.players) {
        if (p.eliminated) continue;
        const removed = removeScoreCardsByAge(p, val);
        for (const c of removed) {
          returnCardInstance(state, c);
          removedCount += 1;
        }
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, removedCount > 0);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Chose [${val}] and returned ${removedCount} card(s) of that value from all score piles.`
      );
      return 'completed';
    }

    case 'quantum_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return cards.');
        return 'completed';
      }
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        returnCardInstance(state, c);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      if (selectedIds.length === 2) {
        const d1 = drawCardFromAge(state, stepExecPlayer.id, 10, 'hand');
        if (d1.gameEnded) return 'gameover';
        const d2 = drawCardFromAge(state, stepExecPlayer.id, 10, 'score');
        if (d2.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Returned 2 cards; drew [${d1.drawnFromAge}] and drew & scored [${d2.drawnFromAge}].`
        );
      } else {
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned 1 card.`);
      }
      return 'completed';
    }

    case 'rocketry_pick': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an option.');
      const [oppId, ageStr] = action.selectedOptionId.split('::');
      const age = Number(ageStr) as Age;
      const opp = getPlayer(state, oppId);
      const card = opp.scorePile.find((c) => c.age === age);
      if (!card) throw new Error('Selected score card no longer available.');
      const removed = removeCardFromScore(opp, card.instanceId);
      returnCardInstance(state, removed);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned a [${age}] from ${opp.name}'s score pile.`);
      const rem = Math.max(0, (prevSubState?.remainingCount ?? 1) - 1);
      return advanceRocketryStep(state, ctx, stepExecPlayer, isDemand, rem, ability);
    }

    case 'empiricism_c1': {
      if (!action.selectedColor) throw new Error('Must choose a color.');
      const remaining = ALL_COLORS.filter((c) => c !== action.selectedColor);
      ctx.subState = { phase: 'empiricism_c2', chosenColors: [action.selectedColor] };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'emp_c2', stepExecPlayer.id),
        kind: 'choose_color',
        playerId: stepExecPlayer.id,
        title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (EMPIRICISM): Second color`,
        subtitle: ability.text,
        options: remaining,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    case 'empiricism_c2': {
      if (!action.selectedColor) throw new Error('Must choose a second color.');
      const chosenColors = [...(prevSubState?.chosenColors ?? []), action.selectedColor];
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 9, 'reveal_hand');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const c = drawRes.card;
      if (chosenColors.includes(c.color)) {
        removeCardFromHand(stepExecPlayer, c.instanceId);
        meldCardInstance(state, stepExecPlayer.id, c);
        splayPlayerColor(
          state,
          stepExecPlayer.id,
          c.color,
          'up',
          isSharing ? 'Share' : 'Dogma',
          ctx.parentLogId
        );
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Chose ${chosenColors.join(' & ')}; drew & revealed ${c.name} (${c.color}) — matched! Melded & splayed ${c.color} up.`
        );
      } else {
        unsplayPlayerColor(state, stepExecPlayer.id, c.color);
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Chose ${chosenColors.join(' & ')}; drew & revealed ${c.name} (${c.color}) — missed! Unsplayed ${c.color}.`
        );
      }
      return 'completed';
    }

    case 'socialism_tuck': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to tuck a top card.');
        return 'completed';
      }
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const topCard = removeTopCardFromBoard(stepExecPlayer, target.color);
      tuckCardInstance(state, stepExecPlayer.id, topCard);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Tucked top ${topCard.name} [${topCard.age}].`);
      const handCards = [...stepExecPlayer.hand].map((c) =>
        removeCardFromHand(stepExecPlayer, c.instanceId)
      );
      return applyMultiZoneWithOrderCheck(state, ctx, stepExecPlayer, isDemand, handCards, 'tuck', 'SOCIALISM');
    }

    default:
      return null;
  }
}
