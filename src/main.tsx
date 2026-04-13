import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installGuandanArenaBridge } from './arena/browser';
import './styles.css';

installGuandanArenaBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
