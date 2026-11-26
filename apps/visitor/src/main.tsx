import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VisitorApp } from './app.tsx';
import { createVisitorApi } from './api.ts';
import { readEmulatorVisitorConfig, readProductionVisitorConfig } from './visitor-config.ts';
import './styles.css';

const visitorEnvironment = {
  VITE_NATCUT_FIREBASE_PROJECT_ID: import.meta.env.VITE_NATCUT_FIREBASE_PROJECT_ID,
  VITE_NATCUT_FIREBASE_API_KEY: import.meta.env.VITE_NATCUT_FIREBASE_API_KEY,
  VITE_NATCUT_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_NATCUT_FIREBASE_AUTH_DOMAIN,
  VITE_NATCUT_FIREBASE_APP_ID: import.meta.env.VITE_NATCUT_FIREBASE_APP_ID,
  VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL: import.meta.env.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL,
  VITE_NATCUT_SUBMISSION_API_URL: import.meta.env.VITE_NATCUT_SUBMISSION_API_URL,
};
const config = import.meta.env.PROD
  ? readProductionVisitorConfig(visitorEnvironment)
  : readEmulatorVisitorConfig(visitorEnvironment);
const api = createVisitorApi(config);

createRoot(document.getElementById('root')!).render(<StrictMode><VisitorApp api={api} /></StrictMode>);
