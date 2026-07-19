import '@fontsource-variable/manrope';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LiveRuntimeApp } from './live-runtime';
import './styles.css';

const isLiveRuntime =
  window.location.pathname === '/live' || window.location.pathname === '/live/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLiveRuntime ? <LiveRuntimeApp /> : <App />}
  </StrictMode>,
);
