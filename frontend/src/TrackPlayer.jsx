import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'

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

const TrackPlayer = forwardRef(function TrackPlayer({ trackIndex, assignedKeys, label }, ref) {
  const waveformRef = useRef(null)
  const wavesurferRef = useRef(null)
  const regionsRef = useRef(null)
  const markersRef = useRef({})
  const lastInteractionRef = useRef({ time: 0, timestamp: 0 })
  const activeLoopRef = useRef(null)
  const isLoadedRef = useRef(false)
  const mediaRecorderRef = useRef(null)
  const recordedChunksRef = useRef([])
  const volumeRef = useRef(1)
  // Store stable props in refs so effects/callbacks don't need them in dep arrays
  const assignedKeysRef = useRef(assignedKeys)
  const labelRef = useRef(label)

  const [audioFile, setAudioFile] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [markers, setMarkers] = useState({})
  const [volume, setVolume] = useState(1)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingBlob, setRecordingBlob] = useState(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState(`Drop or select an MP3 for ${label}.`)

  // Keep isLoadedRef in sync for stale-closure-free imperative handle
  useEffect(() => { isLoadedRef.current = isLoaded }, [isLoaded])

  // Build / rebuild WaveSurfer whenever audioFile changes
  useEffect(() => {
    if (!audioFile || !waveformRef.current) return

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
      height: 100,
      plugins: [regions],
    })

    wavesurferRef.current = ws
    ws.setVolume(volumeRef.current)

    ws.on('ready', () => {
      setIsLoaded(true)
      setDuration(ws.getDuration())
      setCurrentTime(0)
      setStatus(`File loaded. Click waveform then press ${assignedKeysRef.current.join('/')} to set start/end markers.`)
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

  // ── VOLUME ──
  const handleVolumeChange = useCallback((e) => {
    const v = parseFloat(e.target.value)
    volumeRef.current = v
    setVolume(v)
    wavesurferRef.current?.setVolume(v)
  }, [])

  // ── KEY HANDLER (exposed to parent via ref) ──
  const handleKey = useCallback((input) => {
    if (!isLoadedRef.current) return

    const ws = wavesurferRef.current
    if (!ws) return

    const key = typeof input === 'string' ? input : input.key
    const shiftKey = typeof input === 'string' ? false : !!input.shiftKey

    if (shiftKey) {
      ws.stop()
      activeLoopRef.current = null
      setStatus(`Stopped (${labelRef.current}). Press ${assignedKeysRef.current.join('/')} to jump to a marker.`)
      return
    }

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
  }, []) // all state accessed via refs — stable prop refs used for messages, no deps needed

  useImperativeHandle(ref, () => ({ handleKey }), [handleKey])

  // ── PLAYBACK CONTROLS ──
  const handlePlayPause = () => wavesurferRef.current?.playPause()
  const handleStop = () => wavesurferRef.current?.stop()

  // ── RECORDING ──
  const startRecording = useCallback(() => {
    const ws = wavesurferRef.current
    if (!ws) return
    const mediaEl = ws.getMediaElement()
    if (!mediaEl) { setStatus('Recording not available: media element not found.'); return }

    let stream
    if (typeof mediaEl.captureStream === 'function') stream = mediaEl.captureStream()
    else if (typeof mediaEl.mozCaptureStream === 'function') stream = mediaEl.mozCaptureStream()

    if (!stream) { setStatus('Recording not supported in this browser. Try Chrome or Firefox.'); return }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const chunks = []
    recordedChunksRef.current = chunks
    const recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      setRecordingBlob(new Blob(chunks, { type: mimeType }))
      setStatus('Recording saved — click "Download" to save the file.')
    }
    mediaRecorderRef.current = recorder
    recorder.start()
    setIsRecording(true)
    setRecordingBlob(null)
    setStatus('Recording… play and jump between markers. Click "Stop Rec" when done.')
  }, [])

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
    a.download = `recording-${labelRef.current.replace(/\s+/g, '-').toLowerCase()}.webm`
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
  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true) }
  const handleDragLeave = () => setIsDragging(false)

  const loadFile = (file) => {
    setIsLoaded(false)
    setIsPlaying(false)
    setMarkers({})
    markersRef.current = {}
    activeLoopRef.current = null
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
    if (file && file.type === 'audio/mpeg') loadFile(file)
    else setStatus('Please drop a valid MP3 file.')
  }

  const handleFileInput = (e) => {
    const file = e.target.files[0]
    if (file) loadFile(file)
    e.target.value = ''
  }

  const removeFile = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
      wavesurferRef.current = null
    }
    setAudioFile(null)
    setIsLoaded(false)
    setIsPlaying(false)
    setMarkers({})
    markersRef.current = {}
    activeLoopRef.current = null
    setRecordingBlob(null)
    setIsRecording(false)
    setDuration(0)
    setCurrentTime(0)
    volumeRef.current = 1
    setVolume(1)
    setStatus(`Drop or select an MP3 for ${label}.`)
  }

  const fileInputId = `file-input-${trackIndex}`

  return (
    <div className="track-player">
      <div className="track-header">
        <span className="track-label">{label}</span>
        <span className="track-keys">Keys: {assignedKeys.join(', ')}</span>
      </div>

      {!audioFile ? (
        <div
          className={`drop-zone drop-zone-compact${isDragging ? ' dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById(fileInputId).click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && document.getElementById(fileInputId).click()}
          aria-label={`Drop zone for ${label}`}
        >
          <div className="drop-zone-icon">🎵</div>
          <p>Drop MP3 or click to browse</p>
          <input
            id={fileInputId}
            type="file"
            accept="audio/mpeg,.mp3"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>
      ) : (
        <>
          <div className="file-info">
            <span className="file-name">📂 {audioFile.name}</span>
            <button className="btn btn-ghost" onClick={removeFile}>× Remove</button>
          </div>

          <div className="waveform-wrapper">
            <div ref={waveformRef} className="waveform" />
          </div>

          <div className="track-time-volume">
            <div className="time-display">
              <span>{formatTime(currentTime)}</span>
              <span className="time-sep">/</span>
              <span>{formatTime(duration)}</span>
            </div>
            <div className="volume-control">
              <label htmlFor={`volume-${trackIndex}`}>🔊</label>
              <input
                id={`volume-${trackIndex}`}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={handleVolumeChange}
                className="volume-slider"
                aria-label={`Volume for ${label}`}
              />
              <span className="volume-value">{Math.round(volume * 100)}%</span>
            </div>
          </div>

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

          <div className="status-bar">{status}</div>

          {Object.keys(markers).length > 0 && (
            <div className="track-markers">
              <div className="marker-grid">
                {Object.keys(markers).sort().map((key) => (
                  <div
                    className="marker-chip"
                    key={key}
                    style={{ borderColor: MARKER_COLORS[parseInt(key)] }}
                  >
                    <span className="marker-key" style={{ background: MARKER_COLORS[parseInt(key)] }}>
                      {key}
                    </span>
                    <span className="marker-time">
                      {formatTime(markers[key].start)}{markers[key].end !== null ? ` → ${formatTime(markers[key].end)}` : ' → ?'}
                    </span>
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

          <div className="recording-section">
            <div className="controls">
              {!isRecording ? (
                <button className="btn btn-record" onClick={startRecording} disabled={!isLoaded}>
                  ⏺ Record
                </button>
              ) : (
                <button className="btn btn-stop-record" onClick={stopRecording}>
                  ⏹ Stop Rec
                </button>
              )}
              {recordingBlob && (
                <button className="btn btn-download" onClick={downloadRecording}>
                  ⬇ Download
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
})

export default TrackPlayer
