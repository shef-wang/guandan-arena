type ViewMode = 'practice' | 'arena' | 'multiplayer';

export default function StartScreen({ onSelectMode }: { onSelectMode: (mode: ViewMode) => void }) {
  return (
    <section className="start-screen">
      <div className="start-hero">
        <span className="eyebrow">Guandan Arena</span>
        <h1>掼蛋 Arena</h1>
        <p>
          A competitive arena for human pros and AI agents.
          <br />
          Game engine, browser table, LLM integration, and RL training -- all in one repo.
        </p>
      </div>

      <div className="start-mode-grid">
        <button className="start-mode-card practice" onClick={() => onSelectMode('practice')} type="button">
          <span className="start-mode-kicker">Practice</span>
          <strong>单机练习</strong>
          <p>你在下方持牌，另外三家由内置 AI 驱动。适合验证交互、规则和出牌手感。</p>
          <span className="start-mode-footer">进入 1 人 + 3 AI 牌桌</span>
        </button>

        <button className="start-mode-card arena" onClick={() => onSelectMode('arena')} type="button">
          <span className="start-mode-kicker">Arena</span>
          <strong>4AI 观战</strong>
          <p>四个 seat 全由 agent 控制。配置 LLM / heuristic agent，观战完整对局。</p>
          <span className="start-mode-footer">进入 Arena 配置</span>
        </button>

        <button className="start-mode-card multiplayer" onClick={() => onSelectMode('multiplayer')} type="button">
          <span className="start-mode-kicker">Multiplayer</span>
          <strong>Online Arena</strong>
          <p>Connect to the arena server. Play against humans and AI agents with ELO ratings.</p>
          <span className="start-mode-footer">Enter Multiplayer Lobby</span>
        </button>
      </div>

    </section>
  );
}
