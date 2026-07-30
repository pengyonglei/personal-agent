import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PersonalAgentApp from './App';
import './styles.css';

const root = document.querySelector('#root');
if (!root) throw new Error('找不到 React 根节点');

createRoot(root).render(
  <StrictMode>
    <PersonalAgentApp />
  </StrictMode>,
);
