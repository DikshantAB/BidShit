import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { store } from './store';
import './index.css';

// The DevTools panel page can read the inspected tab id and connect to the
// background service worker for this tab's event stream.
const tabId =
  typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow?.tabId
    ? chrome.devtools.inspectedWindow.tabId
    : undefined;

if (typeof tabId === 'number') {
  store.connect(tabId);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App inspectable={typeof tabId === 'number'} />
  </StrictMode>
);
