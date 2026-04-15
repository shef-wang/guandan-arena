import PracticeTable from './PracticeTable';

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-title-group">
          <span className="eyebrow">Guandan Practice</span>
          <h1>1 Player vs 3 AI</h1>
          <p className="app-subtitle">Public web build with the built-in legacy-v1 table AI. No setup, no mode switch.</p>
        </div>
        <a className="ghost-button app-nav-link" href="/agent?matches=10">
          Open Agent Mode
        </a>
      </header>

      <PracticeTable />
    </div>
  );
}
