import { useEffect, useRef } from 'react'
import TrackPlayer from './TrackPlayer'
import './App.css'

const TRACKS = [
  { keys: ['1', '2', '3'], label: 'Track 1' },
  { keys: ['4', '5', '6'], label: 'Track 2' },
  { keys: ['7', '8', '9'], label: 'Track 3' },
]

const KEY_TO_TRACK = {
  '1': 0, '2': 0, '3': 0,
  '4': 1, '5': 1, '6': 1,
  '7': 2, '8': 2, '9': 2,
}

function App() {
  const track0Ref = useRef(null)
  const track1Ref = useRef(null)
  const track2Ref = useRef(null)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const key = e.key
      if (!/^[1-9]$/.test(key)) return
      e.preventDefault()
      const trackIdx = KEY_TO_TRACK[key]
      const refs = [track0Ref, track1Ref, track2Ref]
      refs[trackIdx].current?.handleKey(key)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎛 Easy Sampler</h1>
        <p className="subtitle">
          Load up to 3 MP3s and play them simultaneously. Keys 1–3 → Track 1 · 4–6 → Track 2 · 7–9 → Track 3.
        </p>
      </header>

      <div className="tracks-grid">
        {TRACKS.map((t, i) => (
          <TrackPlayer
            key={i}
            ref={[track0Ref, track1Ref, track2Ref][i]}
            trackIndex={i}
            assignedKeys={t.keys}
            label={t.label}
          />
        ))}
      </div>

      <footer className="app-footer">
        <p>Powered by WaveSurfer.js · FastAPI · React</p>
      </footer>
    </div>
  )
}

export default App
