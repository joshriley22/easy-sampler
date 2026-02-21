import { useEffect, useRef, useState, useCallback } from 'react'
import TrackPlayer from './TrackPlayer'
import CommunityPage from './CommunityPage'
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
  const [page, setPage] = useState('sampler')
  const track0Ref = useRef(null)
  const track1Ref = useRef(null)
  const track2Ref = useRef(null)

  // ── Shared Web Audio infrastructure ──
  const audioCtxRef = useRef(null)
  const masterGainRef = useRef(null)
  const mediaStreamDestRef = useRef(null)

  // Lazy-create AudioContext on first user gesture (browser autoplay policy)
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext()
      const masterGain = ctx.createGain()
      const dest = ctx.createMediaStreamDestination()
      masterGain.connect(ctx.destination)
      masterGain.connect(dest)
      audioCtxRef.current = ctx
      masterGainRef.current = masterGain
      mediaStreamDestRef.current = dest
    }
    return audioCtxRef.current
  }, [])

  const getMasterGain = useCallback(() => masterGainRef.current, [])

  // ── Global duck: when track `triggeringIdx` layers in, duck all others ──
  const onLayerTrigger = useCallback((triggeringIdx, featuresB) => {
    [track0Ref, track1Ref, track2Ref].forEach((ref, i) => {
      if (i !== triggeringIdx) {
        ref.current?.duck(featuresB)
      }
    })
  }, []) // track0/1/2Ref are stable (useRef), no actual dependency

  // ── Global recording (master mix) ──
  const mediaRecorderRef = useRef(null)
  const recordedChunksRef = useRef([])
  const [isRecording, setIsRecording] = useState(false)
  const [recordingBlob, setRecordingBlob] = useState(null)

  const startRecording = useCallback(() => {
    // Ensure AudioContext and MediaStreamDestination are created
    getAudioContext()
    const dest = mediaStreamDestRef.current
    if (!dest) return
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const chunks = []
    recordedChunksRef.current = chunks
    const recorder = new MediaRecorder(dest.stream, { mimeType })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => setRecordingBlob(new Blob(chunks, { type: mimeType }))
    mediaRecorderRef.current = recorder
    recorder.start()
    setIsRecording(true)
    setRecordingBlob(null)
  }, [getAudioContext])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    setIsRecording(false)
  }, [])

  const downloadRecording = useCallback(() => {
    if (!recordingBlob) return
    const url = URL.createObjectURL(recordingBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'master-mix.webm'
    a.click()
    URL.revokeObjectURL(url)
  }, [recordingBlob])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      // When Shift is held, e.key gives symbols ('!','@',…) — extract digit from e.code instead
      const key = (e.shiftKey && e.code?.startsWith('Digit'))
        ? e.code.replace('Digit', '')
        : e.key
      if (!/^[1-9]$/.test(key)) return
      e.preventDefault()

      // Resume AudioContext on first user gesture
      const ctx = getAudioContext()
      if (ctx.state === 'suspended') ctx.resume()

      const trackIdx = KEY_TO_TRACK[key]
      ;[track0Ref, track1Ref, track2Ref][trackIdx].current?.handleKey({ key, shiftKey: e.shiftKey })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [getAudioContext])

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎛 Easy Sampler</h1>
        <nav className="app-nav">
          <button
            className={`app-nav-btn${page === 'sampler' ? ' active' : ''}`}
            onClick={() => setPage('sampler')}
          >
            🎚 Sampler
          </button>
          <button
            className={`app-nav-btn${page === 'community' ? ' active' : ''}`}
            onClick={() => setPage('community')}
          >
            🌐 Community
          </button>
        </nav>
      </header>

      {page === 'community' ? (
        <main aria-live="polite">
          <CommunityPage />
        </main>
      ) : (
        <main aria-live="polite">
          <p className="subtitle">
            Load up to 3 MP3s and play them simultaneously. Keys 1–3 → Track 1 · 4–6 → Track 2 · 7–9 → Track 3.
            Triggering a marker layers that track in (with smart fade + global duck).
          </p>

          <div className="tracks-grid">
            {TRACKS.map((t, i) => (
              <TrackPlayer
                key={i}
                ref={[track0Ref, track1Ref, track2Ref][i]}
                trackIndex={i}
                assignedKeys={t.keys}
                label={t.label}
                getAudioContext={getAudioContext}
                getMasterGain={getMasterGain}
                onLayerTrigger={(featuresB) => onLayerTrigger(i, featuresB)}
              />
            ))}
          </div>

          <div className="global-recording">
            <span className="global-recording-label">🎙 Master Mix</span>
            <div className="controls">
              {!isRecording ? (
                <button className="btn btn-record" onClick={startRecording}>
                  ⏺ Record
                </button>
              ) : (
                <button className="btn btn-stop-record" onClick={stopRecording}>
                  ⏹ Stop Rec
                </button>
              )}
              {recordingBlob && (
                <button className="btn btn-download" onClick={downloadRecording}>
                  ⬇ Download Mix
                </button>
              )}
            </div>
          </div>
        </main>
      )}

      <footer className="app-footer">
        <p>Powered by WaveSurfer.js · FastAPI · React</p>
      </footer>
    </div>
  )
}

export default App
