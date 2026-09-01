import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './style.css'
import { ScenarioViewerApp } from './ScenarioViewerApp.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root')

createRoot(root).render(
  <StrictMode>
    <ScenarioViewerApp />
  </StrictMode>,
)
