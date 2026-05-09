import { useCallback, useEffect, useState } from 'react';

import ArenaSetupScreen from './arena/ArenaSetupScreen';
import ArenaSpectator from './arena/ArenaSpectator';
import { loadPersistedSpectatorConfig, type SpectatorArenaConfig } from './arena/spectatorConfig';
import MultiplayerScreen from './multiplayer/MultiplayerScreen';
import PracticeTable from './PracticeTable';
import StartScreen from './StartScreen';

type Route =
  | { page: 'start' }
  | { page: 'practice' }
  | { page: 'arena-setup' }
  | { page: 'arena-spectator'; config: SpectatorArenaConfig }
  | { page: 'multiplayer' };

function resolveRoute(pathname: string): Route {
  if (pathname === '/practice') return { page: 'practice' };
  if (pathname === '/arena') return { page: 'arena-setup' };
  if (pathname === '/multiplayer') return { page: 'multiplayer' };
  return { page: 'start' };
}

function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function App() {
  const [route, setRoute] = useState<Route>(() =>
    resolveRoute(typeof window === 'undefined' ? '/' : window.location.pathname),
  );

  useEffect(() => {
    function handlePopState(): void {
      setRoute(resolveRoute(window.location.pathname));
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleSelectMode = useCallback((mode: 'practice' | 'arena' | 'multiplayer') => {
    if (mode === 'multiplayer') navigate('/multiplayer');
    else navigate(mode === 'practice' ? '/practice' : '/arena');
  }, []);

  if (route.page === 'multiplayer') {
    return <MultiplayerScreen />;
  }

  if (route.page === 'arena-spectator') {
    return <ArenaSpectator config={route.config} />;
  }

  if (route.page === 'arena-setup') {
    return (
      <ArenaSetupScreen
        initialConfig={loadPersistedSpectatorConfig()}
        onBack={() => navigate('/')}
        onStart={(config) => setRoute({ page: 'arena-spectator', config })}
      />
    );
  }

  if (route.page === 'practice') {
    return (
      <div className="app-shell">
        <header className="app-topbar">
          <div className="app-title-group">
            <span className="eyebrow">Guandan Practice</span>
            <h1>1 Player vs 3 AI</h1>
            <p className="app-subtitle">Choose built-in, DeepSeek, or the latest local PPO opponent.</p>
          </div>
          <div className="app-nav-row">
            <a className="ghost-button app-nav-link" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
              Home
            </a>
            <a className="ghost-button app-nav-link" href="/arena" onClick={(e) => { e.preventDefault(); navigate('/arena'); }}>
              4AI Arena
            </a>
          </div>
        </header>
        <PracticeTable />
      </div>
    );
  }

  return <StartScreen onSelectMode={handleSelectMode} />;
}
