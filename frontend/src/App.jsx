import { useEffect, useRef, useState, useCallback } from 'react'
import TrackPlayer from './TrackPlayer'
import CommunityPage from './CommunityPage'
import { convertWebmToMp3 } from './convertWebmToMp3'
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

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function App() {
  const [page, setPage] = useState('sampler')
  const track0Ref = useRef(null)
  const track1Ref = useRef(null)
  const track2Ref = useRef(null)

  // ── Track volumes (for background circle) ──
  const [trackVolumes, setTrackVolumes] = useState([1, 1, 1])
  const handleTrackVolumeChange = useCallback((idx, vol) => {
    setTrackVolumes((prev) => {
      const next = [...prev]
      next[idx] = vol
      return next
    })
  }, [])

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
  const [isConverting, setIsConverting] = useState(false)

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

  const [uploadTitle, setUploadTitle] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)

  const uploadRecording = useCallback(async () => {
    if (!recordingBlob || !uploadTitle.trim()) return
    setIsUploading(true)
    setUploadSuccess(false)
    try {
      const mp3Blob = await convertWebmToMp3(recordingBlob)
      const formData = new FormData()
      formData.append('file', mp3Blob, 'master-mix.mp3')
      formData.append('title', uploadTitle.trim())
      const res = await fetch(`${API_BASE}/api/songs`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      setUploadSuccess(true)
      setUploadTitle('')
    } catch (err) {
      console.error('Upload failed:', err)
      alert(`Upload failed: ${err.message}`)
    } finally {
      setIsUploading(false)
    }
  }, [recordingBlob, uploadTitle])

  const downloadRecording = useCallback(async () => {
    if (!recordingBlob) return
    setIsConverting(true)
    try {
      const mp3Blob = await convertWebmToMp3(recordingBlob)
      const url = URL.createObjectURL(mp3Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'master-mix.mp3'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('MP3 conversion failed:', err)
      alert('Failed to convert recording to MP3. Please try again.')
    } finally {
      setIsConverting(false)
    }
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

  const circleVolume = Math.max(...trackVolumes)
  const circleSize = Math.round(200 + circleVolume * 600)

  return (
    <div className="app">
      <div className="bg-circle" style={{ width: circleSize, height: circleSize }} />
      <header className="app-header">
        <h1>🎛 SAMPLR</h1>
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
            Shift+Key to stop an audio clip. Triggering a marker layers that track in (with smart fade + global duck).
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
                onVolumeChange={handleTrackVolumeChange}
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
                <>
                  <button className="btn btn-download" onClick={downloadRecording} disabled={isConverting || isUploading}>
                    {isConverting ? '⏳ Converting…' : '⬇ Download Mix'}
                  </button>
                  <input
                    className="upload-title-input"
                    type="text"
                    placeholder="Song title…"
                    value={uploadTitle}
                    onChange={(e) => { setUploadTitle(e.target.value); setUploadSuccess(false) }}
                    disabled={isUploading}
                    aria-label="Song title for upload"
                  />
                  <button
                    className="btn btn-upload"
                    onClick={uploadRecording}
                    disabled={isUploading || !uploadTitle.trim()}
                  >
                    {isUploading ? '⏳ Uploading…' : '☁ Upload Mix'}
                  </button>
                  {uploadSuccess && <span className="upload-success">✔ Uploaded!</span>}
                </>
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
