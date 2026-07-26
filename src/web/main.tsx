import '@fontsource-variable/manrope';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardApp } from './task-board';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BoardApp />
  </StrictMode>,
);
