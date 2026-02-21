import { useState, useEffect, useRef, useCallback } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import './App.css'

const MARKER_COLORS = [
  'rgba(255, 99, 71, 0.55)',
  'rgba(65, 105, 225, 0.55)',
  'rgba(50, 205, 50, 0.55)',
  'rgba(255, 165, 0, 0.55)',
  'rgba(147, 112, 219, 0.55)',
  'rgba(255, 20, 147, 0.55)',
  'rgba(0, 206, 209, 0.55)',
  'rgba(255, 215, 0, 0.55)',
  'rgba(0, 191, 255, 0.55)',
  'rgba(60, 179, 113, 0.55)',
]

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function App() {
  const waveformRef = useRef(null)
  const wavesurferRef = useRef(null)
  const regionsRef = useRef(null)
  const markersRef = useRef({})
  const lastInteractionRef = useRef({ time: 0, timestamp: 0 })
  const activeLoopRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const recordedChunksRef = useRef([])

  const [audioFile, setAudioFile] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [markers, setMarkers] = useState({})
  const [isRecording, setIsRecording] = useState(false)
  const [recordingBlob, setRecordingBlob] = useState(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState('Drop or select an MP3 to get started.')

  // Build / rebuild WaveSurfer whenever audioFile changes
  useEffect(() => {
    if (!audioFile || !waveformRef.current) return

    // Tear down previous instance
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
      wavesurferRef.current = null
    }

    const regions = RegionsPlugin.create()
    regionsRef.current = regions

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#4a9eff',
      progressColor: '#1a6fd4',
      cursorColor: '#fff',
      barWidth: 2,
      barRadius: 3,
      height: 130,
      plugins: [regions],
    })

    wavesurferRef.current = ws

    ws.on('ready', () => {
      setIsLoaded(true)
      setDuration(ws.getDuration())
      setCurrentTime(0)
      setStatus('File loaded. Click waveform then press 0–9 to set a start marker. Click again and press the same key to set its end marker. Press a key (without clicking) to jump and loop.')
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => setIsPlaying(false))
    ws.on('timeupdate', (t) => {
      setCurrentTime(t)
      const loopKey = activeLoopRef.current
      if (loopKey !== null && ws.isPlaying()) {
        const marker = markersRef.current[loopKey]
        if (marker && marker.end !== null && t >= marker.end) {
          ws.setTime(marker.start)
        }
      }
    })

    ws.on('interaction', (newTime) => {
      lastInteractionRef.current = { time: Date.now(), timestamp: newTime }
    })

    ws.loadBlob(audioFile)

    return () => {
      ws.destroy()
      wavesurferRef.current = null
    }
  }, [audioFile])

  // Global keydown handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore key events when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (!isLoaded) return

      const key = e.key
      if (!/^[0-9]$/.test(key)) return
      e.preventDefault()

      const ws = wavesurferRef.current
      const regions = regionsRef.current
      const timeSinceCursor = Date.now() - lastInteractionRef.current.time

      if (timeSinceCursor < 1500) {
        // ── PLACE / UPDATE MARKER ──
        const clickedTime = lastInteractionRef.current.timestamp
        lastInteractionRef.current = { time: 0, timestamp: 0 }

        const existing = markersRef.current[key]

        if (existing && existing.end === null) {
          // Start already set — this click sets the end
          if (clickedTime <= existing.start) {
            setStatus(`End marker for key ${key} must be after the start (${formatTime(existing.start)}). Click at a later time position.`)
            return
          }

          // Replace narrow placeholder region with full start→end region
          regions.getRegions().forEach((r) => {
            if (r.id === `marker-${key}`) r.remove()
          })

          regions.addRegion({
            id: `marker-${key}`,
            start: existing.start,
            end: clickedTime,
            color: MARKER_COLORS[parseInt(key)],
            content: key,
            drag: false,
            resize: false,
          })

          const updated = { ...markersRef.current, [key]: { start: existing.start, end: clickedTime } }
          markersRef.current = updated
          setMarkers({ ...updated })
          setStatus(`Marker ${key}: ${formatTime(existing.start)} → ${formatTime(clickedTime)}. Press ${key} to jump and loop.`)
        } else {
          // No marker or complete marker — set new start, clear end
          regions.getRegions().forEach((r) => {
            if (r.id === `marker-${key}`) r.remove()
          })

          if (activeLoopRef.current === key) activeLoopRef.current = null

          regions.addRegion({
            id: `marker-${key}`,
            start: clickedTime,
            end: clickedTime + 0.25,
            color: MARKER_COLORS[parseInt(key)],
            content: key,
            drag: false,
            resize: false,
          })

          const updated = { ...markersRef.current, [key]: { start: clickedTime, end: null } }
          markersRef.current = updated
          setMarkers({ ...updated })
          setStatus(`Marker ${key} start set at ${formatTime(clickedTime)}. Click another spot and press ${key} again to set the end marker.`)
        }
      } else if (markersRef.current[key] !== undefined) {
        // ── JUMP TO MARKER ──
        const marker = markersRef.current[key]
        ws.setTime(marker.start)
        ws.play()
        if (marker.end !== null) {
          activeLoopRef.current = key
          setStatus(`Jumped to marker ${key} (${formatTime(marker.start)}) — looping to ${formatTime(marker.end)}.`)
        } else {
          activeLoopRef.current = null
          setStatus(`Jumped to marker ${key} (${formatTime(marker.start)}) — no end marker set yet.`)
        }
      } else {
        setStatus(`No marker on key ${key} yet. Click waveform then press ${key} to place a start marker.`)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isLoaded])

  // ── PLAYBACK CONTROLS ──
  const handlePlayPause = () => {
    wavesurferRef.current?.playPause()
  }

  const handleStop = () => {
    wavesurferRef.current?.stop()
  }

  // ── RECORDING ──
  const startRecording = useCallback(() => {
    const ws = wavesurferRef.current
    if (!ws) return

    const mediaEl = ws.getMediaElement()
    if (!mediaEl) {
      setStatus('Recording not available: media element not found.')
      return
    }

    let stream
    if (typeof mediaEl.captureStream === 'function') {
      stream = mediaEl.captureStream()
    } else if (typeof mediaEl.mozCaptureStream === 'function') {
      stream = mediaEl.mozCaptureStream()
    }

    if (!stream) {
      setStatus('Recording not supported in this browser. Try Chrome or Firefox.')
      return
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'

    const chunks = []
    recordedChunksRef.current = chunks

    const recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType })
      setRecordingBlob(blob)
      setStatus('Recording saved — click "Download Recording" to save the file.')
    }

    mediaRecorderRef.current = recorder
    recorder.start()
    setIsRecording(true)
    setRecordingBlob(null)
    setStatus('Recording… play the file and jump between markers. Click "Stop Recording" when done.')
  }, [])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    setIsRecording(false)
  }, [])

  const downloadRecording = useCallback(() => {
    if (!recordingBlob) return
    const url = URL.createObjectURL(recordingBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'recording.webm'
    a.click()
    URL.revokeObjectURL(url)
  }, [recordingBlob])

  // ── CLEAR A SINGLE MARKER ──
  const clearMarker = (key) => {
    regionsRef.current?.getRegions().forEach((r) => {
      if (r.id === `marker-${key}`) r.remove()
    })
    if (activeLoopRef.current === key) activeLoopRef.current = null
    const updated = { ...markersRef.current }
    delete updated[key]
    markersRef.current = updated
    setMarkers({ ...updated })
  }

  // ── DRAG & DROP ──
  const handleDragOver = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }
  const handleDragLeave = () => setIsDragging(false)

  const loadFile = (file) => {
    // Reset all per-file state before mounting a new WaveSurfer instance
    setIsLoaded(false)
    setIsPlaying(false)
    setMarkers({})
    markersRef.current = {}
    setRecordingBlob(null)
    setIsRecording(false)
    setDuration(0)
    setCurrentTime(0)
    setStatus('Loading waveform…')
    setAudioFile(file)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && file.type === 'audio/mpeg') {
      loadFile(file)
    } else {
      setStatus('Please drop a valid MP3 file.')
    }
  }
  const handleFileInput = (e) => {
    const file = e.target.files[0]
    if (file) loadFile(file)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎛 Easy Sampler</h1>
        <p className="subtitle">Upload an MP3, place loop markers (0–9) with start and end points, and jump between them with your keyboard.</p>
      </header>

      {/* Drop Zone */}
      {!audioFile && (
        <div
          className={`drop-zone${isDragging ? ' dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input').click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && document.getElementById('file-input').click()}
          aria-label="Drop zone for MP3 file"
        >
          <div className="drop-zone-icon">🎵</div>
          <p>Drag &amp; drop an MP3 here</p>
          <p className="drop-zone-hint">or click to browse</p>
          <input
            id="file-input"
            type="file"
            accept="audio/mpeg,.mp3"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>
      )}

      {/* Player Area */}
      {audioFile && (
        <div className="player-section">
          <div className="file-info">
            <span className="file-name">📂 {audioFile.name}</span>
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (wavesurferRef.current) {
                  wavesurferRef.current.destroy()
                  wavesurferRef.current = null
                }
                setAudioFile(null)
                setIsLoaded(false)
                setIsPlaying(false)
                setMarkers({})
                markersRef.current = {}
                setRecordingBlob(null)
                setIsRecording(false)
                setDuration(0)
                setCurrentTime(0)
                setStatus('Drop or select an MP3 to get started.')
              }}
            >
              × Change file
            </button>
          </div>

          {/* Waveform */}
          <div className="waveform-wrapper">
            <div ref={waveformRef} className="waveform" />
          </div>

          {/* Time display */}
          <div className="time-display">
            <span>{formatTime(currentTime)}</span>
            <span className="time-sep">/</span>
            <span>{formatTime(duration)}</span>
          </div>

          {/* Transport controls */}
          <div className="controls">
            <button
              className={`btn btn-primary${isPlaying ? ' active' : ''}`}
              onClick={handlePlayPause}
              disabled={!isLoaded}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button className="btn" onClick={handleStop} disabled={!isLoaded}>
              ⏹ Stop
            </button>
          </div>

          {/* Status bar */}
          <div className="status-bar">{status}</div>

          {/* Recording controls */}
          <div className="recording-section">
            <h3>Recording</h3>
            <p className="hint">
              Start recording, then play and jump between markers. Stop to save the captured audio.
            </p>
            <div className="controls">
              {!isRecording ? (
                <button
                  className="btn btn-record"
                  onClick={startRecording}
                  disabled={!isLoaded}
                >
                  ⏺ Start Recording
                </button>
              ) : (
                <button className="btn btn-stop-record" onClick={stopRecording}>
                  ⏹ Stop Recording
                </button>
              )}
              {recordingBlob && (
                <button className="btn btn-download" onClick={downloadRecording}>
                  ⬇ Download Recording
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Marker list */}
      {Object.keys(markers).length > 0 && (
        <div className="marker-section">
          <h3>Markers</h3>
          <p className="hint">
            Click the waveform, then press a number key to set a <strong>start</strong> marker.<br />
            Click another position and press the same key to set the <strong>end</strong> marker.<br />
            Press a number key (without clicking) to jump to that marker's start and loop to its end.<br />
            Pressing a key on an already-complete marker resets it so you can set a new start.
          </p>
          <div className="marker-grid">
            {Object.keys(markers)
              .sort()
              .map((key) => (
                <div
                  className="marker-chip"
                  key={key}
                  style={{ borderColor: MARKER_COLORS[parseInt(key)] }}
                >
                  <span
                    className="marker-key"
                    style={{ background: MARKER_COLORS[parseInt(key)] }}
                  >
                    {key}
                  </span>
                  <span className="marker-time">{formatTime(markers[key].start)}{markers[key].end !== null ? ` → ${formatTime(markers[key].end)}` : ' → ?'}</span>
                  <button
                    className="marker-remove"
                    onClick={() => clearMarker(key)}
                    title="Remove marker"
                    aria-label={`Remove marker ${key}`}
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      <footer className="app-footer">
        <p>Powered by WaveSurfer.js · FastAPI · React</p>
      </footer>
    </div>
  )
}

export default App
