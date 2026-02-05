import React from 'react';
import { Role } from '../types';
import { ROLE_COLORS } from '../constants';

interface CardProps {
  role: Role;
  revealed: boolean;
  visible?: boolean;
  selectable?: boolean;
  onClick?: () => void;
  className?: string;
}

const Card: React.FC<CardProps> = ({ role, revealed, visible, selectable, onClick, className = '' }) => {
  const getIcon = (r: Role) => {
    switch(r) {
      case Role.Duke: return '👑';
      case Role.Assassin: return '🗡️';
      case Role.Captain: return '🏴‍☠️';
      case Role.Ambassador: return '🤝';
      case Role.Contessa: return '🛡️';
      default: return '';
    }
  };

  return (
    <div
      onClick={selectable ? onClick : undefined}
      className={`
        relative w-20 h-28 md:w-24 md:h-32 rounded-lg shadow-md transition-transform duration-300
        ${selectable ? 'cursor-pointer hover:scale-105 ring-2 ring-blue-500' : ''}
        ${revealed ? 'bg-gray-800 border-red-900/50' : 'bg-gradient-to-br from-gray-700 to-gray-900 border-gray-600'}
        ${className}
        border
        flex items-center justify-center
      `}
    >
      {revealed ? (
        <div className="text-center p-2 opacity-60">
           <div className={`font-bold text-sm md:text-md mb-1 ${ROLE_COLORS[role]} line-through decoration-red-500`}>{role}</div>
           <div className="text-[10px] md:text-xs text-red-500 font-bold uppercase tracking-wider">Dead</div>
        </div>
      ) : visible ? (
        <div className="text-center p-2">
           <div className={`font-bold text-sm md:text-md mb-1 ${ROLE_COLORS[role]}`}>{role}</div>
           <div className="text-3xl mt-1 opacity-80">{getIcon(role)}</div>
        </div>
      ) : (
        <div className="w-full h-full bg-[url('https://www.transparenttextures.com/patterns/black-scales.png')] opacity-50 rounded-lg flex items-center justify-center">
            <span className="text-4xl text-gray-600 opacity-20">?</span>
        </div>
      )}
    </div>
  );
};

export default Card;