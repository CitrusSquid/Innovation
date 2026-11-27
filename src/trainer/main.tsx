import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { TrainerStudioApp } from './TrainerStudioApp';

createRoot(document.getElementById('trainer-root')!).render(
  <StrictMode>
    <TrainerStudioApp />
  </StrictMode>
);
