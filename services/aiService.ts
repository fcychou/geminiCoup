import { GoogleGenAI } from "@google/genai";
import { Player, GameLog, ActionType, Role, PendingAction } from "../types";
import { ACTION_DETAILS } from "../constants";

type RoleScore = Record<Role, number>;
type BeliefMap = Record<string, RoleScore>;

const AI_TUNING = {
    belief: {
        base: 1,
        actionAttempt: 0.8,
        block: 0.9,
        challengeFail: 2.2,
        challengeSuccess: -2.2,
        reveal: 1.2,
        normalizeDivisor: 4,
    },
    challenge: {
        base1v1: 0.12,
        baseMulti: 0.05,
        deadRoleFloor: 0.85,
        lowBeliefBonus: 0.25,
        doubleRoleFloor: 0.6,
        assassinateTargetBonus: 0.2,
        min: 0.05,
        max: 0.9,
    },
    blockChallenge: {
        base1v1: 0.25,
        baseMulti: 0.1,
        deadRoleFloor: 0.85,
        lowBeliefBonus: 0.25,
        noActionRolePenalty: 0.2,
        min: 0.05,
        max: 0.9,
    },
    threat: {
        liveCardWeight: 5,
        assassinWeight: 2.5,
        dukeWeight: 2.0,
        captainWeight: 1.5,
        contessaWeight: 0.5,
        coupThreshold7: 4,
        coupThreshold9: 2,
        finishBias: 2,
    },
    bluff: {
        block1v1: 0.4,
        blockMulti: 0.15,
        challengeRoleConfidence: 0.35,
    },
};

const roleScoreBase = (): RoleScore => ({
    [Role.Duke]: AI_TUNING.belief.base,
    [Role.Assassin]: AI_TUNING.belief.base,
    [Role.Captain]: AI_TUNING.belief.base,
    [Role.Ambassador]: AI_TUNING.belief.base,
    [Role.Contessa]: AI_TUNING.belief.base,
});

const getRoleForAction = (action: ActionType): Role[] => {
    switch(action) {
        case ActionType.Tax: return [Role.Duke];
        case ActionType.Assassinate: return [Role.Assassin];
        case ActionType.Steal: return [Role.Captain];
        case ActionType.Exchange: return [Role.Ambassador];
        default: return [];
    }
};

const countRevealedRoles = (players: Player[]) => {
    const counts: Record<Role, number> = {
        [Role.Duke]: 0,
        [Role.Assassin]: 0,
        [Role.Captain]: 0,
        [Role.Ambassador]: 0,
        [Role.Contessa]: 0,
    };
    players.forEach(p => {
        p.cards.forEach(c => {
            if (c.revealed) counts[c.role] += 1;
        });
    });
    return counts;
};

const buildBeliefs = (players: Player[], logs: GameLog[]) => {
    const beliefs: BeliefMap = {};
    players.forEach(p => { beliefs[p.id] = roleScoreBase(); });

    const revealedCounts = countRevealedRoles(players);
    const deadRoles = new Set<Role>(Object.values(Role).filter(r => revealedCounts[r] >= 3));

    const boost = (playerId: string, roles: Role[] | undefined, amount: number) => {
        if (!roles) return;
        const table = beliefs[playerId];
        if (!table) return;
        roles.forEach(r => {
            table[r] = Math.max(0, table[r] + amount);
        });
    };

    logs.forEach(l => {
        const meta = l.meta;
        if (!meta?.event || !meta.actorId) return;
        if (meta.event === 'action_attempt' && meta.action) {
            boost(meta.actorId, getRoleForAction(meta.action as ActionType), AI_TUNING.belief.actionAttempt);
        }
        if (meta.event === 'block' && meta.action) {
            boost(meta.actorId, ACTION_DETAILS[meta.action as ActionType]?.blockableBy, AI_TUNING.belief.block);
        }
        if (meta.event === 'challenge_fail') {
            boost(meta.actorId, meta.roles, AI_TUNING.belief.challengeFail);
        }
        if (meta.event === 'challenge_success') {
            boost(meta.actorId, meta.roles, AI_TUNING.belief.challengeSuccess);
        }
        if (meta.event === 'reveal') {
            boost(meta.actorId, meta.roles, AI_TUNING.belief.reveal);
        }
    });

    // If all copies of a role are revealed, no one can claim it.
    Object.values(Role).forEach(r => {
        if (!deadRoles.has(r)) return;
        players.forEach(p => {
            beliefs[p.id][r] = 0;
        });
    });

    return { beliefs, deadRoles };
};

const normalizeBelief = (score: number) => Math.max(0, Math.min(1, score / AI_TUNING.belief.normalizeDivisor));

const computeThreatScore = (player: Player, beliefs: BeliefMap) => {
    const liveCards = player.cards.filter(c => !c.revealed).length;
    const belief = beliefs[player.id] || roleScoreBase();
    const score =
        player.coins +
        liveCards * AI_TUNING.threat.liveCardWeight +
        normalizeBelief(belief[Role.Assassin]) * AI_TUNING.threat.assassinWeight +
        normalizeBelief(belief[Role.Duke]) * AI_TUNING.threat.dukeWeight +
        normalizeBelief(belief[Role.Captain]) * AI_TUNING.threat.captainWeight +
        normalizeBelief(belief[Role.Contessa]) * AI_TUNING.threat.contessaWeight +
        (player.coins >= 7 ? AI_TUNING.threat.coupThreshold7 : 0) +
        (player.coins >= 9 ? AI_TUNING.threat.coupThreshold9 : 0);
    return score;
};

const getAiClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
};

export const generateAiMove = async (
    bot: Player,
    players: Player[],
    gameHistory: GameLog[],
    pendingAction: PendingAction | null,
    phase: string
): Promise<{ action: string; targetId?: string; decision?: string }> => {
    const ai = getAiClient();
    if (!ai) {
        console.warn("No API Key found, using fallback random AI");
        return fallbackAiLogic(bot, players, pendingAction, gameHistory);
    }

    // Prepare a richer context for the AI
    const recentLogs = gameHistory.slice(-20).map(l => l.message); // Increased history
    
    const gameStateSummary = {
        myId: bot.id,
        myName: bot.name,
        myCoins: bot.coins,
        myLiveCards: bot.cards.filter(c => !c.revealed).map(c => c.role),
        allPlayers: players.map(p => ({
            id: p.id,
            name: p.name,
            coins: p.coins,
            liveCardsCount: p.cards.filter(c => !c.revealed).length,
            isEliminated: p.isEliminated
        })),
        phase: phase,
        pendingAction: pendingAction,
        lastLogs: recentLogs,
    };

    const prompt = `
    You are playing the board game "Coup". You are a bot named ${bot.name} (ID: ${bot.id}).
    Your goal is to be the last player standing.

    Current Game State:
    ${JSON.stringify(gameStateSummary, null, 2)}

    Valid Actions:
    - Income (+1 coin, UNBLOCKABLE, UNCHALLENGEABLE)
    - Foreign Aid (+2 coins, blockable by Duke, UNCHALLENGEABLE)
    - Tax (+3 coins, claims Duke, challengeable, UNBLOCKABLE)
    - Steal (+2 coins from target, claims Captain, blockable by Captain/Ambassador - ONLY TARGET CAN BLOCK, challengeable)
    - Exchange (swap cards, claims Ambassador, challengeable, UNBLOCKABLE)
    - Assassinate (-3 coins, eliminates influence, claims Assassin, blockable by Contessa - ONLY TARGET CAN BLOCK, challengeable)
    - Coup (-7 coins, UNBLOCKABLE, UNCHALLENGEABLE, eliminates influence)

    STRATEGIC GUIDELINES:
    1. **Analyze History (IMPORTANT)**: Look at 'lastLogs'. 
       - If you recently tried to bluff (e.g., Tax without a Duke) and were challenged, DO NOT try that same action again immediately.
       - If you tried to Steal from someone and they blocked you, choose a different target or action next time.
       - DO NOT REPEAT THE SAME ACTION more than twice in a row (especially Income, Steal, or Tax). Predictability leads to losing.
       - VARY YOUR STRATEGY: Even if a bluff worked, consider switching to a safe action or a different bluff to keep opponents guessing.
    
    2. **Turn Logic (Phase: TurnStart)**:
       - **Must Coup**: If you have >= 10 coins, you must choose 'Coup'.
       - **Finishing Move**: If you have >= 7 coins, prefer 'Coup' to eliminate a strong rival (high coins or 2 cards).
       - **Aggression**: If you have < 7 coins, prefer collecting coins quickly (Tax, Foreign Aid, Steal) over Income.
       - **Bluffing**: It is okay to bluff (e.g., Tax without Duke), but check if opponents have been challenging recently.
       - **Targeting**: When Stealing or Assassinating, target players with many coins (threats) or players with 1 card left (easy kill).

    3. **Reaction Logic (Phase: ActionPending)**:
       - If someone acts against you (e.g., Steal on you), and you have the blocker card, BLOCK it.
       - IMPORTANT: You can ONLY block Steal or Assassinate if YOU are the target. Do NOT block if you are not the target.
       - If you don't have the blocker, mostly Pass, unless you want to risk a bluff block.
       - If someone claims a role you hold (e.g., they claim Duke but you have 2 Dukes), CHALLENGE them!

    4. **Block Response (Phase: BlockPending)**:
       - If someone blocks you, and you actually have the card required for your action, CHALLENGE their block.
       - If you were bluffing, PASS (accept the block) to avoid losing a card.

    Output strictly valid JSON:
    {
      "decision": "ActionName" (e.g. "Tax", "Coup") or "Challenge" or "Block" or "Pass",
      "targetId": "TargetPlayerID" (Required for Steal, Coup, Assassinate. Optional otherwise.)
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                temperature: 1.0, // High creativity to vary moves
            }
        });

        const text = response.text;
        if (!text) throw new Error("Empty response from Gemini");
        const result = JSON.parse(text);
        
        // Basic validation ensuring target exists if needed
        if (['Steal', 'Coup', 'Assassinate'].includes(result.decision) && !result.targetId) {
            // Auto-pick a target if AI forgot
            const validTargets = players.filter(p => !p.isEliminated && p.id !== bot.id);
            if (validTargets.length > 0) {
                // Pick richest target
                result.targetId = validTargets.sort((a,b) => b.coins - a.coins)[0].id;
            }
        }

        return {
            action: result.decision,
            targetId: result.targetId,
            decision: result.decision
        };
    } catch (error: any) {
        // Fallback
        if (error?.status === 429 || error?.code === 429 || error?.message?.includes('429')) {
             console.warn("Gemini Quota Exceeded. Switching to basic AI.");
        } else {
             console.error("Gemini Error:", error);
        }
        return fallbackAiLogic(bot, players, pendingAction, gameHistory);
    }
};

const fallbackAiLogic = (bot: Player, players: Player[], pendingAction: PendingAction | null, gameHistory: GameLog[] = []) => {
    const aliveOpponents = players.filter(p => !p.isEliminated && p.id !== bot.id);
    const { beliefs, deadRoles } = buildBeliefs(players, gameHistory);
    
    // -- Phase Detection --
    const totalPlayers = players.length;
    const aliveCount = aliveOpponents.length + 1;
    const maxCoins = Math.max(...players.map(p => p.coins));
    
    let gamePhase = 'MID';
    if (aliveCount > 3 || (aliveCount > 2 && maxCoins < 5)) {
        gamePhase = 'EARLY';
    } else if (aliveCount === 2) {
        gamePhase = 'END_1V1';
    } else if (aliveCount === 3 && players.every(p => p.isEliminated || p.cards.filter(c => !c.revealed).length === 1)) {
        gamePhase = 'END_3P_PARADOX';
    }

    // -- Target Selection Strategy --
    let targetId: string | undefined;
    
    if (gamePhase === 'MID') {
        // Mid-Game: Target the leader by threat score
        const leader = aliveOpponents
            .slice()
            .sort((a, b) => computeThreatScore(b, beliefs) - computeThreatScore(a, beliefs))[0];
        targetId = leader?.id;
    } else if (gamePhase === 'END_3P_PARADOX') {
        // 3-Player Paradox: If rich, forced to coup runner-up (second strongest) to avoid being weak vs third
        // Actually, standard logic is to hit the strongest threat.
        const sortedThreats = aliveOpponents
            .slice()
            .sort((a, b) => computeThreatScore(b, beliefs) - computeThreatScore(a, beliefs));
        targetId = sortedThreats[0]?.id;
    } else {
        // Default: Target highest threat
        const richest = aliveOpponents
            .slice()
            .sort((a, b) => computeThreatScore(b, beliefs) - computeThreatScore(a, beliefs))[0];
        targetId = richest?.id;
    }

    // Prefer finishing a 1-influence opponent if they are a real threat
    if (aliveOpponents.length > 0) {
        const killable = aliveOpponents
            .filter(p => p.cards.filter(c => !c.revealed).length === 1)
            .sort((a, b) => computeThreatScore(b, beliefs) - computeThreatScore(a, beliefs));
        if (killable[0] && targetId) {
            const currentTarget = players.find(p => p.id === targetId);
            if (currentTarget) {
                const currentThreat = computeThreatScore(currentTarget, beliefs);
                const killThreat = computeThreatScore(killable[0], beliefs);
                if (killThreat >= currentThreat - AI_TUNING.threat.finishBias) {
                    targetId = killable[0].id;
                }
            }
        } else if (killable[0]) {
            targetId = killable[0].id;
        }
    }
    
    // Fallback safe target
    const safeTargetId = targetId || aliveOpponents[0]?.id;

    // -- History Analysis for Momentum --
    let lastAction: ActionType | null = null;
    let actionFailed = false;
    const lastActionLog = [...gameHistory].reverse().find(l => l.meta?.event === 'action_attempt' && l.meta.actorId === bot.id);
    if (lastActionLog?.meta?.action) {
        lastAction = lastActionLog.meta.action;
        const subsequentLogs = gameHistory.filter(l => l.timestamp > lastActionLog.timestamp);
        actionFailed = subsequentLogs.some(l => 
            l.meta?.event === 'action_fail' && l.meta.actorId === bot.id && l.meta.action === lastAction
        );
    }


    if (pendingAction) {
        // Case 1: Bot is reacting to someone else's action (ActionPending)
        if (pendingAction.actorId !== bot.id) {

             // -- Desperation Logic --
             // If targeted by Assassinate and only 1 card left, we are dead if we do nothing.
             // We MUST fight back (Block or Challenge) because we have nothing to lose.
             if (pendingAction.action === ActionType.Assassinate && 
                 pendingAction.targetId === bot.id && 
                 bot.cards.filter(c => !c.revealed).length === 1) {
                 
                 const hasContessa = bot.cards.some(c => !c.revealed && c.role === Role.Contessa);
                 // If we have Contessa, obviously block
                 if (hasContessa) return { action: 'Block', decision: 'Block' };
                 
                 // If we don't, we must bluff.
                 // Blocking (claiming Contessa) is usually better than Challenging (claiming they don't have Assassin),
                 // because they might actually have the Assassin.
                 // 80% Block, 20% Challenge
                 if (deadRoles.has(Role.Contessa)) return { action: 'Challenge', decision: 'Challenge' };
                 return Math.random() < 0.8 
                    ? { action: 'Block', decision: 'Block' }
                    : { action: 'Challenge', decision: 'Challenge' };
             }

             const actionDetails = ACTION_DETAILS[pendingAction.action as ActionType];
             const claimedRoles = getRoleForAction(pendingAction.action as ActionType);
             const actorBelief = beliefs[pendingAction.actorId] || roleScoreBase();
             const claimConfidence = claimedRoles.length
                ? Math.max(...claimedRoles.map(r => normalizeBelief(actorBelief[r])))
                : 0;
             const deadRoleClaim = claimedRoles.some(r => deadRoles.has(r));

             const botRoleCounts = bot.cards
                .filter(c => !c.revealed)
                .reduce<Record<Role, number>>((acc, c) => {
                    acc[c.role] = (acc[c.role] || 0) + 1;
                    return acc;
                }, {
                    [Role.Duke]: 0,
                    [Role.Assassin]: 0,
                    [Role.Captain]: 0,
                    [Role.Ambassador]: 0,
                    [Role.Contessa]: 0,
                });
             const hasDoubleRole = claimedRoles.some(r => botRoleCounts[r] >= 2);

             // Check if we are allowed to block
             let canBlock = true;
            
             // 1. Check if action is blockable at all (Exchange, Tax, Income, Coup are not blockable)
             if (!actionDetails?.blockableBy || actionDetails.blockableBy.length === 0) {
                 canBlock = false;
             }

             // Ensure non-blockable actions (Exchange, Tax) are never blocked by the fallback logic
             if (pendingAction.action === ActionType.Exchange || pendingAction.action === ActionType.Tax) {
                 canBlock = false;
             }

             // -- 1v1 Desperation Block (Stop Foreign Aid) --
             // If opponent is taking Foreign Aid to reach Coup range (7+), we MUST stop them.
             if (gamePhase === 'END_1V1' && 
                 pendingAction.action === ActionType.ForeignAid && 
                 bot.cards.filter(c => !c.revealed).length === 1) {
                 
                 const opponent = players.find(p => p.id === pendingAction.actorId);
                 if (opponent && opponent.coins >= 5) {
                     // They are threatening to win. Block!
                     // If we have Duke, great. If not, bluff Duke.
                     return { action: 'Block', decision: 'Block' };
                 }
             }

             // 2. Target specific checks
             if (pendingAction.action === 'Steal' || pendingAction.action === 'Assassinate') {
                 if (pendingAction.targetId !== bot.id) canBlock = false;
             }

             if (canBlock) {
                 // Block if we have the card
                 const myBlockers = actionDetails?.blockableBy || [];
                 const hasBlocker = bot.cards.some(c => !c.revealed && myBlockers.includes(c.role));
                 const bluffPossible = myBlockers.some(r => !deadRoles.has(r));
                 
                 // Strategy: In End-Game 1v1, block aggressively even if bluffing
                 const bluffBlockChance = gamePhase === 'END_1V1' ? AI_TUNING.bluff.block1v1 : AI_TUNING.bluff.blockMulti;
                 
                 if (hasBlocker && Math.random() > 0.05) return { action: 'Block', decision: 'Block' };
                 if (!hasBlocker && bluffPossible && Math.random() < bluffBlockChance) return { action: 'Block', decision: 'Block' };
             }

             // Challenge logic
             // Check if the action is actually challengeable
             const isChallengeable = actionDetails?.challengeable;
             
             if (isChallengeable) {
                 // Mid-Game: Strategic Sacrifice? Maybe challenge more often if low on influence to try and catch a bluff?
                 // For now, keep simple random challenge, but increase slightly in 1v1
                 const isTarget = pendingAction.targetId === bot.id;
                 const lowInfluence = bot.cards.filter(c => !c.revealed).length === 1;
                 let challengeChance = gamePhase === 'END_1V1' ? AI_TUNING.challenge.base1v1 : AI_TUNING.challenge.baseMulti;
                 if (deadRoleClaim) challengeChance = Math.max(challengeChance, AI_TUNING.challenge.deadRoleFloor);
                 if (claimConfidence < AI_TUNING.bluff.challengeRoleConfidence) challengeChance += AI_TUNING.challenge.lowBeliefBonus;
                 if (hasDoubleRole) challengeChance = Math.max(challengeChance, AI_TUNING.challenge.doubleRoleFloor);
                 if (isTarget && pendingAction.action === ActionType.Assassinate && lowInfluence) challengeChance += AI_TUNING.challenge.assassinateTargetBonus;
                 challengeChance = Math.min(AI_TUNING.challenge.max, challengeChance);
                 if (Math.random() < challengeChance) return { action: 'Challenge', decision: 'Challenge' };
             }
        } 
        // Case 2: Bot was blocked (BlockPending) - pendingAction.actorId === bot.id
        else if (pendingAction.blockerId) {
             const blockRoles = ACTION_DETAILS[pendingAction.action]?.blockableBy || [];
             const blockerBelief = beliefs[pendingAction.blockerId] || roleScoreBase();
             const blockConfidence = blockRoles.length
                ? Math.max(...blockRoles.map(r => normalizeBelief(blockerBelief[r])))
                : 0;
             const deadBlockClaim = blockRoles.some(r => deadRoles.has(r));

             const actionRoles = getRoleForAction(pendingAction.action);
             const hasActionRole = actionRoles.some(r => bot.cards.some(c => !c.revealed && c.role === r));

             let challengeChance = gamePhase === 'END_1V1' ? AI_TUNING.blockChallenge.base1v1 : AI_TUNING.blockChallenge.baseMulti;
             if (deadBlockClaim) challengeChance = Math.max(challengeChance, AI_TUNING.blockChallenge.deadRoleFloor);
             if (blockConfidence < AI_TUNING.bluff.challengeRoleConfidence) challengeChance += AI_TUNING.blockChallenge.lowBeliefBonus;
             if (!hasActionRole) challengeChance -= AI_TUNING.blockChallenge.noActionRolePenalty;
             challengeChance = Math.max(AI_TUNING.blockChallenge.min, Math.min(AI_TUNING.blockChallenge.max, challengeChance));

             if (Math.random() < challengeChance) return { action: 'Challenge', decision: 'Challenge' };
             
             return { action: 'Pass', decision: 'Pass' };
        }

        return { action: 'Pass', decision: 'Pass' };
    }

    // -- Action Logic (Turn Start) --

    // 1. Forced Coup
    if (bot.coins >= 10) return { action: ActionType.Coup, targetId: safeTargetId };
    
    // Check history to avoid repeating blocked moves
    const recentLogs = gameHistory.slice(-8);
    const wasBlockedRecently = recentLogs.some(l => 
        l.meta?.event === 'action_fail' && l.meta.actorId === bot.id && (l.meta.reason === 'block' || l.meta.reason === 'block_accept')
    );
    
    const liveRoles = bot.cards.filter(c => !c.revealed).map(c => c.role);
    const canClaimRole = (role: Role) => !deadRoles.has(role);
    
    // 2. End-Game 3-Player Paradox: If rich, maybe delay coup if not forced?
    // Actually, if we have 7+ coins, we usually want to Coup to eliminate a threat.
    if (bot.coins >= 7) {
        // In 3-player paradox, if we coup, we are left with 0 coins against the 3rd player.
        // But we can't skip turn. We must take an action. 
        // If we have 7-9 coins, we COULD choose not to Coup yet (e.g. Tax/Steal) to build a bigger buffer?
        // But standard logic is Coup. Let's stick to Coup for now unless specifically trying to be clever.
        return { action: ActionType.Coup, targetId: safeTargetId };
    }

    // 3. Card-Based Actions (High Priority)
    if (liveRoles.includes(Role.Assassin) && bot.coins >= 3) {
         return { action: ActionType.Assassinate, targetId: safeTargetId };
    }
    
    // -- 1v1 Desperation Attack --
    // If opponent is close to Coup (5+ coins) and we are vulnerable (1 card), we must act fast.
    if (gamePhase === 'END_1V1' && bot.cards.filter(c => !c.revealed).length === 1) {
        const opponent = aliveOpponents[0];
        if (opponent && opponent.coins >= 5) {
            // Priority 1: Assassinate (if we have coins) - even if bluffing Assassin
            if (bot.coins >= 3) {
                 if (liveRoles.includes(Role.Assassin) || canClaimRole(Role.Assassin)) {
                    return { action: ActionType.Assassinate, targetId: safeTargetId };
                 }
            }
            // Priority 2: Steal (to reduce their coins below 7 threshold)
            // Even if bluffing Captain
            if (!wasBlockedRecently && (liveRoles.includes(Role.Captain) || canClaimRole(Role.Captain))) {
                return { action: ActionType.Steal, targetId: safeTargetId };
            }
            // Priority 3: Tax (to get coins for Assassinate/Coup ASAP)
            if (canClaimRole(Role.Duke)) return { action: ActionType.Tax };
            return { action: ActionType.Income };
        }
    }
    
    // End-Game 1v1: Captain is King
    if (gamePhase === 'END_1V1' && (liveRoles.includes(Role.Captain) || canClaimRole(Role.Captain))) {
        return { action: ActionType.Steal, targetId: safeTargetId };
    }
    
    // 4. Phase-Based Strategy
    const roll = Math.random();

    // -- Momentum Logic --
    // If the last action worked (bluff or not), there's a chance to repeat it.
    // We reduced this from 0.6 to 0.3 to prevent predictable repetitive behavior.
    if (lastAction && !actionFailed && Math.random() < 0.3) {
        // Validate constraints for the repeated action
        let canRepeat = true;
        if (lastAction === ActionType.Assassinate && bot.coins < 3) canRepeat = false;
        if (lastAction === ActionType.Coup && bot.coins < 7) canRepeat = false;
        if (lastAction === ActionType.Steal && !safeTargetId) canRepeat = false;
        if (lastAction === ActionType.Tax && !canClaimRole(Role.Duke)) canRepeat = false;
        if (lastAction === ActionType.Exchange && !canClaimRole(Role.Ambassador)) canRepeat = false;
        if (lastAction === ActionType.Steal && !canClaimRole(Role.Captain)) canRepeat = false;
        if (lastAction === ActionType.Assassinate && !canClaimRole(Role.Assassin)) canRepeat = false;
        
        // If it's Steal and it was blocked by target, definitely don't repeat immediately on same target
        if (lastAction === ActionType.Steal && wasBlockedRecently) canRepeat = false;

        // Don't repeat Exchange too often, it's passive
        if (lastAction === ActionType.Exchange && Math.random() > 0.3) canRepeat = false;

        if (canRepeat) {
            return { action: lastAction, targetId: safeTargetId };
        }
    }

    if (gamePhase === 'EARLY') {
        // Early Game: Accumulation & Low Profile
        // High chance for Ambassador (Exchange) to fix hand
        if (roll < 0.3 && canClaimRole(Role.Ambassador)) return { action: ActionType.Exchange };
        
        // "Duke Tax": High reward, but risky. 
        if (roll < 0.6 && canClaimRole(Role.Duke)) return { action: ActionType.Tax }; // 30% chance
        
        // Slow Play: Income instead of Foreign Aid
        if (roll < 0.8) return { action: ActionType.Income }; // 20% chance
        
        // Foreign Aid (risky early due to many Dukes)
        return { action: ActionType.ForeignAid };
    }
    
    if (gamePhase === 'END_1V1') {
        // Aggressive Stealing (Bluffing Captain)
        if (!wasBlockedRecently && roll < 0.4 && canClaimRole(Role.Captain)) return { action: ActionType.Steal, targetId: safeTargetId };
        
        // Tax is always good
        if (roll < 0.7 && canClaimRole(Role.Duke)) return { action: ActionType.Tax };
        
        return { action: ActionType.Income };
    }

    // Default / Mid-Game Logic
    if (liveRoles.includes(Role.Captain)) {
        if (!wasBlockedRecently || Math.random() > 0.7) {
            return { action: ActionType.Steal, targetId: safeTargetId };
        }
    }
    
    if (liveRoles.includes(Role.Duke)) {
        return { action: ActionType.Tax };
    }

    // If blocked recently, prefer safe income/foreign aid
    if (wasBlockedRecently) {
        if (roll < 0.5) return { action: ActionType.Income };
        if (roll < 0.9) return { action: ActionType.ForeignAid };
        if (canClaimRole(Role.Ambassador)) return { action: ActionType.Exchange };
        return { action: ActionType.Income };
    }

    if (roll < 0.3) return { action: ActionType.Income };
    if (roll < 0.6) return { action: ActionType.ForeignAid };
    if (roll < 0.85 && canClaimRole(Role.Duke)) return { action: ActionType.Tax }; // Bluff tax
    if (canClaimRole(Role.Ambassador)) return { action: ActionType.Exchange };
    return { action: ActionType.Income };
};
