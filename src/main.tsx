import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ArneySettingsEntry from './ArneySettingsEntry'
import ArneyWakeControl from './ArneyWakeControl'
import FamilyAccountEntry from './FamilyAccountEntry'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ArneySettingsEntry />
    <ArneyWakeControl />
    <FamilyAccountEntry />
  </StrictMode>,
)
