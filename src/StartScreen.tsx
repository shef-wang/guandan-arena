type ViewMode = 'practice' | 'arena';

export default function StartScreen({ onSelectMode }: { onSelectMode: (mode: ViewMode) => void }) {
  return (
    <section className="start-screen">
      <div className="start-hero">
        <span className="eyebrow">AI-native Guandan</span>
        <h1>掼蛋 WebApp</h1>
        <p>
          代码结构现在按四层拆开：
          <br />
          核心玩法引擎、统一牌桌渲染、单机控制逻辑、4AI / LLM 对战控制逻辑。
        </p>
      </div>

      <div className="start-mode-grid">
        <button className="start-mode-card" onClick={() => onSelectMode('practice')} type="button">
          <span className="start-mode-kicker">Mode A</span>
          <strong>单机练习</strong>
          <p>你在下方持牌，另外三家由内置 AI 驱动。适合验证交互、规则和出牌手感。</p>
          <span className="start-mode-footer">进入 1 人 + 3 AI 牌桌</span>
        </button>

        <button className="start-mode-card arena" onClick={() => onSelectMode('arena')} type="button">
          <span className="start-mode-kicker">Mode B</span>
          <strong>4AI 观战</strong>
          <p>四个 seat 全由 agent 控制。先进入配置页填写 key / model，再进主观战台跑完整一局。</p>
          <span className="start-mode-footer">先进入 4AI 配置页</span>
        </button>
      </div>
    </section>
  );
}
