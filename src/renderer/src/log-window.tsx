import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './hooks/theme';
import { LogPanelApp } from './components/panels/LogPanelApp';
import './api/electron-api';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <LogPanelApp />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
