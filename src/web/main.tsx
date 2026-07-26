import '@fontsource-variable/manrope';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LiveRuntimeApp } from './live-runtime';
import { BoardApp } from './task-board';
import './styles.css';

const isLiveRuntime =
  window.location.pathname === '/live' || window.location.pathname === '/live/';
const isLegacyDemo =
  window.location.pathname === '/demo' || window.location.pathname === '/demo/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLiveRuntime ? <LiveRuntimeApp /> : isLegacyDemo ? <App /> : <BoardApp />}
  </StrictMode>,
);
