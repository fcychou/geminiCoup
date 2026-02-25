import { GoogleGenAI } from "@google/genai";
import { Player, GameLog, ActionType, Role, PendingAction } from "../types";
import { ACTION_DETAILS } from "../constants";

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
    - Income (+1 coin)
    - Foreign Aid (+2 coins, blockable by Duke)
    - Tax (+3 coins, claims Duke, challengeable)
    - Steal (+2 coins from target, claims Captain, blockable by Captain/Ambassador - ONLY TARGET CAN BLOCK)
    - Exchange (swap cards, claims Ambassador)
    - Assassinate (-3 coins, eliminates influence, claims Assassin, blockable by Contessa - ONLY TARGET CAN BLOCK)
    - Coup (-7 coins, unblockable, eliminates influence)

    STRATEGIC GUIDELINES:
    1. **Analyze History (IMPORTANT)**: Look at 'lastLogs'. 
       - If you recently tried to bluff (e.g., Tax without a Duke) and were challenged, DO NOT try that same action again immediately.
       - If you tried to Steal from someone and they blocked you, choose a different target or action.
       - Avoid repeating the same action (like Income) more than twice in a row; it makes you predictable.
    
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
        // Mid-Game: Target the leader (Tall Poppy Syndrome)
        const leader = aliveOpponents.sort((a, b) => {
             const scoreA = a.coins + (a.cards.filter(c => !c.revealed).length * 5);
             const scoreB = b.coins + (b.cards.filter(c => !c.revealed).length * 5);
             return scoreB - scoreA;
        })[0];
        targetId = leader?.id;
    } else if (gamePhase === 'END_3P_PARADOX') {
        // 3-Player Paradox: If rich, forced to coup runner-up (second strongest) to avoid being weak vs third
        // Actually, standard logic is to hit the strongest threat.
        const sortedThreats = aliveOpponents.sort((a, b) => b.coins - a.coins);
        targetId = sortedThreats[0]?.id;
    } else {
        // Default: Target richest
        const richest = aliveOpponents.sort((a, b) => b.coins - a.coins)[0];
        targetId = richest?.id;
    }
    
    // Fallback safe target
    const safeTargetId = targetId || aliveOpponents[0]?.id;

    // -- History Analysis for Momentum --
    let lastAction: ActionType | null = null;
    let actionFailed = false;

    // Find last action by this bot
    for (let i = gameHistory.length - 1; i >= 0; i--) {
        const log = gameHistory[i];
        // Log format: "Name chose to Action..." or "Name attempts to Action..."
        if (log.message.startsWith(bot.name)) {
            if (log.message.includes(' attempts to ') || log.message.includes(' chose to ')) {
                const parts = log.message.split(' ');
                const toIndex = parts.indexOf('to');
                if (toIndex !== -1 && toIndex + 1 < parts.length) {
                     let extractedAction = parts[toIndex + 1];
                     if (extractedAction === 'Foreign' && parts[toIndex + 2] === 'Aid') {
                         extractedAction = 'Foreign Aid';
                     }
                     
                     // Clean up potential trailing punctuation or words (e.g. "Tax on...")
                     // The action name is usually clean, but let's be safe
                     const matchedAction = Object.values(ActionType).find(a => a === extractedAction);
                     
                     if (matchedAction) {
                         lastAction = matchedAction;
                         
                         // Check if it failed in subsequent logs
                         const subsequentLogs = gameHistory.slice(i + 1);
                         actionFailed = subsequentLogs.some(l => 
                            (l.message.includes(`${bot.name} accepts the block`)) || // Blocked and accepted
                            (l.message.includes(`${bot.name} CANNOT prove role`)) || // Challenged and lost
                            (l.message.includes(`${bot.name} must lose an influence`)) // Usually result of lost challenge
                         );
                         break; // Found the last action
                     }
                }
            }
        }
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
                 return Math.random() < 0.8 
                    ? { action: 'Block', decision: 'Block' }
                    : { action: 'Challenge', decision: 'Challenge' };
             }

             // Check if we are allowed to block
             let canBlock = true;
             
             const actionDetails = ACTION_DETAILS[pendingAction.action as ActionType];

             // 1. Check if action is blockable at all (Exchange, Tax, Income, Coup are not blockable)
             if (!actionDetails?.blockableBy || actionDetails.blockableBy.length === 0) {
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
                 
                 // Strategy: In End-Game 1v1, block aggressively even if bluffing
                 const bluffBlockChance = gamePhase === 'END_1V1' ? 0.4 : 0.15;
                 
                 if (hasBlocker && Math.random() > 0.05) return { action: 'Block', decision: 'Block' };
                 if (!hasBlocker && Math.random() < bluffBlockChance) return { action: 'Block', decision: 'Block' };
             }

             // Challenge logic
             // Check if the action is actually challengeable
             const isChallengeable = ACTION_DETAILS[pendingAction.action as ActionType]?.challengeable;
             
             if (isChallengeable) {
                 // Mid-Game: Strategic Sacrifice? Maybe challenge more often if low on influence to try and catch a bluff?
                 // For now, keep simple random challenge, but increase slightly in 1v1
                 const challengeChance = gamePhase === 'END_1V1' ? 0.15 : 0.05;
                 if (Math.random() < challengeChance) return { action: 'Challenge', decision: 'Challenge' };
             }
        } 
        // Case 2: Bot was blocked (BlockPending) - pendingAction.actorId === bot.id
        else if (pendingAction.blockerId) {
             let claimedRole: Role | null = null;
             if (pendingAction.action === ActionType.Tax) claimedRole = Role.Duke;
             if (pendingAction.action === ActionType.Steal) claimedRole = Role.Captain;
             if (pendingAction.action === ActionType.Assassinate) claimedRole = Role.Assassin;
             if (pendingAction.action === ActionType.Exchange) claimedRole = Role.Ambassador;

             const hasClaimedRole = claimedRole && bot.cards.some(c => !c.revealed && c.role === claimedRole);

             // If we have the card, 30% chance to challenge the block (aggressive)
             if (hasClaimedRole && Math.random() < 0.3) {
                 return { action: 'Challenge', decision: 'Challenge' };
             }
             // If we don't have the card, 5% chance to challenge (bluff challenge)
             if (!hasClaimedRole && Math.random() < 0.05) {
                 return { action: 'Challenge', decision: 'Challenge' };
             }
             
             return { action: 'Pass', decision: 'Pass' };
        }

        return { action: 'Pass', decision: 'Pass' };
    }

    // -- Action Logic (Turn Start) --

    // 1. Forced Coup
    if (bot.coins >= 10) return { action: ActionType.Coup, targetId: safeTargetId };
    
    // Check history to avoid repeating blocked moves
    const recentLogs = gameHistory.slice(-5);
    const wasBlockedRecently = recentLogs.some(l => l.message.includes(`${bot.name} accepts the block`));
    
    const liveRoles = bot.cards.filter(c => !c.revealed).map(c => c.role);
    
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
                 return { action: ActionType.Assassinate, targetId: safeTargetId };
            }
            // Priority 2: Steal (to reduce their coins below 7 threshold)
            // Even if bluffing Captain
            if (!wasBlockedRecently) {
                return { action: ActionType.Steal, targetId: safeTargetId };
            }
            // Priority 3: Tax (to get coins for Assassinate/Coup ASAP)
            return { action: ActionType.Tax };
        }
    }
    
    // End-Game 1v1: Captain is King
    if (gamePhase === 'END_1V1' && liveRoles.includes(Role.Captain)) {
        return { action: ActionType.Steal, targetId: safeTargetId };
    }
    
    // 4. Phase-Based Strategy
    const roll = Math.random();

    // -- Momentum Logic --
    // If the last action worked (bluff or not), high chance to repeat it.
    // We do this BEFORE phase logic to override it with "what's working".
    if (lastAction && !actionFailed && Math.random() < 0.6) {
        // Validate constraints for the repeated action
        let canRepeat = true;
        if (lastAction === ActionType.Assassinate && bot.coins < 3) canRepeat = false;
        if (lastAction === ActionType.Coup && bot.coins < 7) canRepeat = false;
        if (lastAction === ActionType.Steal && !safeTargetId) canRepeat = false;
        
        // Don't repeat Exchange too often, it's passive
        if (lastAction === ActionType.Exchange && Math.random() > 0.3) canRepeat = false;

        if (canRepeat) {
            return { action: lastAction, targetId: safeTargetId };
        }
    }

    if (gamePhase === 'EARLY') {
        // Early Game: Accumulation & Low Profile
        // High chance for Ambassador (Exchange) to fix hand
        if (roll < 0.3) return { action: ActionType.Exchange };
        
        // "Duke Tax": High reward, but risky. 
        if (roll < 0.6) return { action: ActionType.Tax }; // 30% chance
        
        // Slow Play: Income instead of Foreign Aid
        if (roll < 0.8) return { action: ActionType.Income }; // 20% chance
        
        // Foreign Aid (risky early due to many Dukes)
        return { action: ActionType.ForeignAid };
    }
    
    if (gamePhase === 'END_1V1') {
        // Aggressive Stealing (Bluffing Captain)
        if (!wasBlockedRecently && roll < 0.4) return { action: ActionType.Steal, targetId: safeTargetId };
        
        // Tax is always good
        if (roll < 0.7) return { action: ActionType.Tax };
        
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
        return { action: ActionType.Exchange };
    }

    if (roll < 0.3) return { action: ActionType.Income };
    if (roll < 0.6) return { action: ActionType.ForeignAid };
    if (roll < 0.85) return { action: ActionType.Tax }; // Bluff tax
    return { action: ActionType.Exchange };
};
