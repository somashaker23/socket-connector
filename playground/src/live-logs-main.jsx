import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LiveLogs from './LiveLogs.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LiveLogs />
  </StrictMode>,
)
