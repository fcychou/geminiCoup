import React from 'react';
import { Player } from '../types';
import Card from './Card';

interface PlayerSpotProps {
  player: Player;
  isCurrentTurn: boolean;
  isTarget?: boolean;
  isSelectable?: boolean;
  notification?: { message: string, type: 'gain' | 'loss' | 'info' | 'error' | 'action' } | null;
  onClick?: () => void;
}

const PlayerSpot: React.FC<PlayerSpotProps> = ({ player, isCurrentTurn, isTarget, isSelectable, notification, onClick }) => {
  return (
    <div 
      onClick={isSelectable ? onClick : undefined}
      className={`
      relative p-4 rounded-xl transition-all duration-300
      ${isCurrentTurn ? 'bg-gray-800/80 ring-2 ring-coup-gold shadow-[0_0_15px_rgba(212,175,55,0.3)]' : 'bg-gray-900/50'}
      ${isTarget ? 'ring-2 ring-red-500 bg-red-900/20' : ''}
      ${isSelectable ? 'cursor-pointer hover:bg-gray-800 ring-2 ring-blue-400 hover:ring-blue-300' : ''}
      ${player.isEliminated ? 'opacity-50 grayscale' : ''}
    `}>
      {/* Animation Overlay */}
      {notification && (
        <div className={`
            absolute -top-8 left-0 right-0 z-30 flex justify-center pointer-events-none
            ${notification.type === 'gain' ? 'animate-float-up text-yellow-400 font-bold text-2xl drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]' : ''}
            ${notification.type === 'loss' ? 'animate-float-up text-red-500 font-bold text-2xl drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]' : ''}
            ${notification.type === 'error' ? 'animate-shake top-1/3' : ''} 
            ${notification.type === 'action' ? 'animate-pop-in -top-6' : ''}
            ${notification.type === 'info' ? 'animate-pop-in -top-6' : ''}
        `}>
            {notification.type === 'error' || notification.type === 'action' || notification.type === 'info' ? (
                <div className={`
                    px-3 py-1 rounded-lg border shadow-xl font-bold text-sm md:text-base whitespace-nowrap
                    ${notification.type === 'error' ? 'bg-red-900/90 border-red-500 text-white' : ''}
                    ${notification.type === 'action' ? 'bg-coup-gold text-black border-white' : ''}
                    ${notification.type === 'info' ? 'bg-blue-900/90 border-blue-400 text-white' : ''}
                `}>
                    {notification.message}
                </div>
            ) : (
                 /* Pure text for coins */
                 <span>{notification.message}</span>
            )}
        </div>
      )}

      <div className="flex flex-col items-center">
        <div className="flex items-center space-x-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white">
             {player.name.substring(0, 1)}
          </div>
          <span className="font-bold text-gray-200">{player.name} {player.isAi ? '(Bot)' : ''}</span>
        </div>
        
        <div className="flex space-x-2 mb-2">
          {player.cards.map((card, idx) => (
            <Card 
              key={`${player.id}-card-${idx}`} 
              role={card.role} 
              revealed={card.revealed}
              visible={!player.isAi} 
            />
          ))}
        </div>

        <div className="flex items-center space-x-2 bg-black/40 px-3 py-1 rounded-full">
          <div className="w-4 h-4 rounded-full bg-yellow-500 shadow-sm border border-yellow-300"></div>
          <span className="text-yellow-400 font-mono font-bold">{player.coins}</span>
        </div>
      </div>
      
      {isCurrentTurn && !player.isEliminated && (
        <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 bg-coup-gold text-black text-xs font-bold px-2 py-0.5 rounded shadow">
          ACTING
        </div>
      )}
    </div>
  );
};

export default PlayerSpot;