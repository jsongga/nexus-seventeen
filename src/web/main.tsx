import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardApp } from './task-board';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BoardApp />
  </StrictMode>,
);
