import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Board } from './Board.js'
import './console.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Board />
    </StrictMode>
  )
}
