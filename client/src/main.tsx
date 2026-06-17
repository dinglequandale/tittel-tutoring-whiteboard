import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Landing } from './Landing'
import { Board } from './Board'
import './styles.css'

function BoardRoute() {
  const { roomId } = useParams<{ roomId: string }>()
  if (!roomId) return <Navigate to="/" replace />
  // The creator arrives at /b/<id>#host (large group: /b/<id>#host-large). The
  // "#host…" fragment never travels in the shared link, so whoever opens the
  // clean link joins as a guest/student and learns the class mode from the server.
  const hash = window.location.hash
  const isHost = hash.startsWith('#host')
  const hostMode: 'small' | 'large' = hash.includes('large') ? 'large' : 'small'
  // Remount the board if the room id changes by keying on it.
  return <Board key={roomId} roomId={roomId} isHost={isHost} hostMode={hostMode} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/b/:roomId" element={<BoardRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
