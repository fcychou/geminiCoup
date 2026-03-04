import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ROLES, ACTION_DETAILS, ROLE_DESCRIPTIONS, ROLE_COLORS } from './constants';
import { Player, Card, GamePhase, Role, ActionType, GameLog, PendingAction } from './types';
import PlayerSpot from './components/PlayerSpot';
import CardComponent from './components/Card';
import { generateAiMove } from './services/aiService';

// -- Helper Functions --
const shuffle = <T,>(array: T[]): T[] => {
  return [...array].sort(() => Math.random() - 0.5);
};

const createDeck = (): Card[] => {
  let deck: Card[] = [];
  ROLES.forEach(role => {
    // 3 copies of each card
    for (let i = 0; i < 3; i++) {
      deck.push({ id: uuidv4(), role, revealed: false });
    }
  });
  return shuffle(deck);
};

// -- Main Component --
const App: React.FC = () => {
  // Setup State
  const [gameStarted, setGameStarted] = useState(false);
  const [numBots, setNumBots] = useState(3);

  // Game State
  const [players, setPlayers] = useState<Player[]>([]);
  const [deck, setDeck] = useState<Card[]>([]);
  const [turnIndex, setTurnIndex] = useState(0);
  const [phase, setPhase] = useState<GamePhase>(GamePhase.Setup);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [logs, setLogs] = useState<GameLog[]>([]);
  const [winner, setWinner] = useState<Player | null>(null);
  const [targetingAction, setTargetingAction] = useState<ActionType | null>(null);

  // UI State
  const [isProcessing, setIsProcessing] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [exchangeCards, setExchangeCards] = useState<Card[]>([]);
  const [selectedExchangeCards, setSelectedExchangeCards] = useState<string[]>([]);
  
  // Animation State
  const [playerNotifications, setPlayerNotifications] = useState<Record<string, { message: string, type: 'gain' | 'loss' | 'info' | 'error' | 'action' } | null>>({});
  
  // Logic Flow State
  const [resumeCallback, setResumeCallback] = useState<(() => void) | null>(null);
  const [aiChecksComplete, setAiChecksComplete] = useState(false);

  // Refs for consistent state access in timeouts/async logic
  const stateRef = useRef({ players, deck, turnIndex, gameStarted });
  useEffect(() => {
      stateRef.current = { players, deck, turnIndex, gameStarted };
  }, [players, deck, turnIndex, gameStarted]);

  // Scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Reset checks when turn/action context changes
  useEffect(() => {
      setAiChecksComplete(false);
  }, [pendingAction, phase]);

  // -- Logging & Animation Helpers --
  const addLog = (message: string, type: GameLog['type'] = 'info', meta?: GameLog['meta']) => {
    setLogs(prev => [...prev, { id: uuidv4(), message, timestamp: Date.now(), type, meta }]);
  };

  const showAnim = (playerId: string, message: string, type: 'gain' | 'loss' | 'info' | 'error' | 'action' = 'info') => {
      setPlayerNotifications(prev => ({ ...prev, [playerId]: { message, type } }));
      // Clear after animation duration (approx 2s for float-up, shorter for others)
      setTimeout(() => {
          setPlayerNotifications(prev => ({ ...prev, [playerId]: null }));
      }, 2000);
  };

  // -- Game Initialization --
  const startGame = () => {
    const newDeck = createDeck();
    const newPlayers: Player[] = [];

    // Human Player
    newPlayers.push({
      id: 'p1',
      name: 'You',
      isAi: false,
      coins: 2,
      cards: [newDeck.pop()!, newDeck.pop()!],
      isEliminated: false
    });

    // Bots
    for (let i = 0; i < numBots; i++) {
      newPlayers.push({
        id: `bot-${i + 1}`,
        name: `Bot ${i + 1}`,
        isAi: true,
        coins: 2,
        cards: [newDeck.pop()!, newDeck.pop()!],
        isEliminated: false
      });
    }

    setDeck(newDeck);
    setPlayers(newPlayers);
    setTurnIndex(0);
    setPhase(GamePhase.TurnStart);
    setLogs([]);
    setGameStarted(true);
    setWinner(null);
    setResumeCallback(null);
    setTargetingAction(null);
    setPendingAction(null);
    setExchangeCards([]);
    setSelectedExchangeCards([]);
    setIsProcessing(false);
    setAiChecksComplete(false);
    setPlayerNotifications({});
    
    addLog(`Game started with ${numBots} bots.`, 'info');
  };

  const quitGame = () => {
      // Remove confirmation to ensure immediate feedback and avoid browser blocking
      setGameStarted(false);
      setPhase(GamePhase.Setup);
      setWinner(null);
      setLogs([]);
      setPlayers([]);
      setDeck([]);
      setTurnIndex(0); // Reset turn index
      setPendingAction(null);
      setTargetingAction(null);
      setIsProcessing(false);
      setResumeCallback(null);
      setExchangeCards([]);
      setSelectedExchangeCards([]);
      setAiChecksComplete(false);
      setPlayerNotifications({});
  };

  const currentPlayer = players[turnIndex];
  
  // -- Turn Management --
  const nextTurn = useCallback(() => {
    // Use Ref to ensure we have the latest state even if called via stale closure
    const { players: currentPlayers, turnIndex: currentTurnIndex, gameStarted: isGameRunning } = stateRef.current;
    
    if (!isGameRunning || currentPlayers.length === 0) return;

    let nextIndex = (currentTurnIndex + 1) % currentPlayers.length;
    let loopCount = 0;
    
    // Find next alive player
    while (currentPlayers[nextIndex].isEliminated && loopCount < currentPlayers.length) {
      nextIndex = (nextIndex + 1) % currentPlayers.length;
      loopCount++;
    }

    // Check Win Condition
    const alivePlayers = currentPlayers.filter(p => !p.isEliminated);
    if (alivePlayers.length <= 1) {
      setWinner(alivePlayers[0]);
      setPhase(GamePhase.GameOver);
      addLog(`${alivePlayers[0]?.name} wins the game!`, 'info');
      return;
    }

    setTurnIndex(nextIndex);
    setPhase(GamePhase.TurnStart);
    setPendingAction(null);
    setIsProcessing(false);
  }, []);

  // -- Phase Transition Effect --
  useEffect(() => {
      if (!gameStarted) return;
      if (phase === GamePhase.Resolving) {
          const timer = setTimeout(() => {
              if (stateRef.current.gameStarted) {
                  nextTurn();
              }
          }, 500);
          return () => clearTimeout(timer);
      }
  }, [phase, nextTurn, gameStarted]);

  // -- AI Logic Trigger --
  useEffect(() => {
    if (!gameStarted || phase === GamePhase.GameOver || winner) return;

    const runAiTurn = async () => {
      // 1. AI is the Active Player trying to make a move
      if (currentPlayer?.isAi && phase === GamePhase.TurnStart && !isProcessing) {
        setIsProcessing(true);
        // Simulate thinking time
        await new Promise(r => setTimeout(r, 100));
        
        if (!stateRef.current.gameStarted) return;

        const decision = await generateAiMove(currentPlayer, players, logs, null, phase);
        
        if (!stateRef.current.gameStarted) return;

        const targetedActions = [ActionType.Steal, ActionType.Assassinate, ActionType.Coup];
        const showTarget = targetedActions.includes(decision.action as ActionType) && decision.targetId;

        addLog(
          `${currentPlayer.name} chose to ${decision.action}${showTarget ? ` on ${getPlayerName(decision.targetId!)}` : ''}`,
          'action',
          { event: 'action_chosen', action: decision.action as ActionType, actorId: currentPlayer.id, targetId: decision.targetId }
        );
        
        handleActionSelect(decision.action as ActionType, decision.targetId);
        setIsProcessing(false);
      }
    };
    
    runAiTurn();
  }, [currentPlayer, phase, gameStarted, isProcessing, players, logs, winner]); 

  // -- AI Reaction Handling --
  useEffect(() => {
      if (!gameStarted || winner) return;

      const handleAiReactions = async () => {
          // Scenario 1: Pending Action (Someone acted, waiting for reactions)
          if (phase === GamePhase.ActionPending && pendingAction && !isProcessing && !aiChecksComplete) {
             const actor = players.find(p => p.id === pendingAction.actorId);
             
             const potentialBotChallengers = players.filter(p => p.isAi && !p.isEliminated && p.id !== pendingAction.actorId);
             
             if (potentialBotChallengers.length > 0) {
                 const human = players.find(p => p.id === 'p1');
                 const shouldAutoCheck = pendingAction.actorId === 'p1' || human?.isEliminated || pendingAction.actorId !== 'p1';

                 if (shouldAutoCheck) {
                     setIsProcessing(true);
                     let interrupted = false;
                     
                     // Delay for suspense
                     await new Promise(r => setTimeout(r, 200));

                     if (!stateRef.current.gameStarted) return;

                     for (const bot of potentialBotChallengers) {
                         const decision = await generateAiMove(bot, players, logs, pendingAction, phase);
                         if (decision.decision === 'Challenge') {
                             handleChallenge(bot.id);
                             interrupted = true;
                             break;
                         } else if (decision.decision === 'Block') {
                             handleBlock(bot.id);
                             interrupted = true;
                             break;
                         }
                     }

                     if (!stateRef.current.gameStarted) return;

                     if (!interrupted) {
                         setAiChecksComplete(true);
                         const human = players.find(p => p.id === 'p1');
                         const isBlockable = pendingAction.action ? !!ACTION_DETAILS[pendingAction.action].blockableBy : false;
                         
                         // If action is blockable and human is the target, don't auto-resolve
                         const humanIsTarget = pendingAction.targetId === 'p1';
                         
                         if (pendingAction.actorId === 'p1' || human?.isEliminated || (pendingAction.actorId !== 'p1' && !humanIsTarget && !isBlockable)) {
                             resolveAction();
                         }
                     }
                     setIsProcessing(false);
                 }
             } else if (players.find(p => p.id === 'p1')?.isEliminated && pendingAction.actorId !== 'p1') {
                 resolveAction();
             }
          }
          
          // Scenario 2: Block Pending (Someone blocked).
          if (phase === GamePhase.BlockPending && pendingAction?.blockerId && !aiChecksComplete) {
             const actor = players.find(p => p.id === pendingAction.actorId);
             
             if (actor?.isAi && !isProcessing) {
                 setIsProcessing(true);
                 await new Promise(r => setTimeout(r, 200));
                 
                 if (!stateRef.current.gameStarted) return;

                 const decision = await generateAiMove(actor, players, logs, pendingAction, phase);
                 if (decision.decision === 'Challenge') {
                     handleChallenge(actor.id); 
                 } else {
                     addLog(
                       `${actor.name} accepts the block.`,
                       'info',
                       { event: 'action_fail', action: pendingAction.action, actorId: pendingAction.actorId, reason: 'block_accept' }
                     );
                     setPhase(GamePhase.Resolving); 
                 }
                 setAiChecksComplete(true);
                 setIsProcessing(false);
             }
          }
      };

      handleAiReactions();
  }, [phase, pendingAction, gameStarted, isProcessing, players, winner, aiChecksComplete]);

  // -- Core Game Logic --

  const getPlayerName = (id?: string) => players.find(p => p.id === id)?.name || 'Unknown';

  const handleActionSelect = (action: ActionType, targetId?: string) => {
    // Guard clause against undefined currentPlayer
    if (!currentPlayer) return;

    // If target required but not provided, enter targeting mode
    if ((action === ActionType.Steal || action === ActionType.Assassinate || action === ActionType.Coup) && !targetId) {
        setTargetingAction(action);
        return;
    }

    setTargetingAction(null); // Clear targeting mode

    // Validate costs
    if (action === ActionType.Coup && currentPlayer.coins < 7) {
        addLog("Not enough coins for Coup!", 'error');
        showAnim(currentPlayer.id, "Need 7 Coins", 'error');
        return;
    }
    if (action === ActionType.Assassinate && currentPlayer.coins < 3) {
        addLog("Not enough coins for Assassinate!", 'error');
        showAnim(currentPlayer.id, "Need 3 Coins", 'error');
        return;
    }
    
    // Pay costs up front? Coup/Assassinate usually pay immediately but can be blocked/challenged
    // In Coup rules, you pay to take the action.
    if (action === ActionType.Coup) {
        updateCoins(currentPlayer.id, -7);
    }
    if (action === ActionType.Assassinate) {
        updateCoins(currentPlayer.id, -3);
    }

    const newPending: PendingAction = { action, actorId: currentPlayer.id, targetId };
    setPendingAction(newPending);
    setAiChecksComplete(false);
    
    addLog(
      `${currentPlayer.name} attempts to ${action}${targetId ? ` on ${getPlayerName(targetId)}` : ''}`,
      'action',
      { event: 'action_attempt', action, actorId: currentPlayer.id, targetId }
    );
    
    // Animate Action Declaration
    showAnim(currentPlayer.id, action, 'action');
    if (targetId) {
        // Delay slighty so it doesn't overlap perfectly with actor animation
        setTimeout(() => showAnim(targetId, "Targeted!", 'error'), 200);
    }

    // Immediate resolution actions
    if (action === ActionType.Income) {
        resolveAction(newPending);
        return;
    }
    
    if (action === ActionType.Coup) {
        resolveAction(newPending);
        return;
    }

    setPhase(GamePhase.ActionPending);
  };

  const resolveAction = (actionToResolve = pendingAction) => {
    if (!actionToResolve) return;

    const { action, actorId, targetId } = actionToResolve;
    
    switch (action) {
        case ActionType.Income:
            updateCoins(actorId, 1);
            break;
        case ActionType.ForeignAid:
            updateCoins(actorId, 2);
            break;
        case ActionType.Tax:
            updateCoins(actorId, 3);
            break;
        case ActionType.Steal:
            if (targetId) {
                // Use Ref or callback to get latest coins to avoid race conditions
                const target = stateRef.current.players.find(p => p.id === targetId);
                const amount = Math.min(2, target?.coins || 0);

                setPlayers(prev => {
                    return prev.map(p => {
                        if (p.id === targetId) return { ...p, coins: p.coins - amount };
                        if (p.id === actorId) return { ...p, coins: p.coins + amount };
                        return p;
                    });
                });
                
                // Animate Steal
                if (amount > 0) {
                   showAnim(actorId, `+${amount} Coins`, 'gain');
                   showAnim(targetId, `-${amount} Coins`, 'loss');
                } else {
                   showAnim(actorId, "No Coins!", 'error');
                }
            }
            break;
        case ActionType.Assassinate:
        case ActionType.Coup:
            if (targetId) {
                showAnim(targetId, "ATTACKED!", 'error');
                if (targetId === 'p1') {
                    loseInfluence(targetId);
                    // On resolve after human loses influence, we finish turn
                    setResumeCallback(() => () => setPhase(GamePhase.Resolving));
                    return; 
                }
                loseInfluence(targetId);
            }
            break;
        case ActionType.Exchange:
            handleExchangeStart(actorId);
            return; 
    }

    setPhase(GamePhase.Resolving);
  };

  const updateCoins = (playerId: string, amount: number) => {
    setPlayers(prev => prev.map(p => p.id === playerId ? { ...p, coins: Math.max(0, p.coins + amount) } : p));
    if (amount > 0) showAnim(playerId, `+${amount}`, 'gain');
    if (amount < 0) showAnim(playerId, `${amount}`, 'loss');
  };

  // -- Challenge & Block Logic --

  const handleBlock = (blockerId: string) => {
      if (!pendingAction) return;

      const actionDetails = ACTION_DETAILS[pendingAction.action];
      if (!actionDetails?.blockableBy || actionDetails.blockableBy.length === 0) {
          // Action is not blockable
          return;
      }

      // Validate that only the target can block Steal or Assassinate
      if ((pendingAction.action === ActionType.Steal || pendingAction.action === ActionType.Assassinate) && 
           pendingAction.targetId !== blockerId) {
          // Ideally we should log this or show an error, but for now just returning prevents the illegal state
          return;
      }

      addLog(
        `${getPlayerName(blockerId)} BLOCKS the ${pendingAction.action}!`,
        'challenge',
        { event: 'block', action: pendingAction.action, actorId: blockerId, targetId: pendingAction.targetId }
      );
      showAnim(blockerId, "BLOCKED!", 'info');
      setPendingAction({ ...pendingAction, blockerId });
      setAiChecksComplete(false); // Reset for block verification
      setPhase(GamePhase.BlockPending);
  };

  const handleChallenge = (challengerId: string) => {
      const isBlocking = phase === GamePhase.BlockPending;
      const targetId = isBlocking ? pendingAction!.blockerId! : pendingAction!.actorId;
      const challengedRole = getRequiredRole(isBlocking ? 'Block' : pendingAction!.action, pendingAction!.action);

      addLog(
        `${getPlayerName(challengerId)} CHALLENGES ${getPlayerName(targetId)}! (Claims ${challengedRole ? challengedRole.join(' or ') : 'valid role'})`,
        'challenge',
        { event: 'challenge', action: pendingAction!.action, actorId: challengerId, targetId, roles: challengedRole, isBlock: isBlocking }
      );
      showAnim(challengerId, "CHALLENGE!", 'error');

      const targetPlayer = players.find(p => p.id === targetId)!;
      const validRoles = isBlocking 
         ? ACTION_DETAILS[pendingAction!.action].blockableBy 
         : getRoleForAction(pendingAction!.action);
         
      const hasCard = targetPlayer.cards.some(c => !c.revealed && validRoles?.includes(c.role));

      if (hasCard) {
          const revealedRole = targetPlayer.cards.find(c => !c.revealed && validRoles?.includes(c.role))?.role;
          addLog(
            `${getPlayerName(targetId)} REVEALS valid card! Challenge failed.`,
            'info',
            { event: 'challenge_fail', action: pendingAction!.action, actorId: targetId, roles: revealedRole ? [revealedRole] : validRoles, isBlock: isBlocking }
          );
          
          const onChallengerLostCard = () => {
             // Must use ref for swap to ensure deck integrity
             swapCard(targetId, validRoles!);
             if (isBlocking) {
                 addLog(
                   `Block stands. Action blocked.`,
                   'info',
                   { event: 'action_fail', action: pendingAction!.action, actorId: pendingAction!.actorId, reason: 'block' }
                 );
                 setPhase(GamePhase.Resolving);
             } else {
                 const isBlockable = !!ACTION_DETAILS[pendingAction!.action].blockableBy;
                 if (isBlockable && pendingAction!.targetId && pendingAction!.targetId !== challengerId) {
                     addLog(
                       `Action stands. ${getPlayerName(pendingAction!.targetId)} can still block.`,
                       'info',
                       { event: 'action_success', action: pendingAction!.action, actorId: pendingAction!.actorId }
                     );
                     // Set to pending to allow blocking
                     setAiChecksComplete(false);
                     setPhase(GamePhase.ActionPending);
                 } else {
                     addLog(
                       `Action stands. Resolving...`,
                       'info',
                       { event: 'action_success', action: pendingAction!.action, actorId: pendingAction!.actorId }
                     );
                     resolveAction(); 
                 }
             }
          };

          if (challengerId === 'p1') {
             loseInfluence(challengerId);
             setResumeCallback(() => onChallengerLostCard);
             return; 
          }

          loseInfluence(challengerId);
          onChallengerLostCard(); 

      } else {
          addLog(
            `${getPlayerName(targetId)} CANNOT prove role! Challenge successful.`,
            'challenge',
            { event: 'challenge_success', action: pendingAction!.action, actorId: targetId, roles: validRoles, isBlock: isBlocking }
          );
          
          const onTargetLostCard = () => {
              if (isBlocking) {
                   addLog(
                     `Block failed. Resolving original action...`,
                     'info',
                     { event: 'action_success', action: pendingAction!.action, actorId: pendingAction!.actorId }
                   );
                   resolveAction();
              } else {
                   addLog(
                     `Action failed due to successful challenge.`,
                     'info',
                     { event: 'action_fail', action: pendingAction!.action, actorId: pendingAction!.actorId, reason: 'challenge' }
                   );
                   if (pendingAction!.action === ActionType.Assassinate) updateCoins(pendingAction!.actorId, 3);
                   setPhase(GamePhase.Resolving);
              }
          };

          if (targetId === 'p1') {
              loseInfluence(targetId);
              setResumeCallback(() => onTargetLostCard);
              return; 
          }

          loseInfluence(targetId);
          onTargetLostCard(); 
      }
  };

  const getRoleForAction = (action: ActionType): Role[] => {
      switch(action) {
          case ActionType.Tax: return [Role.Duke];
          case ActionType.Assassinate: return [Role.Assassin];
          case ActionType.Steal: return [Role.Captain];
          case ActionType.Exchange: return [Role.Ambassador];
          default: return [];
      }
  };

  const getRequiredRole = (type: 'Block' | ActionType, actionBlocked?: ActionType): Role[] | undefined => {
      if (type === 'Block' && actionBlocked) return ACTION_DETAILS[actionBlocked].blockableBy;
      return getRoleForAction(type as ActionType);
  };

  const swapCard = (playerId: string, validRoles: Role[]) => {
      // Use Ref to access current deck state inside callback chains
      const currentDeck = stateRef.current.deck;
      const currentPlayers = stateRef.current.players;
      
      const player = currentPlayers.find(p => p.id === playerId);
      if (!player) return;

      const cardIndex = player.cards.findIndex(c => !c.revealed && validRoles.includes(c.role));
      if (cardIndex === -1) return;
      
      const oldCard = player.cards[cardIndex];
      const newCard = currentDeck[0]; 
      if (!newCard) return; // Deck empty?

      const newDeckContent = currentDeck.slice(1);
      newDeckContent.push({ ...oldCard, id: uuidv4(), revealed: false }); 
      
      const shuffledDeck = shuffle(newDeckContent);
      setDeck(shuffledDeck);
      
      const newPlayerCards = [...player.cards];
      newPlayerCards[cardIndex] = newCard;
      
      setPlayers(prev => prev.map(p => p.id === playerId ? { ...p, cards: newPlayerCards } : p));
  };

  const loseInfluence = (playerId: string) => {
      const player = players.find(p => p.id === playerId);
      if (!player) return;
      
      const liveCards = player.cards.filter(c => !c.revealed);
      if (liveCards.length === 0) return; 

      addLog(`${player.name} must lose an influence.`, 'challenge', { event: 'lose_influence', actorId: playerId });
      showAnim(playerId, "LOST INFLUENCE", 'loss');

      if (player.isAi) {
          const cardToLose = liveCards[0]; 
          revealCard(playerId, cardToLose.id);
      } else {
          if (playerId === 'p1') {
             setPhase(GamePhase.ChooseInfluenceToLose);
          }
      }
  };

  const revealCard = (playerId: string, cardId: string) => {
      setPlayers(prev => prev.map(p => {
          if (p.id !== playerId) return p;
          const targetCard = p.cards.find(c => c.id === cardId);
          const newCards = p.cards.map(c => c.id === cardId ? { ...c, revealed: true } : c);
          const isEliminated = newCards.every(c => c.revealed);
          if (targetCard) {
            addLog(`${p.name} reveals ${targetCard.role}.`, 'info', { event: 'reveal', actorId: playerId, roles: [targetCard.role] });
          }
          if (isEliminated) addLog(`${p.name} has been eliminated!`, 'challenge');
          return { ...p, cards: newCards, isEliminated };
      }));
      
      if (phase === GamePhase.ChooseInfluenceToLose) {
          if (resumeCallback) {
              resumeCallback();
              setResumeCallback(null);
          } else {
              setPhase(GamePhase.Resolving);
          }
      }
  };

  const handleExchangeStart = (playerId: string) => {
      const draw = [deck[0], deck[1]];
      setDeck(prev => prev.slice(2));
      
      if (playerId === 'p1') {
          const player = players.find(p => p.id === playerId)!;
          const liveCards = player.cards.filter(c => !c.revealed);
          setExchangeCards([...liveCards, ...draw]);
          setSelectedExchangeCards(liveCards.map(c => c.id)); 
          setPhase(GamePhase.ExchangeCards);
      } else {
          // AI Logic
          const player = players.find(p => p.id === playerId)!;
          const allCards = [...player.cards.filter(c => !c.revealed), ...draw];
          
          const priority = [Role.Duke, Role.Contessa, Role.Captain, Role.Assassin, Role.Ambassador];
          allCards.sort((a, b) => priority.indexOf(a.role) - priority.indexOf(b.role));
          
          const kept = allCards.slice(0, player.cards.filter(c => !c.revealed).length);
          const returned = allCards.slice(player.cards.filter(c => !c.revealed).length);
          
          setPlayers(prev => prev.map(p => p.id === playerId ? { 
              ...p, 
              cards: [...p.cards.filter(c => c.revealed), ...kept] 
          } : p));
          
          setDeck(prev => shuffle([...prev, ...returned]));
          
          addLog(`${player.name} exchanged cards.`, 'info');
          setPhase(GamePhase.Resolving);
      }
  };

  const confirmExchange = () => {
      if (!exchangeCards.length) return;
      const player = players.find(p => p.id === 'p1')!;
      const numToKeep = player.cards.filter(c => !c.revealed).length;
      
      if (selectedExchangeCards.length !== numToKeep) {
          // Extra safety: force it to exactly numToKeep if somehow it's more
          if (selectedExchangeCards.length > numToKeep) {
              const sliced = selectedExchangeCards.slice(0, numToKeep);
              const keptCards = exchangeCards.filter(c => sliced.includes(c.id));
              const returnedCards = exchangeCards.filter(c => !sliced.includes(c.id));
              
              setPlayers(prev => prev.map(p => p.id === 'p1' ? {
                  ...p,
                  cards: [...p.cards.filter(c => c.revealed), ...keptCards]
              } : p));
              
              setDeck(prev => shuffle([...prev, ...returnedCards]));
              setPhase(GamePhase.Resolving);
              addLog(`You exchanged cards.`, 'info');
              return;
          }
          alert(`You must select exactly ${numToKeep} cards to keep.`);
          return;
      }
      
      const keptCards = exchangeCards.filter(c => selectedExchangeCards.includes(c.id));
      const returnedCards = exchangeCards.filter(c => !selectedExchangeCards.includes(c.id));
      
      setPlayers(prev => prev.map(p => p.id === 'p1' ? {
          ...p,
          cards: [...p.cards.filter(c => c.revealed), ...keptCards]
      } : p));
      
      setDeck(prev => shuffle([...prev, ...returnedCards]));
      setPhase(GamePhase.Resolving);
      addLog(`You exchanged cards.`, 'info');
  };

  // -- UI Render Helpers --

  const canBlock = (player: Player): boolean => {
      if (!pendingAction) return false;
      if (pendingAction.action === ActionType.ForeignAid) return true; 
      if (pendingAction.targetId === player.id) {
          if (pendingAction.action === ActionType.Steal) return true;
          if (pendingAction.action === ActionType.Assassinate) return true;
      }
      return false;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-gray-100 overflow-hidden font-sans">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10 pointer-events-none"></div>

      {/* Header */}
      <header className="p-4 border-b border-gray-800 bg-gray-900/90 backdrop-blur z-50 relative flex justify-between items-center">
        <h1 className="text-2xl font-bold text-coup-gold tracking-wider">GEMINI COUP</h1>
        <div className="flex items-center gap-4">
            {gameStarted && (
                <button 
                    onClick={quitGame}
                    className="text-xs font-bold text-red-500 hover:text-red-400 border border-red-900/50 hover:border-red-500 bg-red-900/10 px-3 py-1.5 rounded transition-colors uppercase tracking-wide cursor-pointer"
                >
                    Quit Game
                </button>
            )}
            <div className="text-xs text-gray-500 min-w-[100px] text-right">
                {phase !== GamePhase.Setup && `Phase: ${phase}`}
            </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-0 h-[calc(100vh-64px)] flex flex-col">
        
        {!gameStarted ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-8 animate-fade-in">
             <div className="bg-gray-800 p-8 rounded-2xl shadow-2xl border border-gray-700 max-w-md w-full">
                <h2 className="text-xl font-bold mb-4 text-center">Setup Game</h2>
                
                <div className="mb-6">
                    <label className="block text-sm font-medium mb-2 text-gray-400">Number of Bots: {numBots}</label>
                    <input 
                      type="range" 
                      min="1" 
                      max="5" 
                      value={numBots} 
                      onChange={(e) => setNumBots(parseInt(e.target.value))}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-coup-gold"
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                        <span>1</span><span>5</span>
                    </div>
                </div>

                <button 
                  onClick={startGame}
                  className="w-full bg-coup-gold hover:bg-yellow-600 text-black font-bold py-3 px-4 rounded transition-all transform hover:scale-105"
                >
                    Start Game
                </button>
             </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
             
             {/* Left: Game Board */}
             <div className="flex-1 relative p-4 flex flex-col">
                
                {/* Opponents Area */}
                <div className="flex-1 flex flex-wrap items-center justify-center gap-4 content-center">
                    {players.filter(p => p.isAi).map(bot => (
                        <div key={bot.id} className="scale-75 md:scale-90 transition-all">
                            <PlayerSpot 
                              player={bot} 
                              isCurrentTurn={currentPlayer?.id === bot.id} 
                              isTarget={pendingAction?.targetId === bot.id}
                              isSelectable={targetingAction !== null && !bot.isEliminated}
                              notification={playerNotifications[bot.id]}
                              onClick={() => targetingAction && handleActionSelect(targetingAction, bot.id)}
                            />
                        </div>
                    ))}
                </div>

                {/* Center Message / Status */}
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20 w-full text-center">
                    {targetingAction && (
                         <div className="inline-block bg-coup-gold text-black px-6 py-3 rounded-xl font-bold border-2 border-white animate-bounce shadow-lg pointer-events-auto">
                            SELECT TARGET FOR {targetingAction}
                            <button onClick={() => setTargetingAction(null)} className="block text-xs mt-1 text-red-800 underline">Cancel</button>
                        </div>
                    )}
                    {isProcessing && (
                        <div className="inline-block bg-black/80 text-coup-gold px-6 py-2 rounded-full backdrop-blur border border-coup-gold/30 animate-pulse">
                            AI is thinking...
                        </div>
                    )}
                    {winner && (
                        <div className="bg-black/90 text-4xl font-bold text-coup-gold px-12 py-8 rounded-xl border-2 border-coup-gold shadow-[0_0_50px_rgba(212,175,55,0.5)] animate-slide-up pointer-events-auto">
                            {winner.id === 'p1' ? 'VICTORY' : 'DEFEAT'}
                            <div className="text-lg text-gray-300 mt-2 font-normal">{winner.name} wins!</div>
                            <button onClick={() => setGameStarted(false)} className="mt-6 text-sm bg-coup-gold text-black px-4 py-2 rounded font-bold hover:bg-white">Play Again</button>
                        </div>
                    )}
                </div>

                {/* Player Area */}
                <div className="mt-auto pt-4 pb-20 md:pb-4 flex justify-center">
                    <PlayerSpot 
                      player={players.find(p => p.id === 'p1')!} 
                      isCurrentTurn={currentPlayer?.id === 'p1'}
                      isTarget={pendingAction?.targetId === 'p1'}
                      notification={playerNotifications['p1']}
                    />
                </div>

                {/* Floating Action Menu for Human */}
                {phase === GamePhase.TurnStart && currentPlayer?.id === 'p1' && !isProcessing && !targetingAction && (
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl px-4 animate-slide-up z-30">
                        <div className="bg-gray-900/95 border border-gray-700 p-4 rounded-xl shadow-2xl backdrop-blur">
                            <h3 className="text-center text-gray-400 text-xs uppercase tracking-widest mb-3">Choose Action</h3>
                            <div className="grid grid-cols-4 gap-2">
                                {Object.values(ActionType).map(action => {
                                    const details = ACTION_DETAILS[action];
                                    const player = players.find(p => p.id === 'p1');
                                    const canAfford = player ? player.coins >= details.cost : false;
                                    const mustCoup = player ? player.coins >= 10 : false;
                                    const disabled = !canAfford || (mustCoup && action !== ActionType.Coup);

                                    return (
                                        <button
                                            key={action}
                                            disabled={disabled}
                                            onClick={() => handleActionSelect(action)}
                                            className={`
                                                p-2 rounded text-xs md:text-sm font-semibold transition-colors flex flex-col items-center justify-center h-16
                                                ${disabled ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 hover:border-coup-gold'}
                                            `}
                                        >
                                            <span>{action}</span>
                                            {details.cost > 0 && <span className="text-yellow-500 text-[10px]">{details.cost} coin</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                {/* Reaction Menu for Human */}
                {phase === GamePhase.ActionPending && pendingAction && pendingAction.actorId !== 'p1' && !isProcessing && (
                     <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex gap-4 animate-slide-up z-30">
                         {!players.find(p=>p.id==='p1')?.isEliminated && (
                             <>
                                <button onClick={() => { resolveAction(); }} className="bg-gray-700 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-bold shadow-lg">Pass</button>
                                {ACTION_DETAILS[pendingAction.action].challengeable && (
                                    <button onClick={() => handleChallenge('p1')} className="bg-red-900 hover:bg-red-700 text-white px-6 py-3 rounded-lg font-bold shadow-lg border border-red-500">Challenge</button>
                                )}
                                {canBlock(players.find(p => p.id === 'p1')!) && (
                                    <button onClick={() => handleBlock('p1')} className="bg-blue-900 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-bold shadow-lg border border-blue-500">Block</button>
                                )}
                             </>
                         )}
                         {players.find(p=>p.id==='p1')?.isEliminated && (
                             <div className="bg-black/80 px-4 py-2 rounded text-gray-400 animate-pulse">
                                 Spectating AI Duel...
                             </div>
                         )}
                     </div>
                )}
                
                {/* Block Challenge Menu for Human */}
                 {phase === GamePhase.BlockPending && pendingAction && pendingAction.blockerId !== 'p1' && pendingAction.actorId === 'p1' && !isProcessing && (
                     <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex gap-4 animate-slide-up z-30">
                         <div className="bg-gray-800 p-4 rounded text-center">
                            <div className="mb-2 text-white">{getPlayerName(pendingAction.blockerId)} blocked you!</div>
                            <button onClick={() => { 
                                addLog("Block accepted.", 'info', { event: 'action_fail', action: pendingAction.action, actorId: pendingAction.actorId, reason: 'block_accept' }); 
                                setPhase(GamePhase.Resolving); 
                            }} className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded mr-2">Accept Block</button>
                            <button onClick={() => handleChallenge('p1')} className="bg-red-900 hover:bg-red-700 text-white px-4 py-2 rounded border border-red-500">Challenge Block</button>
                         </div>
                     </div>
                )}

                {/* Lose Influence UI */}
                {phase === GamePhase.ChooseInfluenceToLose && (
                    <div className="absolute inset-0 bg-black/80 z-40 flex flex-col items-center justify-center">
                        <h2 className="text-2xl text-white mb-6">Choose card to lose</h2>
                        <div className="flex gap-4">
                            {players.find(p => p.id === 'p1')?.cards.filter(c => !c.revealed).map(c => (
                                <CardComponent 
                                    key={c.id} 
                                    role={c.role} 
                                    revealed={false} 
                                    visible={true}
                                    selectable={true}
                                    onClick={() => revealCard('p1', c.id)}
                                    className="cursor-pointer hover:scale-110"
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* Exchange UI */}
                {phase === GamePhase.ExchangeCards && (
                    <div className="absolute inset-0 bg-black/90 z-40 flex flex-col items-center justify-center animate-fade-in">
                         <h2 className="text-2xl text-coup-gold mb-2">Ambassador Exchange</h2>
                         <p className="text-gray-400 mb-6">Select {players.find(p=>p.id==='p1')?.cards.filter(c=>!c.revealed).length} cards to keep.</p>
                         <div className="flex gap-4 mb-8">
                            {exchangeCards.map(c => (
                                <div key={c.id} onClick={() => {
                                   if (selectedExchangeCards.includes(c.id)) {
                                       setSelectedExchangeCards(prev => prev.filter(id => id !== c.id));
                                   } else {
                                       const numToKeep = players.find(p => p.id === 'p1')!.cards.filter(x => !x.revealed).length;
                                       if (selectedExchangeCards.length < numToKeep) {
                                           setSelectedExchangeCards(prev => [...prev, c.id]);
                                       }
                                   }
                                }}>
                                    <div className={`
                                        relative transition-all duration-200 cursor-pointer
                                        ${selectedExchangeCards.includes(c.id) ? 'ring-4 ring-green-500 scale-105' : 'opacity-60'}
                                    `}>
                                        {/* In exchange, you look at cards, so they are effectively revealed to you */}
                                        <div className="w-24 h-32 bg-gray-800 border border-gray-600 rounded-lg flex items-center justify-center flex-col">
                                            <span className={`font-bold ${ROLE_COLORS[c.role]}`}>{c.role}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                         </div>
                         <button onClick={confirmExchange} className="bg-green-600 hover:bg-green-500 text-white px-8 py-3 rounded-lg font-bold">Confirm Selection</button>
                    </div>
                )}
             </div>

             {/* Right: Game Log (Collapsible on mobile?) */}
             <div className="w-full md:w-80 bg-gray-900 border-l border-gray-800 flex flex-col h-64 md:h-auto">
                <div className="p-4 border-b border-gray-800 font-bold text-gray-400 text-sm tracking-wider uppercase">
                    Game Log
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-sm">
                    {logs.map(log => (
                        <div key={log.id} className={`
                            ${log.type === 'action' ? 'text-blue-300' : ''}
                            ${log.type === 'challenge' ? 'text-red-400 font-bold' : ''}
                            ${log.type === 'error' ? 'text-red-600' : ''}
                            ${log.type === 'info' ? 'text-gray-400' : ''}
                        `}>
                            <span className="opacity-50 text-xs mr-2">[{new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}]</span>
                            {log.message}
                        </div>
                    ))}
                    <div ref={logsEndRef} />
                </div>
                
                {/* Reference Card */}
                <div className="p-4 bg-gray-800 text-xs text-gray-400 border-t border-gray-700">
                    <div className="font-bold mb-2 text-gray-300">Quick Reference</div>
                    <ul className="space-y-1">
                        <li><span className="text-purple-400">Duke</span>: Tax (+3), Blocks Aid</li>
                        <li><span className="text-gray-400">Assassin</span>: Kill (3 coin), Blocked by Contessa</li>
                        <li><span className="text-blue-400">Captain</span>: Steal (+2), Blocks Steal</li>
                        <li><span className="text-green-400">Ambassador</span>: Exchange, Blocks Steal</li>
                        <li><span className="text-red-400">Contessa</span>: Blocks Assassin</li>
                    </ul>
                </div>
             </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
