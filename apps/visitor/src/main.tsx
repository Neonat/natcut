import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VisitorApp } from './app.tsx';
import { createVisitorApi } from './api.ts';
import { readEmulatorVisitorConfig, readProductionVisitorConfig } from './visitor-config.ts';
import './styles.css';

const config = import.meta.env.PROD
  ? readProductionVisitorConfig(import.meta.env)
  : readEmulatorVisitorConfig(import.meta.env);
const api = createVisitorApi(config);

createRoot(document.getElementById('root')!).render(<StrictMode><VisitorApp api={api} /></StrictMode>);
