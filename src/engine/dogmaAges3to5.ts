import { ALL_AGES, ALL_COLORS } from './constants';
import {
  applyMultiZoneWithOrderCheck,
  countColorsWithIcon,
  drawMultiple,
  getTagPrefix,
  logStep,
  makePromptId,
  promptSplayColor,
  recordChange,
  recordDemandTransfer,
  recordRepeatDrawStep,
  transferCardFromHandToZone,
  type DogmaStepOutcome,
} from './dogmaHelpers';
import {
  claimSpecialAchievement,
  computeScoreTotal,
  drawCardFromAge,
  exchangeCards,
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
  returnCardInstance,
  scoreCardInstance,
  splayPlayerColor,
  transferCard,
} from './keywords';
import {
  cardHasIcon,
  getHighestTopCardAge,
  getTopCard,
  getTopCards,
} from './splay';
import type {
  Age,
  CardAbility,
  CardColor,
  CardInstance,
  DogmaExecutionContext,
  GameState,
  PlayerState,
  TurnAction,
} from './types';

function finishOpticsTransfer(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  cardId: string,
  oppId: string
): DogmaStepOutcome {
  const opp = getPlayer(state, oppId);
  const moved = transferCard(
    state,
    { zone: 'score', playerId: execPlayer.id },
    { zone: 'score', playerId: opp.id },
    cardId
  );
  recordChange(ctx, execPlayer.id, isDemand, true);
  logStep(
    state,
    ctx,
    execPlayer.id,
    isDemand,
    `Transferred ${moved.name} [${moved.age}] from score pile to ${opp.name}'s score pile.`
  );
  return 'completed';
}

function finishCompassPart2(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  ability: CardAbility
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  const candidates = getTopCards(actPlayer.board).filter((c) => !cardHasIcon(c, 'leaf'));
  if (candidates.length === 0) {
    logStep(state, ctx, execPlayer.id, true, `No top card without Leaf on ${actPlayer.name}'s board to meld.`);
    return 'completed';
  }
  if (candidates.length === 1) {
    const target = candidates[0];
    const card = removeTopCardFromBoard(actPlayer, target.color);
    meldCardInstance(state, execPlayer.id, card);
    logStep(
      state,
      ctx,
      execPlayer.id,
      true,
      `Melded ${card.name} [${card.age}] from ${actPlayer.name}'s board.`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'compass_meld' };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'compass_m', execPlayer.id),
    kind: 'choose_cards',
    playerId: execPlayer.id,
    title: `Demand (COMPASS): ${actPlayer.name}'s board`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates,
    sourceLabel: `${actPlayer.name}'s top cards without Leaf`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function finishAlchemyScore(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  ability: CardAbility
): DogmaStepOutcome {
  if (execPlayer.hand.length === 0) {
    logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to score).');
    return 'completed';
  }
  if (execPlayer.hand.length === 1) {
    const card = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
    scoreCardInstance(state, execPlayer.id, card);
    recordChange(ctx, execPlayer.id, isDemand, true);
    logStep(state, ctx, execPlayer.id, isDemand, `Scored ${card.name} [${card.age}] from hand.`);
    return 'completed';
  }
  ctx.subState = { phase: 'alchemy_score' };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'alch_s', execPlayer.id),
    kind: 'choose_cards',
    playerId: execPlayer.id,
    title: `${getTagPrefix(ctx, execPlayer.id, isDemand)} (ALCHEMY)`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: execPlayer.hand,
    sourceLabel: 'Your Hand',
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function finishAnatomyBoardReturn(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  returnedAge: Age,
  ability: CardAbility
): DogmaStepOutcome {
  const matching = getTopCards(execPlayer.board).filter((c) => c.age === returnedAge);
  if (matching.length === 0) {
    logStep(state, ctx, execPlayer.id, true, `No top card of value [${returnedAge}] on board to return.`);
    return 'completed';
  }
  if (matching.length === 1) {
    const removed = removeTopCardFromBoard(execPlayer, matching[0].color);
    returnCardInstance(state, removed);
    const junked = junkDeck(state, 4);
    logStep(
      state,
      ctx,
      execPlayer.id,
      true,
      `Returned top ${removed.name} [${removed.age}] and junked ${junked} card(s) from [4] deck.`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'anatomy_board_return', chosenValue: returnedAge };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'anat_b', execPlayer.id),
    kind: 'choose_cards',
    playerId: execPlayer.id,
    title: `Demand (ANATOMY): Board top [${returnedAge}]`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: matching,
    sourceLabel: `Your top Age ${returnedAge} cards`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function executeMedicineExchange(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  victimCardId: string,
  attackerCardId: string | null
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  const vIds = victimCardId ? [victimCardId] : [];
  const aIds = attackerCardId ? [attackerCardId] : [];
  const vCard = victim.scorePile.find((c) => c.instanceId === victimCardId);
  const aCard = actPlayer.scorePile.find((c) => c.instanceId === attackerCardId);
  exchangeCards(
    state,
    { zone: 'score', playerId: victim.id },
    vIds,
    { zone: 'score', playerId: actPlayer.id },
    aIds
  );
  logStep(
    state,
    ctx,
    victim.id,
    true,
    `Exchanged highest score (${vCard ? `[${vCard.age}]` : 'none'}) with ${actPlayer.name}'s lowest score (${
      aCard ? `[${aCard.age}]` : 'none'
    }).`
  );
  return 'completed';
}

export function startDogmaStepAges3to5(
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
    // (3) ENGINEERING [Red] B026
    case 'B026': {
      if (ability.index === 1) {
        const targets = getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, 'tower'));
        if (targets.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top card with Tower on board.');
          return 'completed';
        }
        const names: string[] = [];
        for (const c of targets) {
          transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: c.color },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            c.instanceId
          );
          names.push(`${c.name} [${c.age}]`);
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred top Tower card(s) (${names.join(', ')}) to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
        );
        return 'completed';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'left', cardName, ['red']);
    }

    // (3) OPTICS [Red] B027
    case 'B027': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 3, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      if (cardHasIcon(drawRes.card, 'coin')) {
        const scoreRes = drawCardFromAge(state, execPlayer.id, 4, 'score');
        if (scoreRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & melded ${drawRes.card.name} [${drawRes.card.age}] (has Coin); drew & scored [${scoreRes.drawnFromAge}].`
        );
        return 'completed';
      }
      const myScore = computeScoreTotal(execPlayer);
      const fewerOpps = getOpponents(state, execPlayer.id).filter((o) => computeScoreTotal(o) < myScore);
      if (execPlayer.scorePile.length === 0 || fewerOpps.length === 0) {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & melded ${drawRes.card.name} [${drawRes.card.age}] (no transfer: ${
            execPlayer.scorePile.length === 0 ? 'score pile empty' : 'no opponent with fewer points'
          }).`
        );
        return 'completed';
      }
      if (execPlayer.scorePile.length === 1 && fewerOpps.length === 1) {
        return finishOpticsTransfer(state, ctx, execPlayer, isDemand, execPlayer.scorePile[0].instanceId, fewerOpps[0].id);
      }
      if (execPlayer.scorePile.length === 1) {
        ctx.subState = { phase: 'optics_pick_opp', tempCards: [execPlayer.scorePile[0]] };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'optics_o', execPlayer.id),
          kind: 'choose_option',
          playerId: execPlayer.id,
          title: `${tagPrefix} (OPTICS): Choose opponent`,
          subtitle: ability.text,
          options: fewerOpps.map((o) => ({
            id: o.id,
            label: `${o.name} (${computeScoreTotal(o)} pts)`,
          })),
        });
        return 'awaiting_prompt';
      }
      ctx.subState = { phase: 'optics_pick_card' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'optics_c', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (OPTICS)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.scorePile,
        sourceLabel: 'Your Score Pile',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (3) MACHINERY [Yellow] B028
    case 'B028': {
      if (ability.index === 1) {
        const actPlayer = getPlayer(state, ctx.activatingPlayerId);
        const maxAct = actPlayer.hand.length > 0 ? Math.max(...actPlayer.hand.map((c) => c.age)) : 0;
        const highActIds = actPlayer.hand.filter((c) => c.age === maxAct).map((c) => c.instanceId);
        const vicIds = execPlayer.hand.map((c) => c.instanceId);
        if (vicIds.length + highActIds.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Both hands empty (0 cards exchanged).');
          return 'completed';
        }
        exchangeCards(
          state,
          { zone: 'hand', playerId: execPlayer.id },
          vicIds,
          { zone: 'hand', playerId: actPlayer.id },
          highActIds
        );
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Exchanged entire hand (${vicIds.length}) with ${actPlayer.name}'s ${highActIds.length} highest hand card(s).`
        );
        return 'completed';
      }
      if (ability.index === 2) {
        const towerHand = execPlayer.hand.filter((c) => cardHasIcon(c, 'tower'));
        if (towerHand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No card with Tower in hand to score.');
          return 'completed';
        }
        if (towerHand.length === 1) {
          const card = removeCardFromHand(execPlayer, towerHand[0].instanceId);
          scoreCardInstance(state, execPlayer.id, card);
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Scored ${card.name} [${card.age}] (Tower) from hand.`);
          return 'completed';
        }
        ctx.subState = { phase: 'machinery_score' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'mach_s', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (MACHINERY)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: towerHand,
          sourceLabel: 'Hand cards with Tower',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'left', cardName, ['red']);
    }

    // (3) MEDICINE [Yellow] B029
    case 'B029': {
      if (ability.index === 1) {
        const actPlayer = getPlayer(state, ctx.activatingPlayerId);
        if (execPlayer.scorePile.length === 0 && actPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Both score piles empty (nothing exchanged).');
          return 'completed';
        }
        const vicMax = execPlayer.scorePile.length > 0 ? Math.max(...execPlayer.scorePile.map((c) => c.age)) : 0;
        const vicHigh = execPlayer.scorePile.filter((c) => c.age === vicMax);
        const actMin = actPlayer.scorePile.length > 0 ? Math.min(...actPlayer.scorePile.map((c) => c.age)) : 0;
        const actLow = actPlayer.scorePile.filter((c) => c.age === actMin);

        if (vicHigh.length <= 1 && actLow.length <= 1) {
          return executeMedicineExchange(
            state,
            ctx,
            execPlayer,
            vicHigh[0]?.instanceId ?? '',
            actLow[0]?.instanceId ?? null
          );
        }
        if (vicHigh.length > 1) {
          ctx.subState = { phase: 'medicine_pick_victim' };
          state.pendingPrompts.push({
            id: makePromptId(state, ctx, 'med_v', execPlayer.id),
            kind: 'choose_cards',
            playerId: execPlayer.id,
            title: `Demand (MEDICINE)`,
            subtitle: ability.text,
            min: 1,
            max: 1,
            candidates: vicHigh,
            sourceLabel: 'Highest cards in your score pile',
            allowSkip: false,
          });
          return 'awaiting_prompt';
        }
        // vicHigh.length <= 1 and actLow.length > 1
        ctx.subState = { phase: 'medicine_pick_attacker', tempCards: vicHigh };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'med_a', actPlayer.id),
          kind: 'choose_cards',
          playerId: actPlayer.id,
          title: `MEDICINE: ${actPlayer.name}'s score card`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: actLow,
          sourceLabel: 'Lowest cards in your score pile',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const availAges = ([3, 4] as Age[]).filter((age) =>
        state.standardAchievements.some((c) => c.age === age)
      );
      if (availAges.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No available achievement of value 3 or 4 to junk.');
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
      ctx.subState = { phase: 'medicine_junk' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'med_j', execPlayer.id),
        kind: 'choose_value',
        playerId: execPlayer.id,
        title: `${tagPrefix} (MEDICINE)`,
        subtitle: ability.text,
        options: availAges,
      });
      return 'awaiting_prompt';
    }

    // (3) COMPASS [Green] B030
    case 'B030': {
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const nonGreenLeaf = getTopCards(execPlayer.board).filter(
        (c) => c.color !== 'green' && cardHasIcon(c, 'leaf')
      );
      if (nonGreenLeaf.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No top non-green card with Leaf to transfer.');
        return finishCompassPart2(state, ctx, execPlayer, ability);
      }
      if (nonGreenLeaf.length === 1) {
        const moved = transferCard(
          state,
          { zone: 'board', playerId: execPlayer.id, color: nonGreenLeaf[0].color },
          { zone: 'board', playerId: actPlayer.id },
          nonGreenLeaf[0].instanceId
        );
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred ${moved.name} (${moved.color}) to ${actPlayer.name}'s board.`
        );
        return finishCompassPart2(state, ctx, execPlayer, ability);
      }
      ctx.subState = { phase: 'compass_transfer' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'comp_t', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (COMPASS)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: nonGreenLeaf,
        sourceLabel: 'Top non-green cards with Leaf',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (3) PAPER [Green] B031
    case 'B031': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'left', cardName, ['green', 'blue']);
      }
      const leafTops = getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, 'leaf'));
      if (leafTops.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No top card with Leaf to score.');
        return 'completed';
      }
      if (leafTops.length === 1) {
        const card = removeTopCardFromBoard(execPlayer, leafTops[0].color);
        scoreCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        const leftCount = ALL_COLORS.filter((c) => execPlayer.board[c].splay === 'left').length;
        const res = drawMultiple(state, execPlayer.id, leftCount, 4, 'hand');
        if (res.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Scored top ${card.name} [${card.age}] and drew ${res.drawn.length} [4] (${leftCount} color(s) splayed left).`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'paper_score' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'paper_s', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (PAPER)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: leafTops,
        sourceLabel: 'Your top cards with Leaf',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (3) ALCHEMY [Blue] B032
    case 'B032': {
      if (ability.index === 1) {
        const towerColors = countColorsWithIcon(execPlayer.board, 'tower');
        if (towerColors === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No board color has Tower (drew 0).');
          return 'completed';
        }
        const res = drawMultiple(state, execPlayer.id, towerColors, 4, 'reveal_hand');
        if (res.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, res.drawn.length > 0);
        const hasRed = res.drawn.some((c) => c.color === 'red');
        if (hasRed) {
          const retCount = execPlayer.hand.length;
          for (const c of [...execPlayer.hand]) {
            returnCardInstance(state, removeCardFromHand(execPlayer, c.instanceId));
          }
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Drew & revealed ${res.drawn.map((c) => `${c.name} (${c.color})`).join(', ')} — red drawn! Returned all ${retCount} hand card(s).`
          );
        } else {
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Drew & revealed ${res.drawn.map((c) => `${c.name} [${c.age}]`).join(', ')} (none red).`
          );
        }
        return 'completed';
      }
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (cannot meld or score).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        const card = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
        meldCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Melded ${card.name} [${card.age}] (hand now empty).`);
        return 'completed';
      }
      ctx.subState = { phase: 'alchemy_meld' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'alch_m', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ALCHEMY)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand (choose 1 to meld, then score 1)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (3) TRANSLATION [Blue] B033
    case 'B033': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Score pile empty.');
          return 'completed';
        }
        ctx.subState = { phase: 'translation_confirm' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'trans', execPlayer.id),
          kind: 'choose_yes_no',
          playerId: execPlayer.id,
          title: `${tagPrefix} (TRANSLATION)`,
          subtitle: ability.text,
          confirmLabel: 'Meld All Score Cards',
          declineLabel: 'Decline',
        });
        return 'awaiting_prompt';
      }
      const tops = getTopCards(execPlayer.board);
      if (
        tops.length > 0 &&
        tops.every((c) => cardHasIcon(c, 'coin')) &&
        state.availableSpecialAchievements.includes('world')
      ) {
        const claimed = claimSpecialAchievement(state, execPlayer.id, 'world');
        recordChange(ctx, execPlayer.id, isDemand, claimed);
        logStep(state, ctx, execPlayer.id, isDemand, 'Each top card has Coin — claimed World!');
      } else {
        logStep(state, ctx, execPlayer.id, isDemand, 'Condition not met for World achievement.');
      }
      return 'completed';
    }

    // (3) EDUCATION [Purple] B034
    case 'B034': {
      if (execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Score pile empty (nothing to return).');
        return 'completed';
      }
      const maxAge = Math.max(...execPlayer.scorePile.map((c) => c.age));
      const highest = execPlayer.scorePile.filter((c) => c.age === maxAge);
      ctx.subState = { phase: 'education_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'edu', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (EDUCATION)`,
        subtitle: ability.text,
        min: 0,
        max: 1,
        candidates: highest,
        sourceLabel: `Highest card(s) in Score Pile [${maxAge}]`,
        allowSkip: true,
        skipLabel: 'Return Nothing',
      });
      return 'awaiting_prompt';
    }

    // (3) FEUDALISM [Purple] B035
    case 'B035': {
      if (ability.index === 1) {
        const towerHand = execPlayer.hand.filter((c) => cardHasIcon(c, 'tower'));
        if (towerHand.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No card with Tower in hand.');
          return 'completed';
        }
        if (towerHand.length === 1) {
          const moved = transferCardFromHandToZone(
            state,
            execPlayer.id,
            'hand',
            ctx.activatingPlayerId,
            towerHand[0].instanceId
          );
          const specIds = [...state.availableSpecialAchievements];
          for (const id of specIds) {
            junkSpecialAchievement(state, id);
          }
          const junkedCount = specIds.length;
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name} and junked ${junkedCount} special achievement(s).`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'feudalism_transfer' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'feud_t', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (FEUDALISM)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: towerHand,
          sourceLabel: 'Hand cards with Tower',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(
        state,
        ctx,
        execPlayer,
        isDemand,
        ability,
        'left',
        cardName,
        ['yellow', 'purple'],
        undefined,
        { phase: 'feudalism_splay' }
      );
    }

    // (4) COLONIALISM [Red] B036
    case 'B036': {
      const tuckedNames: string[] = [];
      let junkedFive = false;
      let stepNumber = 0;
      while (state.phase !== 'gameover') {
        const drawRes = drawCardFromAge(state, execPlayer.id, 3, 'tuck');
        if (drawRes.gameEnded) return 'gameover';
        if (!drawRes.card) break;
        stepNumber += 1;
        recordChange(ctx, execPlayer.id, isDemand, true);
        tuckedNames.push(`${drawRes.card.name} [${drawRes.card.age}]`);
        let junkedThisStep = false;
        if (drawRes.card.color === 'green') {
          if (junkDeck(state, 5) > 0) {
            junkedFive = true;
            junkedThisStep = true;
          }
        }
        const hasCoin = cardHasIcon(drawRes.card, 'coin');
        recordRepeatDrawStep(state, {
          actorId: execPlayer.id,
          actorName: execPlayer.name,
          sourceCardDefId: defId,
          sourceCardName: cardName,
          stepNumber,
          card: drawRes.card,
          repeats: hasCoin,
          badge: hasCoin ? 'Tucked · Keep Drawing' : 'Tucked · Stop',
          outcomeText: `Tucked ${drawRes.card.name} [${drawRes.card.age}]${
            junkedThisStep ? ' and junked the [5] deck' : ''
          }. ${hasCoin ? 'Has Coin — repeating Colonialism.' : 'No Coin — effect ends.'}`,
        });
        if (!hasCoin) break;
      }
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Tucked ${tuckedNames.join(', ')}${junkedFive ? ' and junked [5] deck' : ''}.`
      );
      return 'completed';
    }

    // (4) GUNPOWDER [Red] B037
    case 'B037': {
      if (ability.index === 1) {
        const tops = getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, 'tower'));
        if (tops.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top card with Tower on board.');
          return 'completed';
        }
        if (tops.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: tops[0].color },
            { zone: 'score', playerId: ctx.activatingPlayerId },
            tops[0].instanceId
          );
          recordDemandTransfer(ctx, 1);
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred top ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'gunpowder_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'gun', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (GUNPOWDER)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: tops,
          sourceLabel: 'Your top cards with Tower',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (!ctx.demandTransferredByAbility?.[1]) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Skipped [2] draw & score (no card transferred on demand).');
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 2, 'score');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew and scored [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (4) ANATOMY [Yellow] B038
    case 'B038': {
      if (execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'Score pile empty (nothing to return).');
        return 'completed';
      }
      if (execPlayer.scorePile.length === 1) {
        const card = removeCardFromScore(execPlayer, execPlayer.scorePile[0].instanceId);
        returnCardInstance(state, card);
        logStep(state, ctx, execPlayer.id, true, `Returned ${card.name} [${card.age}] from score pile.`);
        return finishAnatomyBoardReturn(state, ctx, execPlayer, card.age, ability);
      }
      ctx.subState = { phase: 'anatomy_score_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'anat_s', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (ANATOMY)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.scorePile,
        sourceLabel: 'Your Score Pile',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (4) PERSPECTIVE [Yellow] B039
    case 'B039': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to return).');
        return 'completed';
      }
      ctx.subState = { phase: 'perspective_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'persp_r', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (PERSPECTIVE)`,
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

    // (4) INVENTION [Green] B040
    case 'B040': {
      if (ability.index === 1) {
        return promptSplayColor(
          state,
          ctx,
          execPlayer,
          isDemand,
          ability,
          'right',
          cardName,
          ALL_COLORS,
          'left',
          { phase: 'invention_splay' }
        );
      }
      const fiveSplayed = ALL_COLORS.every((c) => execPlayer.board[c].splay !== 'none');
      if (fiveSplayed && state.availableSpecialAchievements.includes('wonder')) {
        const claimed = claimSpecialAchievement(state, execPlayer.id, 'wonder');
        recordChange(ctx, execPlayer.id, isDemand, claimed);
        logStep(state, ctx, execPlayer.id, isDemand, 'Had 5 colors splayed — claimed Wonder!');
      } else {
        logStep(state, ctx, execPlayer.id, isDemand, 'Did not claim Wonder (need 5 splayed colors).');
      }
      return 'completed';
    }

    // (4) NAVIGATION [Green] B041
    case 'B041': {
      const eligible = execPlayer.scorePile.filter((c) => c.age === 2 || c.age === 3);
      if (eligible.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No [2] or [3] in score pile.');
        return 'completed';
      }
      if (eligible.length === 1) {
        const moved = transferCard(
          state,
          { zone: 'score', playerId: execPlayer.id },
          { zone: 'score', playerId: ctx.activatingPlayerId },
          eligible[0].instanceId
        );
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'navigation_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'nav', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (NAVIGATION)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: eligible,
        sourceLabel: 'Age 2 or 3 cards in Score Pile',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (4) EXPERIMENTATION [Blue] B042
    case 'B042': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 5, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      }
      return 'completed';
    }

    // (4) PRINTING PRESS [Blue] B043
    case 'B043': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Score pile empty (cannot return).');
          return 'completed';
        }
        ctx.subState = { phase: 'printing_return' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'print', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (PRINTING PRESS)`,
          subtitle: ability.text,
          min: 0,
          max: 1,
          candidates: execPlayer.scorePile,
          sourceLabel: 'Your Score Pile',
          allowSkip: true,
          skipLabel: 'Return Nothing',
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['blue']);
    }

    // (4) ENTERPRISE [Purple] B044
    case 'B044': {
      if (ability.index === 1) {
        const eligible = getTopCards(execPlayer.board).filter(
          (c) => c.color !== 'purple' && cardHasIcon(c, 'coin')
        );
        if (eligible.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top non-purple card with Coin on board.');
          return 'completed';
        }
        if (eligible.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'board', playerId: execPlayer.id, color: eligible[0].color },
            { zone: 'board', playerId: ctx.activatingPlayerId },
            eligible[0].instanceId
          );
          const drawRes = drawCardFromAge(state, execPlayer.id, 4, 'meld');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and melded ${drawRes.card?.name ?? '[4]'}.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'enterprise_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'ent', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (ENTERPRISE)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligible,
          sourceLabel: 'Top non-purple cards with Coin',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['green']);
    }

    // (4) REFORMATION [Purple] B045
    case 'B045': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['yellow', 'purple']);
      }
      const splayedCount = ALL_COLORS.filter((c) => execPlayer.board[c].splay !== 'none').length;
      const maxTuck = Math.min(splayedCount, execPlayer.hand.length);
      if (maxTuck === 0) {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          splayedCount === 0 ? 'No splayed colors on board.' : 'Hand empty.'
        );
        return 'completed';
      }
      ctx.subState = { phase: 'reformation_tuck' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'ref_t', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (REFORMATION)`,
        subtitle: ability.text,
        min: 0,
        max: maxTuck,
        candidates: execPlayer.hand,
        sourceLabel: `Your Hand (up to ${maxTuck} for ${splayedCount} splayed color(s))`,
        allowSkip: true,
        skipLabel: 'Tuck Nothing',
      });
      return 'awaiting_prompt';
    }

    // (5) COAL [Red] B046
    case 'B046': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 5, 'tuck');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.card) {
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Drew & tucked ${drawRes.card.name} [${drawRes.card.age}].`);
        }
        return 'completed';
      }
      if (ability.index === 2) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['red']);
      }
      const nonEmptyColors = ALL_COLORS.filter((c) => execPlayer.board[c].cards.length > 0);
      if (nonEmptyColors.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Board empty (no color to score).');
        return 'completed';
      }
      ctx.subState = { phase: 'coal_score_twice' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'coal', execPlayer.id),
        kind: 'choose_color',
        playerId: execPlayer.id,
        title: `${tagPrefix} (COAL)`,
        subtitle: ability.text,
        options: nonEmptyColors,
        allowSkip: true,
        skipLabel: 'Score Nothing',
      });
      return 'awaiting_prompt';
    }

    // (5) THE PIRATE CODE [Red] B047
    case 'B047': {
      if (ability.index === 1) {
        const eligible = execPlayer.scorePile.filter((c) => c.age <= 4);
        if (eligible.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No score card of value 4 or less.');
          return 'completed';
        }
        if (eligible.length <= 2) {
          const names: string[] = [];
          for (const c of eligible) {
            transferCard(
              state,
              { zone: 'score', playerId: execPlayer.id },
              { zone: 'score', playerId: ctx.activatingPlayerId },
              c.instanceId
            );
            names.push(`[${c.age}]`);
          }
          recordDemandTransfer(ctx, 1);
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${names.join(', ')} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'pirate_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'pirate1', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (THE PIRATE CODE)`,
          subtitle: ability.text,
          min: 2,
          max: 2,
          candidates: eligible,
          sourceLabel: 'Score pile cards of value 4 or less',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (!ctx.demandTransferredByAbility?.[1]) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Skipped (no card transferred on demand).');
        return 'completed';
      }
      const coinTops = getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, 'coin'));
      if (coinTops.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No top card with Coin on board.');
        return 'completed';
      }
      const minAge = Math.min(...coinTops.map((c) => c.age));
      const lowest = coinTops.filter((c) => c.age === minAge);
      if (lowest.length === 1) {
        const card = removeTopCardFromBoard(execPlayer, lowest[0].color);
        scoreCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Scored lowest top card with Coin (${card.name} [${card.age}]).`);
        return 'completed';
      }
      ctx.subState = { phase: 'pirate_score_top' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'pirate2', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (THE PIRATE CODE)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: lowest,
        sourceLabel: `Lowest top cards with Coin [${minAge}]`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (5) STATISTICS [Yellow] B048
    case 'B048': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Score pile empty.');
          return 'completed';
        }
        ctx.subState = { phase: 'statistics_choose_val' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'stats', ctx.activatingPlayerId),
          kind: 'choose_value',
          playerId: ctx.activatingPlayerId,
          title: `STATISTICS: ${execPlayer.name}'s score pile`,
          subtitle: ability.text,
          options: [...ALL_AGES],
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['yellow']);
    }

    // (5) STEAM ENGINE [Yellow] B049
    case 'B049': {
      const draws = drawMultiple(state, execPlayer.id, 2, 4, 'tuck');
      if (draws.gameEnded) return 'gameover';
      if (draws.drawn.length > 0) recordChange(ctx, execPlayer.id, isDemand, true);
      let scoredMsg = 'no bottom yellow card to score';
      let junkedSix = 0;
      if (execPlayer.board.yellow.cards.length > 0) {
        const bottom = removeBottomCardFromBoard(execPlayer, 'yellow');
        scoreCardInstance(state, execPlayer.id, bottom);
        recordChange(ctx, execPlayer.id, isDemand, true);
        scoredMsg = `scored bottom yellow ${bottom.name} [${bottom.age}]`;
        if (bottom.defId === 'B049') {
          junkedSix = junkDeck(state, 6);
        }
      }
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Tucked ${draws.drawn.map((c) => `[${c.age}]`).join(', ')}; ${scoredMsg}${
          junkedSix > 0 ? ` and junked ${junkedSix} card(s) from [6] deck` : ''
        }.`
      );
      return 'completed';
    }

    // (5) BANKING [Green] B050
    case 'B050': {
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
            { zone: 'board', playerId: ctx.activatingPlayerId },
            eligible[0].instanceId
          );
          const drawRes = drawCardFromAge(state, execPlayer.id, 5, 'score');
          if (drawRes.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and scored [${drawRes.drawnFromAge}].`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'banking_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'bank', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (BANKING)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligible,
          sourceLabel: 'Top non-green cards with Factory',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['green']);
    }

    // (5) MEASUREMENT [Green] B051
    case 'B051': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to reveal & return).');
        return 'completed';
      }
      ctx.subState = { phase: 'measurement_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'meas', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (MEASUREMENT)`,
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

    // (5) CHEMISTRY [Blue] B052
    case 'B052': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'right', cardName, ['blue']);
      }
      const highest = getHighestTopCardAge(execPlayer.board);
      const drawRes = drawCardFromAge(state, execPlayer.id, highest + 1, 'score');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) recordChange(ctx, execPlayer.id, isDemand, true);
      if (execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No card in score pile to return.');
        return 'completed';
      }
      if (execPlayer.scorePile.length === 1) {
        const ret = removeCardFromScore(execPlayer, execPlayer.scorePile[0].instanceId);
        returnCardInstance(state, ret);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & scored [${drawRes.drawnFromAge}] and returned ${ret.name} [${ret.age}] from score pile.`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'chemistry_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'chem', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CHEMISTRY)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.scorePile,
        sourceLabel: 'Your Score Pile',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (5) PHYSICS [Blue] B053
    case 'B053': {
      const res = drawMultiple(state, execPlayer.id, 3, 6, 'reveal_hand');
      if (res.gameEnded) return 'gameover';
      if (res.drawn.length > 0) recordChange(ctx, execPlayer.id, isDemand, true);
      const colorCounts = new Map<CardColor, number>();
      let duplicateColor = false;
      for (const c of res.drawn) {
        const next = (colorCounts.get(c.color) ?? 0) + 1;
        colorCounts.set(c.color, next);
        if (next >= 2) duplicateColor = true;
      }
      if (duplicateColor) {
        const retCount = execPlayer.hand.length;
        for (const c of [...execPlayer.hand]) {
          returnCardInstance(state, removeCardFromHand(execPlayer, c.instanceId));
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & revealed ${res.drawn.map((c) => `${c.name} (${c.color})`).join(', ')} — matching colors! Returned all ${retCount} hand card(s).`
        );
      } else {
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & revealed ${res.drawn.map((c) => `${c.name} (${c.color})`).join(', ')} (all distinct colors).`
        );
      }
      return 'completed';
    }

    // (5) ASTRONOMY [Purple] B054
    case 'B054': {
      if (ability.index === 1) {
        const melded: string[] = [];
        let kept: CardInstance | null = null;
        let stepNumber = 0;
        while (state.phase !== 'gameover') {
          const drawRes = drawCardFromAge(state, execPlayer.id, 6, 'reveal_hand');
          if (drawRes.gameEnded) return 'gameover';
          if (!drawRes.card) break;
          stepNumber += 1;
          recordChange(ctx, execPlayer.id, isDemand, true);
          if (drawRes.card.color === 'green' || drawRes.card.color === 'blue') {
            const card = removeCardFromHand(execPlayer, drawRes.card.instanceId);
            meldCardInstance(state, execPlayer.id, card);
            melded.push(`${card.name} [${card.age}] (${card.color})`);
            recordRepeatDrawStep(state, {
              actorId: execPlayer.id,
              actorName: execPlayer.name,
              sourceCardDefId: defId,
              sourceCardName: cardName,
              stepNumber,
              card,
              repeats: true,
              badge: 'Melded · Keep Drawing',
              outcomeText: `Green/Blue — melded ${card.name} [${card.age}] and repeating Astronomy.`,
            });
          } else {
            kept = drawRes.card;
            recordRepeatDrawStep(state, {
              actorId: execPlayer.id,
              actorName: execPlayer.name,
              sourceCardDefId: defId,
              sourceCardName: cardName,
              stepNumber,
              card: kept,
              repeats: false,
              badge: 'Kept in Hand · Stop',
              outcomeText: `Not green or blue — kept ${kept.name} [${kept.age}] in hand. Effect ends.`,
            });
            break;
          }
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `${melded.length > 0 ? `Melded ${melded.join(', ')}; ` : ''}${
            kept ? `revealed ${kept.name} (${kept.color}; kept in hand)` : 'done'
          }.`
        );
        return 'completed';
      }
      const nonPurpleTops = (['red', 'yellow', 'green', 'blue'] as CardColor[])
        .map((col) => getTopCard(execPlayer.board[col]))
        .filter((c): c is CardInstance => c !== null);
      if (
        nonPurpleTops.length > 0 &&
        nonPurpleTops.every((c) => c.age >= 6) &&
        state.availableSpecialAchievements.includes('universe')
      ) {
        const claimed = claimSpecialAchievement(state, execPlayer.id, 'universe');
        recordChange(ctx, execPlayer.id, isDemand, claimed);
        logStep(state, ctx, execPlayer.id, isDemand, 'All non-purple top cards are >= 6 — claimed Universe!');
      } else {
        logStep(state, ctx, execPlayer.id, isDemand, 'Did not claim Universe.');
      }
      return 'completed';
    }

    // (5) SOCIETIES [Purple] B055
    case 'B055': {
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const eligible = ALL_COLORS.flatMap((col) => {
        const oppTop = getTopCard(execPlayer.board[col]);
        const actTop = getTopCard(actPlayer.board[col]);
        if (oppTop && actTop && cardHasIcon(oppTop, 'lightbulb') && oppTop.age > actTop.age) {
          return [oppTop];
        }
        return [];
      });
      if (eligible.length === 0) {
        logStep(state, ctx, execPlayer.id, true, `No top card with Lightbulb higher than ${actPlayer.name}'s matching color.`);
        return 'completed';
      }
      if (eligible.length === 1) {
        const moved = transferCard(
          state,
          { zone: 'board', playerId: execPlayer.id, color: eligible[0].color },
          { zone: 'board', playerId: actPlayer.id },
          eligible[0].instanceId
        );
        const drawRes = drawCardFromAge(state, execPlayer.id, 5, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Transferred ${moved.name} [${moved.age}] to ${actPlayer.name}'s board and drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'societies_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'soc', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (SOCIETIES)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: eligible,
        sourceLabel: 'Qualifying top cards with Lightbulb',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    default:
      return null;
  }
}

export function resolvePromptAges3to5(
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
    case 'optics_pick_card': {
      const card = stepExecPlayer.scorePile.find((c) => c.instanceId === selectedIds[0])!;
      const myScore = computeScoreTotal(stepExecPlayer);
      const fewerOpps = getOpponents(state, stepExecPlayer.id).filter(
        (o) => computeScoreTotal(o) < myScore
      );
      if (fewerOpps.length === 0) return 'completed';
      if (fewerOpps.length === 1) {
        return finishOpticsTransfer(state, ctx, stepExecPlayer, isDemand, card.instanceId, fewerOpps[0].id);
      }
      ctx.subState = { phase: 'optics_pick_opp', tempCards: [card] };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'optics_o', stepExecPlayer.id),
        kind: 'choose_option',
        playerId: stepExecPlayer.id,
        title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (OPTICS): Choose opponent`,
        subtitle: ability.text,
        options: fewerOpps.map((o) => ({
          id: o.id,
          label: `${o.name} (${computeScoreTotal(o)} pts)`,
        })),
      });
      return 'awaiting_prompt';
    }

    case 'optics_pick_opp': {
      const cardId = prevSubState?.tempCards?.[0]?.instanceId;
      if (!cardId || !action.selectedOptionId) throw new Error('Invalid Optics transfer target.');
      return finishOpticsTransfer(state, ctx, stepExecPlayer, isDemand, cardId, action.selectedOptionId);
    }

    case 'machinery_score': {
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored ${card.name} [${card.age}] (Tower) from hand.`);
      return 'completed';
    }

    case 'medicine_pick_victim': {
      const vicCard = stepExecPlayer.scorePile.find((c) => c.instanceId === selectedIds[0])!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const actMin = actPlayer.scorePile.length > 0 ? Math.min(...actPlayer.scorePile.map((c) => c.age)) : 0;
      const actLow = actPlayer.scorePile.filter((c) => c.age === actMin);
      if (actLow.length <= 1) {
        return executeMedicineExchange(state, ctx, stepExecPlayer, vicCard.instanceId, actLow[0]?.instanceId ?? null);
      }
      ctx.subState = { phase: 'medicine_pick_attacker', tempCards: [vicCard] };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'med_a', actPlayer.id),
        kind: 'choose_cards',
        playerId: actPlayer.id,
        title: `MEDICINE: ${actPlayer.name}'s score card`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: actLow,
        sourceLabel: 'Lowest cards in your score pile',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    case 'medicine_pick_attacker': {
      const vicCardId = prevSubState?.tempCards?.[0]?.instanceId ?? '';
      return executeMedicineExchange(state, ctx, stepExecPlayer, vicCardId, selectedIds[0]);
    }

    case 'medicine_junk': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must select an eligible achievement value.');
      }
      const junked = junkStandardAchievementByAge(state, action.selectedValue);
      if (junked) {
        recordChange(ctx, stepExecPlayer.id, isDemand, true);
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked Standard Achievement [${action.selectedValue}].`);
      }
      return 'completed';
    }

    case 'compass_transfer': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'board', playerId: actPlayer.id },
        target.instanceId
      );
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${target.name} (${target.color}) to ${actPlayer.name}'s board.`
      );
      return finishCompassPart2(state, ctx, stepExecPlayer, ability);
    }

    case 'compass_meld': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const card = removeTopCardFromBoard(actPlayer, target.color);
      meldCardInstance(state, stepExecPlayer.id, card);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Melded ${card.name} [${card.age}] from ${actPlayer.name}'s board.`
      );
      return 'completed';
    }

    case 'paper_score': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const card = removeTopCardFromBoard(stepExecPlayer, target.color);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const leftCount = ALL_COLORS.filter((c) => stepExecPlayer.board[c].splay === 'left').length;
      const res = drawMultiple(state, stepExecPlayer.id, leftCount, 4, 'hand');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Scored top ${card.name} [${card.age}] and drew ${res.drawn.length} [4] (${leftCount} color(s) splayed left).`
      );
      return 'completed';
    }

    case 'alchemy_meld': {
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      meldCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Melded ${card.name} [${card.age}].`);
      return finishAlchemyScore(state, ctx, stepExecPlayer, isDemand, ability);
    }

    case 'alchemy_score': {
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored ${card.name} [${card.age}] from hand.`);
      return 'completed';
    }

    case 'translation_confirm': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to meld score pile.');
        return 'completed';
      }
      const allCards = [...stepExecPlayer.scorePile].map((c) =>
        removeCardFromScore(stepExecPlayer, c.instanceId)
      );
      return applyMultiZoneWithOrderCheck(
        state,
        ctx,
        stepExecPlayer,
        isDemand,
        allCards,
        'meld',
        'TRANSLATION'
      );
    }

    case 'education_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return highest score card.');
        return 'completed';
      }
      const card = removeCardFromScore(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const remMax =
        stepExecPlayer.scorePile.length > 0 ? Math.max(...stepExecPlayer.scorePile.map((c) => c.age)) : 0;
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, remMax + 2, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned ${card.name} [${card.age}] from score pile and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'feudalism_transfer': {
      const moved = transferCardFromHandToZone(
        state,
        stepExecPlayer.id,
        'hand',
        ctx.activatingPlayerId,
        selectedIds[0]
      );
      const specIds = [...state.availableSpecialAchievements];
      for (const id of specIds) {
        junkSpecialAchievement(state, id);
      }
      const junkedCount = specIds.length;
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name} and junked ${junkedCount} special achievement(s).`
      );
      return 'completed';
    }

    case 'feudalism_splay': {
      if (!action.selectedColor) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to splay yellow or purple left.');
        return 'completed';
      }
      const splayed = splayPlayerColor(
        state,
        stepExecPlayer.id,
        action.selectedColor,
        'left',
        isSharing ? 'Share' : 'Dogma',
        ctx.parentLogId
      );
      if (splayed) {
        recordChange(ctx, stepExecPlayer.id, isDemand, true);
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, 3, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}] after splaying ${action.selectedColor} left.`);
      }
      return 'completed';
    }

    case 'gunpowder_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const moved = transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'score', playerId: ctx.activatingPlayerId },
        target.instanceId
      );
      recordDemandTransfer(ctx, ability.index);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred top ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
      );
      return 'completed';
    }

    case 'anatomy_score_return': {
      const card = removeCardFromScore(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      logStep(state, ctx, stepExecPlayer.id, true, `Returned ${card.name} [${card.age}] from score pile.`);
      return finishAnatomyBoardReturn(state, ctx, stepExecPlayer, card.age, ability);
    }

    case 'anatomy_board_return': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const removed = removeTopCardFromBoard(stepExecPlayer, target.color);
      returnCardInstance(state, removed);
      const junked = junkDeck(state, 4);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Returned top ${removed.name} [${removed.age}] and junked ${junked} card(s) from [4] deck.`
      );
      return 'completed';
    }

    case 'perspective_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return a card.');
        return 'completed';
      }
      const ret = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, ret);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const bulbColors = countColorsWithIcon(stepExecPlayer.board, 'lightbulb');
      const count = Math.min(bulbColors, stepExecPlayer.hand.length);
      if (count === 0) {
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Returned ${ret.name} [${ret.age}] (0 cards scored).`
        );
        return 'completed';
      }
      if (stepExecPlayer.hand.length <= count) {
        const names: string[] = [];
        for (const c of [...stepExecPlayer.hand]) {
          const card = removeCardFromHand(stepExecPlayer, c.instanceId);
          scoreCardInstance(state, stepExecPlayer.id, card);
          names.push(`${card.name} [${card.age}]`);
        }
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Returned ${ret.name} [${ret.age}] and scored ${names.join(', ')}.`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'perspective_score', remainingCount: count };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'persp_s', stepExecPlayer.id),
        kind: 'choose_cards',
        playerId: stepExecPlayer.id,
        title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (PERSPECTIVE): Score ${count}`,
        subtitle: ability.text,
        min: count,
        max: count,
        candidates: stepExecPlayer.hand,
        sourceLabel: `Choose ${count} card(s) to score`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    case 'perspective_score': {
      const names: string[] = [];
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        scoreCardInstance(state, stepExecPlayer.id, c);
        names.push(`${c.name} [${c.age}]`);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, names.length > 0);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored ${names.join(', ')} from hand.`);
      return 'completed';
    }

    case 'invention_splay': {
      if (!action.selectedColor) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to splay a left-splayed color right.');
        return 'completed';
      }
      const splayed = splayPlayerColor(
        state,
        stepExecPlayer.id,
        action.selectedColor,
        'right',
        isSharing ? 'Share' : 'Dogma',
        ctx.parentLogId
      );
      if (splayed) {
        recordChange(ctx, stepExecPlayer.id, isDemand, true);
        const drawRes = drawCardFromAge(state, stepExecPlayer.id, 4, 'score');
        if (drawRes.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Splayed ${action.selectedColor} right and drew & scored [${drawRes.drawnFromAge}].`
        );
      }
      return 'completed';
    }

    case 'navigation_pick': {
      const moved = transferCard(
        state,
        { zone: 'score', playerId: stepExecPlayer.id },
        { zone: 'score', playerId: ctx.activatingPlayerId },
        selectedIds[0]
      );
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} [${moved.age}] to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
      );
      return 'completed';
    }

    case 'printing_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return a score card.');
        return 'completed';
      }
      const card = removeCardFromScore(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const purpleAge = getTopCard(stepExecPlayer.board.purple)?.age ?? 0;
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, purpleAge + 2, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned ${card.name} [${card.age}] from score pile and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'enterprise_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const moved = transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'board', playerId: ctx.activatingPlayerId },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 4, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and melded ${drawRes.card?.name ?? '[4]'}.`
      );
      return 'completed';
    }

    case 'reformation_tuck': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to tuck cards.');
        return 'completed';
      }
      const picked = selectedIds.map((cid) => removeCardFromHand(stepExecPlayer, cid));
      return applyMultiZoneWithOrderCheck(
        state,
        ctx,
        stepExecPlayer,
        isDemand,
        picked,
        'tuck',
        'REFORMATION'
      );
    }

    case 'coal_score_twice': {
      if (!action.selectedColor) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to score a top card.');
        return 'completed';
      }
      const col = action.selectedColor;
      const names: string[] = [];
      for (let i = 0; i < 2; i++) {
        if (stepExecPlayer.board[col].cards.length === 0) break;
        const card = removeTopCardFromBoard(stepExecPlayer, col);
        scoreCardInstance(state, stepExecPlayer.id, card);
        names.push(`${card.name} [${card.age}]`);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, names.length > 0);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Scored ${names.join(' and ')} from ${col} stack.`
      );
      return 'completed';
    }

    case 'pirate_pick': {
      const names: string[] = [];
      for (const cid of selectedIds) {
        const moved = transferCard(
          state,
          { zone: 'score', playerId: stepExecPlayer.id },
          { zone: 'score', playerId: ctx.activatingPlayerId },
          cid
        );
        names.push(`[${moved.age}]`);
      }
      if (names.length > 0) recordDemandTransfer(ctx, ability.index);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${names.join(', ')} to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
      );
      return 'completed';
    }

    case 'pirate_score_top': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const card = removeTopCardFromBoard(stepExecPlayer, target.color);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored lowest top card with Coin (${card.name} [${card.age}]).`);
      return 'completed';
    }

    case 'statistics_choose_val': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose an eligible score value.');
      }
      const matching = stepExecPlayer.scorePile.filter((c) => c.age === action.selectedValue);
      for (const c of matching) {
        transferCard(
          state,
          { zone: 'score', playerId: stepExecPlayer.id },
          { zone: 'hand', playerId: stepExecPlayer.id },
          c.instanceId
        );
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${matching.length} card(s) of value [${action.selectedValue}] from score pile to hand.`
      );
      return 'completed';
    }

    case 'banking_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const moved = transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'board', playerId: ctx.activatingPlayerId },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 5, 'score');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board and scored [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'measurement_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to reveal and return a card.');
        return 'completed';
      }
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      state.revealedCardIds.push(card.instanceId);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      splayPlayerColor(
        state,
        stepExecPlayer.id,
        card.color,
        'right',
        isSharing ? 'Share' : 'Dogma',
        ctx.parentLogId
      );
      const count = stepExecPlayer.board[card.color].cards.length;
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, Math.max(1, count), 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Revealed & returned ${card.name} (${card.color}), splayed ${card.color} right, and drew [${drawRes.drawnFromAge}] (${count} ${card.color} on board).`
      );
      return 'completed';
    }

    case 'chemistry_return': {
      const card = removeCardFromScore(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned ${card.name} [${card.age}] from score pile.`);
      return 'completed';
    }

    case 'societies_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const moved = transferCard(
        state,
        { zone: 'board', playerId: stepExecPlayer.id, color: target.color },
        { zone: 'board', playerId: actPlayer.id },
        target.instanceId
      );
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 5, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${moved.name} [${moved.age}] to ${actPlayer.name}'s board and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    default:
      return null;
  }
}
