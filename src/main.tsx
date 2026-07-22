import '@fontsource-variable/manrope';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const isLiveRuntime =
  window.location.pathname === '/live' || window.location.pathname === '/live/';
const isLegacyDemo =
  window.location.pathname === '/demo' || window.location.pathname === '/demo/';

const root = createRoot(document.getElementById('root')!);

root.render(
  <main className="grid min-h-screen place-items-center bg-canvas px-6 text-center" role="status">
    <p className="text-sm font-semibold text-muted">Loading Steward…</p>
  </main>,
);

async function loadRoute(): Promise<ComponentType> {
  if (isLiveRuntime) return (await import('./live-runtime')).LiveRuntimeApp;
  if (isLegacyDemo) return (await import('./App')).App;
  return (await import('./task-board')).BoardApp;
}

void loadRoute().then(
  (Route) => {
    root.render(
      <StrictMode>
        <Route />
      </StrictMode>,
    );
  },
  () => {
    root.render(
      <main className="grid min-h-screen place-items-center bg-canvas px-6 text-center" role="alert">
        <div>
          <p className="text-sm font-semibold text-urgent">Steward could not load.</p>
          <p className="mt-2 text-xs text-muted">Refresh the page to try again.</p>
        </div>
      </main>,
    );
  },
);
