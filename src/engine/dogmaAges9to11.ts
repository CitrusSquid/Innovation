import { ALL_AGES, ALL_COLORS, ALL_FUNCTIONAL_ICONS, ICON_LABELS } from './constants';
import {
  drawMultiple,
  enqueueSelfExecute,
  findCardOwnerBoard,
  getSingleExtremePlayer,
  getTagPrefix,
  junkAllNonAchievementCards,
  logStep,
  makePromptId,
  promptSplayColor,
  recordChange,
  recordRepeatDrawStep,
  removeHandCardsByAge,
  type DogmaStepOutcome,
} from './dogmaHelpers';
import {
  computeScoreTotal,
  drawCardFromAge,
  eliminatePlayer,
  exchangeCards,
  getOpponents,
  getPlayer,
  junkCardInstance,
  junkDeck,
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
} from './keywords';
import {
  cardHasIcon,
  getTopCard,
  getTopCards,
  getVisibleIconCounts,
  normalizeStackSplay,
} from './splay';
import type {
  Age,
  CardAbility,
  CardColor,
  CardInstance,
  DogmaExecutionContext,
  FunctionalIcon,
  GameState,
  PlayerState,
  TurnAction,
} from './types';

function finishCompositesScorePart(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  ability: CardAbility
): DogmaStepOutcome {
  if (victim.scorePile.length === 0) {
    logStep(state, ctx, victim.id, true, 'Score pile empty (no score card transferred).');
    return 'completed';
  }
  const maxAge = Math.max(...victim.scorePile.map((c) => c.age));
  const highest = victim.scorePile.filter((c) => c.age === maxAge);
  if (highest.length === 1) {
    const moved = transferCard(
      state,
      { zone: 'score', playerId: victim.id },
      { zone: 'score', playerId: ctx.activatingPlayerId },
      highest[0].instanceId
    );
    logStep(
      state,
      ctx,
      victim.id,
      true,
      `Transferred highest score card (${moved.name} [${moved.age}]) to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'composites_score_pick' };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'comp_s', victim.id),
    kind: 'choose_cards',
    playerId: victim.id,
    title: `Demand (COMPOSITES)`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: highest,
    sourceLabel: `Highest score cards [${maxAge}]`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function finishServicesVictimTake(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  ability: CardAbility
): DogmaStepOutcome {
  const actPlayer = getPlayer(state, ctx.activatingPlayerId);
  const candidates = getTopCards(actPlayer.board).filter((c) => !cardHasIcon(c, 'leaf'));
  if (candidates.length === 0) {
    logStep(state, ctx, victim.id, true, `No top card without Leaf on ${actPlayer.name}'s board to take.`);
    return 'completed';
  }
  if (candidates.length === 1) {
    const moved = transferCard(
      state,
      { zone: 'board', playerId: actPlayer.id, color: candidates[0].color },
      { zone: 'hand', playerId: victim.id },
      candidates[0].instanceId
    );
    logStep(
      state,
      ctx,
      victim.id,
      true,
      `Took ${moved.name} [${moved.age}] from ${actPlayer.name}'s board into hand.`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'services_victim_take' };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'serv_take', victim.id),
    kind: 'choose_cards',
    playerId: victim.id,
    title: `Demand (SERVICES): ${actPlayer.name}'s board`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates,
    sourceLabel: `${actPlayer.name}'s top cards without Leaf`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function finishEcologyScoreAndDraw(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  ability: CardAbility
): DogmaStepOutcome {
  if (execPlayer.hand.length === 0) {
    const res = drawMultiple(state, execPlayer.id, 2, 10, 'hand');
    if (res.gameEnded) return 'gameover';
    logStep(state, ctx, execPlayer.id, isDemand, `Hand empty (scored 0); drew ${res.drawn.length} [10].`);
    return 'completed';
  }
  if (execPlayer.hand.length === 1) {
    const card = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
    scoreCardInstance(state, execPlayer.id, card);
    recordChange(ctx, execPlayer.id, isDemand, true);
    const res = drawMultiple(state, execPlayer.id, 2, 10, 'hand');
    if (res.gameEnded) return 'gameover';
    logStep(
      state,
      ctx,
      execPlayer.id,
      isDemand,
      `Scored ${card.name} [${card.age}] and drew ${res.drawn.length} [10].`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'ecology_score' };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'eco_s', execPlayer.id),
    kind: 'choose_cards',
    playerId: execPlayer.id,
    title: `${getTagPrefix(ctx, execPlayer.id, isDemand)} (ECOLOGY)`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: execPlayer.hand,
    sourceLabel: 'Your Hand',
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function advanceFusionLoop(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  targetAge: Age,
  ability: CardAbility
): DogmaStepOutcome {
  const eligible = getTopCards(execPlayer.board).filter((c) => c.age === targetAge);
  if (eligible.length === 0) {
    logStep(state, ctx, execPlayer.id, isDemand, `No top card of value [${targetAge}] on board.`);
    return 'completed';
  }
  if (eligible.length === 1) {
    const card = removeTopCardFromBoard(execPlayer, eligible[0].color);
    scoreCardInstance(state, execPlayer.id, card);
    recordChange(ctx, execPlayer.id, isDemand, true);
    logStep(state, ctx, execPlayer.id, isDemand, `Scored top ${card.name} [${card.age}].`);
    const nextOpts = ([targetAge - 1, targetAge - 2] as number[]).filter(
      (v): v is Age => v >= 1 && v <= 11
    );
    if (nextOpts.length === 0) return 'completed';
    if (nextOpts.length === 1) {
      return advanceFusionLoop(state, ctx, execPlayer, isDemand, nextOpts[0], ability);
    }
    ctx.subState = { phase: 'fusion_pick_val', targetAge };
    state.pendingPrompts.push({
      id: makePromptId(state, ctx, `fus_v_${targetAge}`, execPlayer.id),
      kind: 'choose_value',
      playerId: execPlayer.id,
      title: `${getTagPrefix(ctx, execPlayer.id, isDemand)} (FUSION): Next value`,
      subtitle: ability.text,
      options: nextOpts,
    });
    return 'awaiting_prompt';
  }
  ctx.subState = { phase: 'fusion_pick_card', targetAge };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, `fus_c_${targetAge}`, execPlayer.id),
    kind: 'choose_cards',
    playerId: execPlayer.id,
    title: `${getTagPrefix(ctx, execPlayer.id, isDemand)} (FUSION): Top [${targetAge}]`,
    subtitle: ability.text,
    min: 1,
    max: 1,
    candidates: eligible,
    sourceLabel: `Your top Age ${targetAge} cards`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function executeHypersonicsValue(
  state: GameState,
  ctx: DogmaExecutionContext,
  victim: PlayerState,
  val: Age,
  ability: CardAbility
): DogmaStepOutcome {
  const matching = getTopCards(victim.board).filter((c) => c.age === val);
  if (matching.length < 2) {
    logStep(state, ctx, victim.id, true, `No pair of top [${val}] cards on board.`);
    return 'completed';
  }
  if (matching.length === 2) {
    for (const c of matching) {
      const rem = removeTopCardFromBoard(victim, c.color);
      returnCardInstance(state, rem);
    }
    const retHand = victim.hand.filter((c) => c.age <= val);
    for (const c of retHand) {
      removeCardFromHand(victim, c.instanceId);
      returnCardInstance(state, c);
    }
    const retScore = victim.scorePile.filter((c) => c.age <= val);
    for (const c of retScore) {
      removeCardFromScore(victim, c.instanceId);
      returnCardInstance(state, c);
    }
    logStep(
      state,
      ctx,
      victim.id,
      true,
      `Returned two top [${val}] cards, plus ${retHand.length} hand and ${retScore.length} score card(s) <= [${val}].`
    );
    return 'completed';
  }
  ctx.subState = { phase: 'hypersonics_pick_cards', chosenValue: val };
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'hyper_c', victim.id),
    kind: 'choose_cards',
    playerId: victim.id,
    title: `Demand (HYPERSONICS): Choose 2 top [${val}] cards`,
    subtitle: ability.text,
    min: 2,
    max: 2,
    candidates: matching,
    sourceLabel: `Top Age ${val} cards on board`,
    allowSkip: false,
  });
  return 'awaiting_prompt';
}

function executeEscapismOnCard(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  picked: CardInstance
): DogmaStepOutcome {
  state.revealedCardIds.push(picked.instanceId);
  removeCardFromHand(execPlayer, picked.instanceId);
  junkCardInstance(state, picked);
  recordChange(ctx, execPlayer.id, isDemand, true);
  const equalHand = removeHandCardsByAge(execPlayer, picked.age);
  for (const c of equalHand) returnCardInstance(state, c);
  const res = drawMultiple(state, execPlayer.id, 3, picked.age, 'hand');
  if (res.gameEnded) return 'gameover';
  logStep(
    state,
    ctx,
    execPlayer.id,
    isDemand,
    `Revealed & junked ${picked.name} [${picked.age}], returned ${equalHand.length} [${picked.age}], and drew ${res.drawn.length} [${picked.age}].`
  );
  if (enqueueSelfExecute(state, ctx, execPlayer, picked)) {
    return 'gameover';
  }
  return 'completed';
}

export function startDogmaStepAges9to11(
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
    // (9) COMPOSITES [Red] B086
    case 'B086': {
      if (execPlayer.hand.length > 1) {
        ctx.subState = { phase: 'composites_keep' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'comp_k', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (COMPOSITES): Choose 1 card to KEEP`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: execPlayer.hand,
          sourceLabel: 'Choose 1 card to keep in hand',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      logStep(state, ctx, execPlayer.id, true, `Kept ${execPlayer.hand.length} hand card (0 transferred).`);
      return finishCompositesScorePart(state, ctx, execPlayer, ability);
    }

    // (9) FISSION [Red] B087
    case 'B087': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'reveal_hand');
        if (drawRes.gameEnded) return 'gameover';
        if (!drawRes.card) return 'completed';
        if (drawRes.card.color === 'red') {
          const junked = junkAllNonAchievementCards(state);
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Drew & revealed ${drawRes.card.name} (RED)! Junked ${junked} non-achievement cards — Dogma action is complete!`
          );
          return 'dogma_complete';
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          true,
          `Drew & revealed ${drawRes.card.name} (${drawRes.card.color}; not red).`
        );
        return 'completed';
      }
      const candidates = state.players
        .filter((p) => !p.eliminated)
        .flatMap((p) => getTopCards(p.board))
        .filter((c) => c.defId !== 'B087');
      if (candidates.length === 0) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, Boolean(drawRes.card));
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `No other top card to return; drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      if (candidates.length === 1) {
        const owner = findCardOwnerBoard(state, candidates[0].instanceId)!;
        const removed = removeTopCardFromBoard(owner.player, owner.color);
        returnCardInstance(state, removed);
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Returned ${removed.name} from ${owner.player.name}'s board and drew [${drawRes.drawnFromAge}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'fission_return_top' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'fiss_r', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (FISSION)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates,
        sourceLabel: 'Top cards across all boards (excluding Fission)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (9) ECOLOGY [Yellow] B088
    case 'B088': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to return).');
          return 'completed';
        }
        ctx.subState = { phase: 'ecology_return' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'eco_r', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (ECOLOGY): Hand return`,
          subtitle: ability.text,
          min: 0,
          max: 1,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand (if returned, score 1 & draw two [10])',
          allowSkip: true,
          skipLabel: 'Return Nothing',
        });
        return 'awaiting_prompt';
      }
      if (state.decks[10].length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, '[10] deck already empty.');
        return 'completed';
      }
      ctx.subState = { phase: 'ecology_junk10' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'eco_j10', execPlayer.id),
        kind: 'choose_yes_no',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ECOLOGY): [10] deck`,
        subtitle: ability.text,
        confirmLabel: 'Junk [10] Deck',
        declineLabel: 'Decline',
      });
      return 'awaiting_prompt';
    }

    // (9) SUBURBIA [Yellow] B089
    case 'B089': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no cards to tuck).');
          return 'completed';
        }
        ctx.subState = { phase: 'suburbia_tuck' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'sub_t', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (SUBURBIA): Tuck hand cards`,
          subtitle: ability.text,
          min: 0,
          max: execPlayer.hand.length,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand (scores [1] per card tucked)',
          allowSkip: true,
          skipLabel: 'Tuck None',
        });
        return 'awaiting_prompt';
      }
      if (state.decks[9].length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, '[9] deck already empty.');
        return 'completed';
      }
      ctx.subState = { phase: 'suburbia_junk9' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'sub_j9', execPlayer.id),
        kind: 'choose_yes_no',
        playerId: execPlayer.id,
        title: `${tagPrefix} (SUBURBIA): [9] deck`,
        subtitle: ability.text,
        confirmLabel: 'Junk [9] Deck',
        declineLabel: 'Decline',
      });
      return 'awaiting_prompt';
    }

    // (9) COLLABORATION [Green] B090
    case 'B090': {
      if (ability.index === 1) {
        const res = drawMultiple(state, execPlayer.id, 2, 9, 'reveal_hand');
        if (res.gameEnded) return 'gameover';
        if (res.drawn.length === 0) return 'completed';
        if (res.drawn.length === 1) {
          const moved = transferCard(
            state,
            { zone: 'hand', playerId: execPlayer.id },
            { zone: 'board', playerId: ctx.activatingPlayerId },
            res.drawn[0].instanceId
          );
          logStep(
            state,
            ctx,
            execPlayer.id,
            true,
            `Drew 1 card and transferred ${moved.name} to ${getPlayer(state, ctx.activatingPlayerId).name}'s board.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'collaboration_pick', tempCards: res.drawn };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'collab', ctx.activatingPlayerId),
          kind: 'choose_cards',
          playerId: ctx.activatingPlayerId,
          title: `COLLABORATION: Take to your board (${execPlayer.name} melds other)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: res.drawn,
          sourceLabel: `${execPlayer.name}'s two revealed [9] cards`,
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      if (execPlayer.board.green.cards.length >= 10) {
        resolveCardEffectVictory(
          state,
          [execPlayer.id],
          `${execPlayer.name} wins via Collaboration (${execPlayer.board.green.cards.length} Green cards on board)!`
        );
        return 'gameover';
      }
      logStep(state, ctx, execPlayer.id, isDemand, `Has ${execPlayer.board.green.cards.length}/10 Green cards on board.`);
      return 'completed';
    }

    // (9) SATELLITES [Green] B091
    case 'B091': {
      if (ability.index === 1) {
        const retCount = execPlayer.hand.length;
        for (const c of [...execPlayer.hand]) {
          returnCardInstance(state, removeCardFromHand(execPlayer, c.instanceId));
        }
        recordChange(ctx, execPlayer.id, isDemand, retCount > 0);
        logStep(state, ctx, execPlayer.id, isDemand, `Returned all ${retCount} card(s) from hand.`);
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['purple']);
      }
      if (ability.index === 2) {
        const res = drawMultiple(state, execPlayer.id, 3, 8, 'hand');
        if (res.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, res.drawn.length > 0);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew ${res.drawn.map((c) => `[${c.age}]`).join(', ')}.`);
        return 'completed';
      }
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to meld & self-execute).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        const card = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
        meldCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Melded ${card.name} [${card.age}].`);
        if (enqueueSelfExecute(state, ctx, execPlayer, card)) return 'gameover';
        return 'completed';
      }
      ctx.subState = { phase: 'satellites_meld' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'sat_m', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (SATELLITES)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (9) COMPUTERS [Blue] B092
    case 'B092': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['red', 'green']);
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      if (enqueueSelfExecute(state, ctx, execPlayer, drawRes.card)) return 'gameover';
      return 'completed';
    }

    // (9) GENETICS [Blue] B093
    case 'B093': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      const stack = execPlayer.board[drawRes.card.color];
      const beneath = stack.cards.slice(0, -1);
      execPlayer.board[drawRes.card.color] = normalizeStackSplay({
        color: drawRes.card.color,
        cards: [stack.cards[stack.cards.length - 1]],
        splay: stack.splay,
      });
      for (const c of beneath) scoreCardInstance(state, execPlayer.id, c);
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Drew & melded ${drawRes.card.name} [${drawRes.card.age}] and scored ${beneath.length} card(s) beneath it.`
      );
      return 'completed';
    }

    // (9) SERVICES [Purple] B094
    case 'B094': {
      if (execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'Score pile empty.');
        return 'completed';
      }
      ctx.subState = { phase: 'services_choose_val' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'serv_v', ctx.activatingPlayerId),
        kind: 'choose_value',
        playerId: ctx.activatingPlayerId,
        title: `SERVICES: ${execPlayer.name}'s score pile`,
        subtitle: ability.text,
        options: [...ALL_AGES],
      });
      return 'awaiting_prompt';
    }

    // (9) SPECIALIZATION [Purple] B095
    case 'B095': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to reveal).');
          return 'completed';
        }
        if (execPlayer.hand.length === 1) {
          const picked = execPlayer.hand[0];
          state.revealedCardIds.push(picked.instanceId);
          const taken: string[] = [];
          for (const opp of getOpponents(state, execPlayer.id)) {
            const top = getTopCard(opp.board[picked.color]);
            if (top) {
              transferCard(
                state,
                { zone: 'board', playerId: opp.id, color: picked.color },
                { zone: 'hand', playerId: execPlayer.id },
                top.instanceId
              );
              taken.push(`${top.name} from ${opp.name}`);
            }
          }
          recordChange(ctx, execPlayer.id, isDemand, taken.length > 0);
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Revealed ${picked.color}; took ${taken.join(', ') || 'no top cards'}.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'specialization_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'spec', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (SPECIALIZATION)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: execPlayer.hand,
          sourceLabel: 'Your Hand (choose color to steal top cards)',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['yellow', 'blue']);
    }

    // (10) MINIATURIZATION [Red] B096
    case 'B096': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to return).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        const c = removeCardFromHand(execPlayer, execPlayer.hand[0].instanceId);
        returnCardInstance(state, c);
        recordChange(ctx, execPlayer.id, isDemand, true);
        if (c.age === 10) {
          const distinct = new Set(execPlayer.scorePile.map((s) => s.age)).size;
          const res = drawMultiple(state, execPlayer.id, distinct, 10, 'hand');
          if (res.gameEnded) return 'gameover';
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Returned ${c.name} [10] and drew ${res.drawn.length} [10] (${distinct} distinct score values).`
          );
        } else if (c.age === 11) {
          const j = junkDeck(state, 11);
          logStep(state, ctx, execPlayer.id, isDemand, `Returned ${c.name} [11] and junked ${j} card(s) from [11] deck.`);
        } else {
          logStep(state, ctx, execPlayer.id, isDemand, `Returned ${c.name} [${c.age}].`);
        }
        return 'completed';
      }
      ctx.subState = { phase: 'miniaturization_return' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'mini', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (MINIATURIZATION)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand ([10] draws [10]s; [11] junks [11] deck)',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (10) ROBOTICS [Red] B097
    case 'B097': {
      if (ability.index === 1) {
        if (execPlayer.board.green.cards.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No Green card on board to score.');
          return 'completed';
        }
        const g = removeTopCardFromBoard(execPlayer, 'green');
        scoreCardInstance(state, execPlayer.id, g);
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Scored top Green (${g.name} [${g.age}]).`);
        return 'completed';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      if (cardHasIcon(drawRes.card, 'factory') || cardHasIcon(drawRes.card, 'clock')) {
        if (enqueueSelfExecute(state, ctx, execPlayer, drawRes.card)) return 'gameover';
      }
      return 'completed';
    }

    // (10) GLOBALIZATION [Yellow] B098
    case 'B098': {
      if (ability.index === 1) {
        const eligible = getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, 'leaf'));
        if (eligible.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'No top card with Leaf on board.');
          return 'completed';
        }
        if (eligible.length === 1) {
          const rem = removeTopCardFromBoard(execPlayer, eligible[0].color);
          returnCardInstance(state, rem);
          logStep(state, ctx, execPlayer.id, true, `Returned top ${rem.name} [${rem.age}].`);
          return 'completed';
        }
        ctx.subState = { phase: 'globalization_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'glob', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `Demand (GLOBALIZATION)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates: eligible,
          sourceLabel: 'Your top cards with Leaf',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew & melded ${drawRes.card.name} [${drawRes.card.age}].`);
      }
      const active = state.players.filter((p) => !p.eliminated);
      const conditionMet = active.every((p) => {
        const ic = getVisibleIconCounts(p.board);
        return ic.leaf <= ic.factory;
      });
      if (conditionMet) {
        const winner = getSingleExtremePlayer(state, (p) => computeScoreTotal(p), 'max');
        if (winner) {
          resolveCardEffectVictory(
            state,
            [winner.id],
            `${winner.name} wins via Globalization (${computeScoreTotal(winner)} pts)!`
          );
          return 'gameover';
        }
      }
      return 'completed';
    }

    // (10) STEM CELLS [Yellow] B099
    case 'B099': {
      if (ability.index === 1) {
        if (execPlayer.hand.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty.');
          return 'completed';
        }
        ctx.subState = { phase: 'stem_cells_confirm' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'stem', execPlayer.id),
          kind: 'choose_yes_no',
          playerId: execPlayer.id,
          title: `${tagPrefix} (STEM CELLS)`,
          subtitle: ability.text,
          confirmLabel: 'Score All Hand Cards',
          declineLabel: 'Decline',
        });
        return 'awaiting_prompt';
      }
      const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      if (drawRes.card) {
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(state, ctx, execPlayer.id, isDemand, `Drew [${drawRes.drawnFromAge}].`);
      }
      return 'completed';
    }

    // (10) DATABASES [Green] B100
    case 'B100': {
      const highestAch = execPlayer.achievements.reduce((m, a) => Math.max(m, a.age ?? 0), 0);
      const count = Math.min(highestAch, execPlayer.scorePile.length);
      if (count === 0) {
        logStep(state, ctx, execPlayer.id, true, `Returned 0 cards (highest achievement value ${highestAch}).`);
        return 'completed';
      }
      if (execPlayer.scorePile.length <= count) {
        for (const c of [...execPlayer.scorePile]) {
          returnCardInstance(state, removeCardFromScore(execPlayer, c.instanceId));
        }
        logStep(state, ctx, execPlayer.id, true, `Returned all ${count} score card(s).`);
        return 'completed';
      }
      ctx.subState = { phase: 'databases_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'db', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `Demand (DATABASES)`,
        subtitle: ability.text,
        min: count,
        max: count,
        candidates: execPlayer.scorePile,
        sourceLabel: `Your Score Pile (choose ${count})`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (10) SELF SERVICE [Green] B101
    case 'B101': {
      if (ability.index === 1) {
        const opps = getOpponents(state, execPlayer.id);
        const myAch = execPlayer.achievements.length;
        if (opps.length > 0 && opps.every((o) => myAch >= 2 * o.achievements.length)) {
          resolveCardEffectVictory(
            state,
            [execPlayer.id],
            `${execPlayer.name} wins via Self Service (${myAch} achievements)!`
          );
          return 'gameover';
        }
        logStep(state, ctx, execPlayer.id, isDemand, `Has ${myAch} achievement(s) (does not double each opponent).`);
        return 'completed';
      }
      const tops = getTopCards(execPlayer.board).filter((c) => c.defId !== 'B101');
      if (tops.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No other top card on board to self-execute.');
        return 'completed';
      }
      if (tops.length === 1) {
        if (enqueueSelfExecute(state, ctx, execPlayer, tops[0])) return 'gameover';
        return 'completed';
      }
      ctx.subState = { phase: 'self_service_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'selfsrv', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (SELF SERVICE)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: tops,
        sourceLabel: 'Your other top cards on board',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (10) BIOENGINEERING [Blue] B102
    case 'B102': {
      if (ability.index === 1) {
        const candidates = getOpponents(state, execPlayer.id).flatMap((o) =>
          getTopCards(o.board).filter((c) => cardHasIcon(c, 'leaf'))
        );
        if (candidates.length === 0) {
          logStep(state, ctx, execPlayer.id, isDemand, 'No opponent has a top card with Leaf.');
          return 'completed';
        }
        if (candidates.length === 1) {
          const owner = findCardOwnerBoard(state, candidates[0].instanceId)!;
          const card = removeTopCardFromBoard(owner.player, owner.color);
          scoreCardInstance(state, execPlayer.id, card);
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Scored ${card.name} [${card.age}] from ${owner.player.name}'s board.`
          );
          return 'completed';
        }
        ctx.subState = { phase: 'bioengineering_pick' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'bio', execPlayer.id),
          kind: 'choose_cards',
          playerId: execPlayer.id,
          title: `${tagPrefix} (BIOENGINEERING)`,
          subtitle: ability.text,
          min: 1,
          max: 1,
          candidates,
          sourceLabel: 'Opponent top cards with Leaf',
          allowSkip: false,
        });
        return 'awaiting_prompt';
      }
      const active = state.players.filter((p) => !p.eliminated);
      if (active.some((p) => getVisibleIconCounts(p.board).leaf < 2)) {
        const winner = getSingleExtremePlayer(
          state,
          (p) => getVisibleIconCounts(p.board).leaf,
          'max'
        );
        if (winner) {
          resolveCardEffectVictory(
            state,
            [winner.id],
            `${winner.name} wins via Bioengineering (${getVisibleIconCounts(winner.board).leaf} Leaf icons)!`
          );
          return 'gameover';
        }
      }
      logStep(state, ctx, execPlayer.id, isDemand, 'Bioengineering win condition not triggered.');
      return 'completed';
    }

    // (10) SOFTWARE [Blue] B103
    case 'B103': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'score');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.card) {
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Drew & scored [${drawRes.drawnFromAge}].`);
        }
        return 'completed';
      }
      const d1 = drawCardFromAge(state, execPlayer.id, 9, 'meld');
      if (d1.gameEnded) return 'gameover';
      const d2 = drawCardFromAge(state, execPlayer.id, 9, 'meld');
      if (d2.gameEnded) return 'gameover';
      if (d1.card || d2.card) recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Drew & melded ${[d1.card, d2.card].filter(Boolean).map((c) => c!.name).join(', ')}.`
      );
      if (d2.card) {
        if (enqueueSelfExecute(state, ctx, execPlayer, d2.card)) return 'gameover';
      }
      return 'completed';
    }

    // (10) A.I [Purple] B104
    case 'B104': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'score');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.card) {
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Drew & scored [${drawRes.drawnFromAge}].`);
        }
        return 'completed';
      }
      const allTops = state.players.filter((p) => !p.eliminated).flatMap((p) => getTopCards(p.board));
      const hasRobotics = allTops.some((c) => c.defId === 'B097');
      const hasSoftware = allTops.some((c) => c.defId === 'B103');
      if (hasRobotics && hasSoftware) {
        const winner = getSingleExtremePlayer(state, (p) => computeScoreTotal(p), 'min');
        if (winner) {
          resolveCardEffectVictory(
            state,
            [winner.id],
            `${winner.name} wins via A.I (lowest score ${computeScoreTotal(winner)} pts)!`
          );
          return 'gameover';
        }
      }
      logStep(state, ctx, execPlayer.id, isDemand, 'A.I win condition not met.');
      return 'completed';
    }

    // (10) THE INTERNET [Purple] B105
    case 'B105': {
      if (ability.index === 1) {
        return promptSplayColor(state, ctx, execPlayer, isDemand, ability, 'up', cardName, ['green']);
      }
      if (ability.index === 2) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 10, 'score');
        if (drawRes.gameEnded) return 'gameover';
        if (drawRes.card) {
          recordChange(ctx, execPlayer.id, isDemand, true);
          logStep(state, ctx, execPlayer.id, isDemand, `Drew & scored [${drawRes.drawnFromAge}].`);
        }
        return 'completed';
      }
      const res = drawMultiple(state, execPlayer.id, 2, 10, 'meld');
      if (res.gameEnded) return 'gameover';
      if (res.drawn.length > 0) recordChange(ctx, execPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Drew & melded ${res.drawn.map((c) => `${c.name} [${c.age}]`).join(', ')}.`
      );
      return 'completed';
    }

    // (11) ASTROGEOLOGY [Red] B106
    case 'B106': {
      if (ability.index === 1) {
        const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'reveal_hand');
        if (drawRes.gameEnded) return 'gameover';
        if (!drawRes.card) return 'completed';
        recordChange(ctx, execPlayer.id, isDemand, true);
        const col = drawRes.card.color;
        const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
        const splayed = splayPlayerColor(
          state,
          execPlayer.id,
          col,
          'aslant',
          isSharing ? 'Share' : 'Dogma',
          ctx.parentLogId
        );
        let movedCount = 0;
        if (splayed) {
          while (execPlayer.board[col].cards.length > 4) {
            execPlayer.hand.push(removeBottomCardFromBoard(execPlayer, col));
            movedCount += 1;
          }
        }
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Drew & revealed ${drawRes.card.name} (${col}); ${
            splayed
              ? `splayed ${col} askew and moved ${movedCount} card(s) to hand`
              : `could not splay ${col} askew`
          }.`
        );
        return 'completed';
      }
      if (execPlayer.hand.length >= 8) {
        resolveCardEffectVictory(
          state,
          [execPlayer.id],
          `${execPlayer.name} wins via Astrogeology (${execPlayer.hand.length} cards in hand)!`
        );
        return 'gameover';
      }
      logStep(state, ctx, execPlayer.id, isDemand, `Has ${execPlayer.hand.length}/8 cards in hand.`);
      return 'completed';
    }

    // (11) FUSION [Red] B107
    case 'B107': {
      return advanceFusionLoop(state, ctx, execPlayer, isDemand, 11, ability);
    }

    // (11) NEAR-FIELD COMM [Yellow] B108
    case 'B108': {
      if (ability.index === 1) {
        if (execPlayer.scorePile.length === 0) {
          logStep(state, ctx, execPlayer.id, true, 'Score pile empty.');
          return 'completed';
        }
        const actPlayer = getPlayer(state, ctx.activatingPlayerId);
        ctx.subState = { phase: 'nfc_choose_val' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'nfc_v', actPlayer.id),
          kind: 'choose_value',
          playerId: actPlayer.id,
          title: `NEAR-FIELD COMM: ${execPlayer.name}'s score pile`,
          subtitle: ability.text,
          options: [...ALL_AGES],
        });
        return 'awaiting_prompt';
      }
      if (execPlayer.scorePile.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Score pile empty (nothing to self-execute).');
        return 'completed';
      }
      const maxAge = Math.max(...execPlayer.scorePile.map((c) => c.age));
      const highest = execPlayer.scorePile.filter((c) => c.age === maxAge);
      if (highest.length === 1) {
        state.revealedCardIds.push(highest[0].instanceId);
        if (enqueueSelfExecute(state, ctx, execPlayer, highest[0])) return 'gameover';
        return 'completed';
      }
      ctx.subState = { phase: 'nfc_self_exec' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'nfc_se', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (NEAR-FIELD COMM)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: highest,
        sourceLabel: `Highest cards in Score Pile [${maxAge}]`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (11) RECLAMATION [Yellow] B109
    case 'B109': {
      let targetColor: CardColor = 'red';
      const logs: string[] = [];
      let stepNumber = 0;
      while (state.phase !== 'gameover') {
        let returnedCount = 0;
        let sumVal = 0;
        for (let i = 0; i < 3; i++) {
          if (execPlayer.board[targetColor].cards.length === 0) break;
          const b = removeBottomCardFromBoard(execPlayer, targetColor);
          returnCardInstance(state, b);
          returnedCount += 1;
          sumVal += b.age;
        }
        const drawAge = Math.max(1, Math.ceil(sumVal / 2));
        const drawRes = drawCardFromAge(state, execPlayer.id, drawAge, 'meld');
        if (drawRes.gameEnded) return 'gameover';
        recordChange(ctx, execPlayer.id, isDemand, returnedCount > 0 || Boolean(drawRes.card));
        logs.push(
          `returned ${returnedCount} bottom ${targetColor} (sum ${sumVal}) -> melded ${drawRes.card?.name ?? ''} [${drawRes.drawnFromAge}]`
        );
        const willRepeat = returnedCount >= 3 && Boolean(drawRes.card);
        if (drawRes.card) {
          stepNumber += 1;
          recordRepeatDrawStep(state, {
            actorId: execPlayer.id,
            actorName: execPlayer.name,
            sourceCardDefId: defId,
            sourceCardName: cardName,
            stepNumber,
            card: drawRes.card,
            repeats: willRepeat,
            badge: willRepeat ? 'Melded · Keep Drawing' : 'Melded · Stop',
            outcomeText: `Returned ${returnedCount} bottom ${targetColor} (sum ${sumVal}) and melded ${drawRes.card.name} [${drawRes.card.age}]. ${
              willRepeat
                ? `Repeating Reclamation with ${drawRes.card.color}.`
                : 'Fewer than 3 cards returned — effect ends.'
            }`,
          });
        }
        if (!willRepeat || !drawRes.card) break;
        targetColor = drawRes.card.color;
      }
      logStep(state, ctx, execPlayer.id, isDemand, `Reclamation: ${logs.join('; ')}.`);
      return 'completed';
    }

    // (11) HYPERSONICS [Green] B110
    case 'B110': {
      const tops = getTopCards(execPlayer.board);
      const countsByAge = new Map<Age, CardInstance[]>();
      for (const c of tops) {
        const list = countsByAge.get(c.age) ?? [];
        list.push(c);
        countsByAge.set(c.age, list);
      }
      const pairAges = Array.from(countsByAge.entries())
        .filter(([, arr]) => arr.length >= 2)
        .map(([age]) => age)
        .sort((a, b) => a - b);
      if (pairAges.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No two top cards of the same value on board.');
        return 'completed';
      }
      if (pairAges.length === 1) {
        return executeHypersonicsValue(state, ctx, execPlayer, pairAges[0], ability);
      }
      ctx.subState = { phase: 'hypersonics_pick_val' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'hyper_v', execPlayer.id),
        kind: 'choose_value',
        playerId: execPlayer.id,
        title: `Demand (HYPERSONICS)`,
        subtitle: ability.text,
        options: pairAges,
      });
      return 'awaiting_prompt';
    }

    // (11) SPACE TRAFFIC [Green] B111
    case 'B111': {
      const steps: string[] = [];
      let stepNumber = 0;
      while (state.phase !== 'gameover') {
        const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'hand');
        if (drawRes.gameEnded) return 'gameover';
        if (!drawRes.card) break;
        stepNumber += 1;
        const card = removeCardFromHand(execPlayer, drawRes.card.instanceId);
        const col = card.color;
        const bottom = execPlayer.board[col].cards[0];
        const directlyUnder11 = Boolean(bottom && bottom.age === 11);
        tuckCardInstance(state, execPlayer.id, card);
        recordChange(ctx, execPlayer.id, isDemand, true);
        if (directlyUnder11) {
          recordRepeatDrawStep(state, {
            actorId: execPlayer.id,
            actorName: execPlayer.name,
            sourceCardDefId: defId,
            sourceCardName: cardName,
            stepNumber,
            card,
            repeats: false,
            badge: 'Eliminated · Stop',
            outcomeText: `Tucked ${card.name} [11] directly under an [11] — ${execPlayer.name} loses!`,
          });
          logStep(
            state,
            ctx,
            execPlayer.id,
            isDemand,
            `Tucked ${card.name} [11] directly under an [11] — eliminated!`
          );
          eliminatePlayer(state, execPlayer.id);
          return (state.phase as string) === 'gameover' ? 'gameover' : 'completed';
        }
        let scored = 0;
        while (execPlayer.board[col].cards.length > 5) {
          const b = removeBottomCardFromBoard(execPlayer, col);
          scoreCardInstance(state, execPlayer.id, b);
          scored += 1;
        }
        const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
        splayPlayerColor(
          state,
          execPlayer.id,
          col,
          'aslant',
          isSharing ? 'Share' : 'Dogma',
          ctx.parentLogId
        );
        steps.push(`tucked ${card.name} [11] (${col}), scored ${scored}, splayed ${col} askew`);
        const myScore = computeScoreTotal(execPlayer);
        const oppMaxScore = state.players
          .filter((p) => !p.eliminated && p.id !== execPlayer.id)
          .reduce((m, p) => Math.max(m, computeScoreTotal(p)), -1);
        const willRepeat = myScore <= oppMaxScore;
        recordRepeatDrawStep(state, {
          actorId: execPlayer.id,
          actorName: execPlayer.name,
          sourceCardDefId: defId,
          sourceCardName: cardName,
          stepNumber,
          card,
          repeats: willRepeat,
          badge: willRepeat ? 'Tucked · Keep Drawing' : 'Highest Score · Stop',
          outcomeText: `Tucked ${card.name} [11] (${col}), scored ${scored}, splayed ${col} askew. ${
            willRepeat
              ? 'Not highest score — repeating Space Traffic.'
              : 'Now highest score — effect ends.'
          }`,
        });
        if (!willRepeat) break;
      }
      logStep(state, ctx, execPlayer.id, isDemand, `Space Traffic: ${steps.join('; ')}.`);
      return 'completed';
    }

    // (11) CLIMATOLOGY [Blue] B112
    case 'B112': {
      if (ability.index === 1) {
        const nonLeafIcons = ALL_FUNCTIONAL_ICONS.filter((ic) => ic !== 'leaf');
        ctx.subState = { phase: 'climatology_choose_icon' };
        state.pendingPrompts.push({
          id: makePromptId(state, ctx, 'clim_ic', ctx.activatingPlayerId),
          kind: 'choose_option',
          playerId: ctx.activatingPlayerId,
          title: `CLIMATOLOGY: Choose icon for ${execPlayer.name}`,
          subtitle: ability.text,
          options: nonLeafIcons.map((ic) => ({
            id: ic,
            label: ICON_LABELS[ic],
            description: `${execPlayer.name} has ${
              getTopCards(execPlayer.board).filter((c) => cardHasIcon(c, ic)).length
            } top card(s) with ${ICON_LABELS[ic]}`,
          })),
        });
        return 'awaiting_prompt';
      }
      const tops = getTopCards(execPlayer.board);
      if (tops.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'No top card on board to return.');
        return 'completed';
      }
      if (tops.length === 1) {
        const rem = removeTopCardFromBoard(execPlayer, tops[0].color);
        returnCardInstance(state, rem);
        const toRet = execPlayer.scorePile.filter((c) => c.age >= rem.age);
        for (const s of toRet) {
          removeCardFromScore(execPlayer, s.instanceId);
          returnCardInstance(state, s);
        }
        recordChange(ctx, execPlayer.id, isDemand, true);
        logStep(
          state,
          ctx,
          execPlayer.id,
          isDemand,
          `Returned top ${rem.name} [${rem.age}] and ${toRet.length} score card(s) >= [${rem.age}].`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'climatology_ab2_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'clim_2', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (CLIMATOLOGY)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: tops,
        sourceLabel: 'Your top cards on board',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (11) SOLAR SAILING [Blue] B113
    case 'B113': {
      const drawRes = drawCardFromAge(state, execPlayer.id, 11, 'meld');
      if (drawRes.gameEnded) return 'gameover';
      if (!drawRes.card) return 'completed';
      recordChange(ctx, execPlayer.id, isDemand, true);
      const col = drawRes.card.color;
      let retCount = 0;
      if (execPlayer.board[col].splay !== 'aslant') {
        while (execPlayer.board[col].cards.length > 4) {
          returnCardInstance(state, removeBottomCardFromBoard(execPlayer, col));
          retCount += 1;
        }
        const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
        splayPlayerColor(
          state,
          execPlayer.id,
          col,
          'aslant',
          isSharing ? 'Share' : 'Dogma',
          ctx.parentLogId
        );
      }
      logStep(
        state,
        ctx,
        execPlayer.id,
        isDemand,
        `Drew & melded ${drawRes.card.name} (${col})${
          retCount > 0 ? `, returned ${retCount} bottom card(s)` : ''
        }; ${execPlayer.board[col].cards.length} ${col} card(s) on board.`
      );
      if (execPlayer.board[col].cards.length >= 6) {
        resolveCardEffectVictory(
          state,
          [execPlayer.id],
          `${execPlayer.name} wins via Solar Sailing (${execPlayer.board[col].cards.length} ${col} cards on board)!`
        );
        return 'gameover';
      }
      return 'completed';
    }

    // (11) ESCAPISM [Purple] B114
    case 'B114': {
      if (execPlayer.hand.length === 0) {
        logStep(state, ctx, execPlayer.id, isDemand, 'Hand empty (no card to junk & self-execute).');
        return 'completed';
      }
      if (execPlayer.hand.length === 1) {
        return executeEscapismOnCard(state, ctx, execPlayer, isDemand, execPlayer.hand[0]);
      }
      ctx.subState = { phase: 'escapism_pick' };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'escap', execPlayer.id),
        kind: 'choose_cards',
        playerId: execPlayer.id,
        title: `${tagPrefix} (ESCAPISM)`,
        subtitle: ability.text,
        min: 1,
        max: 1,
        candidates: execPlayer.hand,
        sourceLabel: 'Your Hand',
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    // (11) WHATABOUTISM [Purple] B115
    case 'B115': {
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const targets = getTopCards(execPlayer.board).filter((c) =>
        c.abilities.some((a) => a.isDemand)
      );
      if (targets.length === 0) {
        logStep(state, ctx, execPlayer.id, true, 'No top card with a demand effect on board.');
        return 'completed';
      }
      for (const c of targets) {
        transferCard(
          state,
          { zone: 'board', playerId: execPlayer.id, color: c.color },
          { zone: 'board', playerId: actPlayer.id },
          c.instanceId
        );
      }
      const vicScoreIds = execPlayer.scorePile.map((c) => c.instanceId);
      const actScoreIds = actPlayer.scorePile.map((c) => c.instanceId);
      exchangeCards(
        state,
        { zone: 'score', playerId: execPlayer.id },
        vicScoreIds,
        { zone: 'score', playerId: actPlayer.id },
        actScoreIds
      );
      logStep(
        state,
        ctx,
        execPlayer.id,
        true,
        `Transferred ${targets.map((c) => c.name).join(', ')} to ${actPlayer.name}'s board and exchanged score piles (${vicScoreIds.length} ↔ ${actScoreIds.length}).`
      );
      return 'completed';
    }

    default:
      return null;
  }
}

export function resolvePromptAges9to11(
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

  switch (phase) {
    case 'composites_keep': {
      const keepId = selectedIds[0];
      const toTransfer = stepExecPlayer.hand.filter((c) => c.instanceId !== keepId);
      for (const c of toTransfer) {
        transferCard(
          state,
          { zone: 'hand', playerId: stepExecPlayer.id },
          { zone: 'hand', playerId: ctx.activatingPlayerId },
          c.instanceId
        );
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Kept 1 hand card and transferred ${toTransfer.length} card(s) to ${getPlayer(state, ctx.activatingPlayerId).name}'s hand.`
      );
      return finishCompositesScorePart(state, ctx, stepExecPlayer, ability);
    }

    case 'composites_score_pick': {
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
        `Transferred highest score card (${moved.name} [${moved.age}]) to ${getPlayer(state, ctx.activatingPlayerId).name}'s score pile.`
      );
      return 'completed';
    }

    case 'fission_return_top': {
      const owner = findCardOwnerBoard(state, selectedIds[0])!;
      const removed = removeTopCardFromBoard(owner.player, owner.color);
      returnCardInstance(state, removed);
      const drawRes = drawCardFromAge(state, stepExecPlayer.id, 10, 'hand');
      if (drawRes.gameEnded) return 'gameover';
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned ${removed.name} from ${owner.player.name}'s board and drew [${drawRes.drawnFromAge}].`
      );
      return 'completed';
    }

    case 'ecology_return': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to return a card.');
        return 'completed';
      }
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned ${card.name} [${card.age}] from hand.`);
      return finishEcologyScoreAndDraw(state, ctx, stepExecPlayer, isDemand, ability);
    }

    case 'ecology_score': {
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const res = drawMultiple(state, stepExecPlayer.id, 2, 10, 'hand');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Scored ${card.name} [${card.age}] and drew ${res.drawn.length} [10].`
      );
      return 'completed';
    }

    case 'ecology_junk10': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to junk [10] deck.');
        return 'completed';
      }
      const cnt = junkDeck(state, 10);
      recordChange(ctx, stepExecPlayer.id, isDemand, cnt > 0);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked ${cnt} card(s) from [10] deck.`);
      return 'completed';
    }

    case 'suburbia_tuck': {
      if (selectedIds.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to tuck cards.');
        return 'completed';
      }
      for (const cid of selectedIds) {
        const c = removeCardFromHand(stepExecPlayer, cid);
        tuckCardInstance(state, stepExecPlayer.id, c);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      const res = drawMultiple(state, stepExecPlayer.id, selectedIds.length, 1, 'score');
      if (res.gameEnded) return 'gameover';
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Tucked ${selectedIds.length} card(s) and scored ${res.drawn.length} [1].`
      );
      return 'completed';
    }

    case 'suburbia_junk9': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to junk [9] deck.');
        return 'completed';
      }
      const cnt = junkDeck(state, 9);
      recordChange(ctx, stepExecPlayer.id, isDemand, cnt > 0);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Junked ${cnt} card(s) from [9] deck.`);
      return 'completed';
    }

    case 'collaboration_pick': {
      const drawn = prevSubState?.tempCards ?? [];
      const chosenId = selectedIds[0];
      const other = drawn.find((c) => c.instanceId !== chosenId);
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const transferred = transferCard(
        state,
        { zone: 'hand', playerId: stepExecPlayer.id },
        { zone: 'board', playerId: actPlayer.id },
        chosenId
      );
      let meldedName = '';
      if (other) {
        const card = removeCardFromHand(stepExecPlayer, other.instanceId);
        meldCardInstance(state, stepExecPlayer.id, card);
        meldedName = `${card.name} [${card.age}]`;
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${transferred.name} to ${actPlayer.name}'s board and melded ${meldedName}.`
      );
      return 'completed';
    }

    case 'satellites_meld': {
      const card = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      meldCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Melded ${card.name} [${card.age}].`);
      if (enqueueSelfExecute(state, ctx, stepExecPlayer, card)) return 'gameover';
      return 'completed';
    }

    case 'services_choose_val': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose a score value.');
      }
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const matching = stepExecPlayer.scorePile.filter((c) => c.age === action.selectedValue);
      for (const c of matching) {
        transferCard(
          state,
          { zone: 'score', playerId: stepExecPlayer.id },
          { zone: 'hand', playerId: actPlayer.id },
          c.instanceId
        );
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${matching.length} [${action.selectedValue}] score card(s) to ${actPlayer.name}'s hand.`
      );
      if (matching.length === 0) return 'completed';
      return finishServicesVictimTake(state, ctx, stepExecPlayer, ability);
    }

    case 'services_victim_take': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const moved = transferCard(
        state,
        { zone: 'board', playerId: actPlayer.id, color: target.color },
        { zone: 'hand', playerId: stepExecPlayer.id },
        target.instanceId
      );
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Took ${moved.name} [${moved.age}] from ${actPlayer.name}'s board into hand.`
      );
      return 'completed';
    }

    case 'specialization_pick': {
      const picked = stepExecPlayer.hand.find((c) => c.instanceId === selectedIds[0])!;
      state.revealedCardIds.push(picked.instanceId);
      const taken: string[] = [];
      for (const opp of getOpponents(state, stepExecPlayer.id)) {
        const top = getTopCard(opp.board[picked.color]);
        if (top) {
          transferCard(
            state,
            { zone: 'board', playerId: opp.id, color: picked.color },
            { zone: 'hand', playerId: stepExecPlayer.id },
            top.instanceId
          );
          taken.push(`${top.name} from ${opp.name}`);
        }
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, taken.length > 0);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Revealed ${picked.color}; took ${taken.join(', ') || 'no top cards'}.`
      );
      return 'completed';
    }

    case 'miniaturization_return': {
      const c = removeCardFromHand(stepExecPlayer, selectedIds[0]);
      returnCardInstance(state, c);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      if (c.age === 10) {
        const distinct = new Set(stepExecPlayer.scorePile.map((s) => s.age)).size;
        const res = drawMultiple(state, stepExecPlayer.id, distinct, 10, 'hand');
        if (res.gameEnded) return 'gameover';
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          isDemand,
          `Returned ${c.name} [10] and drew ${res.drawn.length} [10] (${distinct} distinct score values).`
        );
      } else if (c.age === 11) {
        const j = junkDeck(state, 11);
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned ${c.name} [11] and junked ${j} card(s) from [11] deck.`);
      } else {
        logStep(state, ctx, stepExecPlayer.id, isDemand, `Returned ${c.name} [${c.age}].`);
      }
      return 'completed';
    }

    case 'globalization_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const rem = removeTopCardFromBoard(stepExecPlayer, target.color);
      returnCardInstance(state, rem);
      logStep(state, ctx, stepExecPlayer.id, true, `Returned top ${rem.name} [${rem.age}].`);
      return 'completed';
    }

    case 'stem_cells_confirm': {
      if (!action.confirmed) {
        logStep(state, ctx, stepExecPlayer.id, isDemand, 'Declined to score all cards from hand.');
        return 'completed';
      }
      const count = stepExecPlayer.hand.length;
      for (const c of [...stepExecPlayer.hand]) {
        scoreCardInstance(state, stepExecPlayer.id, removeCardFromHand(stepExecPlayer, c.instanceId));
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, count > 0);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored all ${count} card(s) from hand.`);
      return 'completed';
    }

    case 'databases_pick': {
      for (const cid of selectedIds) {
        const c = removeCardFromScore(stepExecPlayer, cid);
        returnCardInstance(state, c);
      }
      logStep(state, ctx, stepExecPlayer.id, true, `Returned ${selectedIds.length} card(s) from score pile.`);
      return 'completed';
    }

    case 'self_service_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      if (enqueueSelfExecute(state, ctx, stepExecPlayer, target)) return 'gameover';
      return 'completed';
    }

    case 'bioengineering_pick': {
      const owner = findCardOwnerBoard(state, selectedIds[0])!;
      const card = removeTopCardFromBoard(owner.player, owner.color);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Scored ${card.name} [${card.age}] from ${owner.player.name}'s board.`
      );
      return 'completed';
    }

    case 'fusion_pick_card': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const card = removeTopCardFromBoard(stepExecPlayer, target.color);
      scoreCardInstance(state, stepExecPlayer.id, card);
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(state, ctx, stepExecPlayer.id, isDemand, `Scored top ${card.name} [${card.age}].`);
      const nextOpts = ([card.age - 1, card.age - 2] as number[]).filter(
        (v): v is Age => v >= 1 && v <= 11
      );
      if (nextOpts.length === 0) return 'completed';
      if (nextOpts.length === 1) {
        return advanceFusionLoop(state, ctx, stepExecPlayer, isDemand, nextOpts[0], ability);
      }
      ctx.subState = { phase: 'fusion_pick_val', targetAge: card.age };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, `fus_v_${card.age}`, stepExecPlayer.id),
        kind: 'choose_value',
        playerId: stepExecPlayer.id,
        title: `${getTagPrefix(ctx, stepExecPlayer.id, isDemand)} (FUSION): Next value`,
        subtitle: ability.text,
        options: nextOpts,
      });
      return 'awaiting_prompt';
    }

    case 'fusion_pick_val': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose a valid next Fusion value.');
      }
      return advanceFusionLoop(state, ctx, stepExecPlayer, isDemand, action.selectedValue, ability);
    }

    case 'nfc_choose_val': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose a score value.');
      }
      const actPlayer = getPlayer(state, ctx.activatingPlayerId);
      const matching = stepExecPlayer.scorePile.filter((c) => c.age === action.selectedValue);
      for (const c of matching) {
        transferCard(
          state,
          { zone: 'score', playerId: stepExecPlayer.id },
          { zone: 'score', playerId: actPlayer.id },
          c.instanceId
        );
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Transferred ${matching.length} [${action.selectedValue}] card(s) to ${actPlayer.name}'s score pile.`
      );
      return 'completed';
    }

    case 'nfc_self_exec': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      state.revealedCardIds.push(target.instanceId);
      if (enqueueSelfExecute(state, ctx, stepExecPlayer, target)) return 'gameover';
      return 'completed';
    }

    case 'hypersonics_pick_val': {
      if (prompt.kind !== 'choose_value' || !action.selectedValue || !prompt.options.includes(action.selectedValue)) {
        throw new Error('Must choose a value.');
      }
      return executeHypersonicsValue(state, ctx, stepExecPlayer, action.selectedValue, ability);
    }

    case 'hypersonics_pick_cards': {
      const val = prevSubState?.chosenValue ?? 1;
      const targets = (prompt.kind === 'choose_cards'
        ? selectedIds.map((id) => prompt.candidates.find((c) => c.instanceId === id)!)
        : []);
      for (const c of targets) {
        const rem = removeTopCardFromBoard(stepExecPlayer, c.color);
        returnCardInstance(state, rem);
      }
      const retHand = stepExecPlayer.hand.filter((c) => c.age <= val);
      for (const c of retHand) {
        removeCardFromHand(stepExecPlayer, c.instanceId);
        returnCardInstance(state, c);
      }
      const retScore = stepExecPlayer.scorePile.filter((c) => c.age <= val);
      for (const c of retScore) {
        removeCardFromScore(stepExecPlayer, c.instanceId);
        returnCardInstance(state, c);
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Returned two top [${val}] cards, plus ${retHand.length} hand and ${retScore.length} score card(s) <= [${val}].`
      );
      return 'completed';
    }

    case 'climatology_choose_icon': {
      if (prompt.kind !== 'choose_option' || !action.selectedOptionId) throw new Error('Must choose an icon.');
      const icon = action.selectedOptionId as FunctionalIcon;
      const matching = getTopCards(stepExecPlayer.board).filter((c) => cardHasIcon(c, icon));
      if (matching.length === 0) {
        logStep(state, ctx, stepExecPlayer.id, true, `No top cards with ${ICON_LABELS[icon]}.`);
        return 'completed';
      }
      if (matching.length <= 2) {
        for (const c of matching) {
          const rem = removeTopCardFromBoard(stepExecPlayer, c.color);
          returnCardInstance(state, rem);
        }
        logStep(
          state,
          ctx,
          stepExecPlayer.id,
          true,
          `Returned ${matching.map((c) => c.name).join(', ')} (with ${ICON_LABELS[icon]}).`
        );
        return 'completed';
      }
      ctx.subState = { phase: 'climatology_return_cards', chosenIcon: icon };
      state.pendingPrompts.push({
        id: makePromptId(state, ctx, 'clim_rc', stepExecPlayer.id),
        kind: 'choose_cards',
        playerId: stepExecPlayer.id,
        title: `Demand (CLIMATOLOGY): ${ICON_LABELS[icon]}`,
        subtitle: ability.text,
        min: 2,
        max: 2,
        candidates: matching,
        sourceLabel: `Your top cards with ${ICON_LABELS[icon]}`,
        allowSkip: false,
      });
      return 'awaiting_prompt';
    }

    case 'climatology_return_cards': {
      const targets = (prompt.kind === 'choose_cards'
        ? selectedIds.map((id) => prompt.candidates.find((c) => c.instanceId === id)!)
        : []);
      for (const c of targets) {
        const rem = removeTopCardFromBoard(stepExecPlayer, c.color);
        returnCardInstance(state, rem);
      }
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        true,
        `Returned ${targets.map((c) => c.name).join(', ')}.`
      );
      return 'completed';
    }

    case 'climatology_ab2_pick': {
      const target = (prompt.kind === 'choose_cards'
        ? prompt.candidates.find((c) => c.instanceId === selectedIds[0])
        : undefined)!;
      const rem = removeTopCardFromBoard(stepExecPlayer, target.color);
      returnCardInstance(state, rem);
      const toRet = stepExecPlayer.scorePile.filter((c) => c.age >= rem.age);
      for (const s of toRet) {
        removeCardFromScore(stepExecPlayer, s.instanceId);
        returnCardInstance(state, s);
      }
      recordChange(ctx, stepExecPlayer.id, isDemand, true);
      logStep(
        state,
        ctx,
        stepExecPlayer.id,
        isDemand,
        `Returned top ${rem.name} [${rem.age}] and ${toRet.length} score card(s) >= [${rem.age}].`
      );
      return 'completed';
    }

    case 'escapism_pick': {
      const picked = stepExecPlayer.hand.find((c) => c.instanceId === selectedIds[0])!;
      return executeEscapismOnCard(state, ctx, stepExecPlayer, isDemand, picked);
    }

    default:
      return null;
  }
}
