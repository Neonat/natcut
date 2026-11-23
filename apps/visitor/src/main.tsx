import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VisitorApp } from './app.tsx';
import { createVisitorApi } from './api.ts';
import './styles.css';

const api = createVisitorApi({
  submissionApiUrl: import.meta.env.VITE_SUBMISSION_API_URL ?? 'http://127.0.0.1:8088',
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-key',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo-natcut.firebaseapp.com',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-natcut',
  },
});

createRoot(document.getElementById('root')!).render(<StrictMode><VisitorApp api={api} /></StrictMode>);
