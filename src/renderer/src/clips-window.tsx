import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './hooks/theme';
import { ClipsPanelApp } from './components/panels/ClipsPanelApp';
import './api/electron-api';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <ClipsPanelApp />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
