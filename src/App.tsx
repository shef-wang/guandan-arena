import { useState } from 'react';
import ArenaSpectator from './arena/ArenaSpectator';
import ArenaSetupScreen from './arena/ArenaSetupScreen';
import { loadPersistedSpectatorConfig, type SpectatorArenaConfig } from './arena/spectatorConfig';
import PracticeTable from './PracticeTable';
import StartScreen from './StartScreen';

type ViewMode = 'practice' | 'arena-setup' | 'arena';

export default function App() {
  const [arenaConfig, setArenaConfig] = useState<SpectatorArenaConfig>(() => loadPersistedSpectatorConfig());
  const [view, setView] = useState<ViewMode | null>(null);

  if (!view) {
    return (
      <div className="app-shell">
        <StartScreen
          onSelectMode={(nextView) => {
            if (nextView === 'arena') {
              setView('arena-setup');
              return;
            }

            setView(nextView);
          }}
        />
      </div>
    );
  }

  if (view === 'arena-setup') {
    return (
      <div className="app-shell">
        <ArenaSetupScreen
          initialConfig={arenaConfig}
          onBack={() => setView(null)}
          onStart={(nextConfig) => {
            setArenaConfig(nextConfig);
            setView('arena');
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-title-group">
          <span className="eyebrow">Guandan Webapp</span>
          <h1>{view === 'practice' ? '单机练习模式' : '4AI / LLM 观战模式'}</h1>
        </div>

        <button
          className="ghost-button app-back-button"
          onClick={() => setView(view === 'arena' ? 'arena-setup' : null)}
          type="button"
        >
          {view === 'arena' ? '返回配置页' : '返回模式选择'}
        </button>
      </header>

      {view === 'practice' ? <PracticeTable /> : <ArenaSpectator config={arenaConfig} />}
    </div>
  );
}
