import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import WebAudioPlayer from 'wavesurfer.js/dist/webaudio.js'
import { guess } from 'web-audio-beat-detector'
import { transitionML } from './TransitionML'

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

// ── "AI" selector: pick fade params from analyser features ──
// Threshold values for heuristic classification (tune as needed)
const PERCUSSIVE_FLUX_THRESHOLD = 0.008  // flux above this → percussive content
const HIGH_RMS_THRESHOLD_B = 0.15        // incoming track RMS above this → stronger duck
const LOUD_RMS_THRESHOLD_B = 0.2         // incoming track much louder → cap layer level
const DUCK_RATIO_LOUD = 0.55             // duck other tracks to 55% when incoming is loud
const DUCK_RATIO_NORMAL = 0.75           // duck other tracks to 75% in normal case
const LAYER_LEVEL_CAPPED = 0.7           // cap layer volume when incoming track is very loud

// Ducking envelope timings (seconds)
const DUCK_FADE_IN_S = 0.15    // time to ramp down to duck level
const DUCK_HOLD_S = 0.4        // time held at duck level
const DUCK_RETURN_S = 0.4      // time to return to full volume

// Feature peek duration: how long (ms) to collect analyser data before scheduling fade-in
const FEATURE_PEEK_MS = 200

// Maximum distance (seconds) from a beat for end-marker beat-snapping to apply
const END_MARKER_BEAT_SNAP_THRESHOLD_S = 1

// Waveform zoom limits and defaults (pixels per second)
const MIN_ZOOM = 10
const MAX_ZOOM = 2000
const DEFAULT_ZOOM = 50
const ZOOM_WHEEL_FACTOR = 1.15

function pickLayerParams(featuresB) {
  const { rms: rmsB, flux: fluxB } = featuresB
  // Percussive (high flux) → short fade, minimal duck
  // Sustained (low flux)   → long fade, stronger duck
  const percussive = fluxB > PERCUSSIVE_FLUX_THRESHOLD
  const fadeInMs = percussive ? 40 : 200
  const duckRatio = (rmsB > HIGH_RMS_THRESHOLD_B) ? DUCK_RATIO_LOUD : DUCK_RATIO_NORMAL
  const layerLevel = (rmsB > LOUD_RMS_THRESHOLD_B) ? LAYER_LEVEL_CAPPED : 1.0
  const curve = percussive ? 'linear' : 'equalPower'
  return { fadeInMs, duckRatio, layerLevel, curve }
}

// Build an equal-power fade-in curve (Float32Array of `steps` values, 0→1)
function equalPowerCurve(steps) {
  const arr = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    arr[i] = Math.sin((Math.PI / 2) * (i / (steps - 1)))
  }
  return arr
}

const TrackPlayer = forwardRef(function TrackPlayer(
  { trackIndex, assignedKeys, label, getAudioContext, getMasterGain, onLayerTrigger },
  ref
) {
  const waveformRef = useRef(null)
  const wavesurferRef = useRef(null)
  const webAudioPlayerRef = useRef(null)
  const regionsRef = useRef(null)
  const markersRef = useRef({})
  const lastInteractionRef = useRef({ time: 0, timestamp: 0 })
  const activeLoopRef = useRef(null)
  const isLoadedRef = useRef(false)
  const volumeRef = useRef(1)
  const autoGainRef = useRef(null)     // automation gain (duck/fade)
  const analyserRef = useRef(null)     // for RMS + flux
  const featuresRef = useRef({ rms: 0, flux: 0 })
  const featuresWindowRef = useRef([]) // rolling 200 ms window
  const animFrameRef = useRef(null)
  const prevFreqRef = useRef(null)     // previous FFT frame for flux

  // Store stable props in refs so effects/callbacks don't need them in dep arrays
  const assignedKeysRef = useRef(assignedKeys)
  const labelRef = useRef(label)
  const getAudioContextRef = useRef(getAudioContext)
  const getMasterGainRef = useRef(getMasterGain)
  const onLayerTriggerRef = useRef(onLayerTrigger)
  useEffect(() => { getAudioContextRef.current = getAudioContext }, [getAudioContext])
  useEffect(() => { getMasterGainRef.current = getMasterGain }, [getMasterGain])
  useEffect(() => { onLayerTriggerRef.current = onLayerTrigger }, [onLayerTrigger])

  // Beat detection state
  const bpmRef = useRef(null)
  const beatOffsetRef = useRef(0)
  const [detectedBpm, setDetectedBpm] = useState(null)

  // ML transition state
  const lastFeaturesRef = useRef(null)   // features captured at last layer trigger
  const setTransParamsRef = useRef(null) // stable ref to state setter (for use inside callbacks)
  const setMlStatusRef = useRef(null)
  const [transitionParams, setTransitionParams] = useState(null) // null = no trigger yet
  const [mlStatus, setMlStatus] = useState(() => ({
    sampleCount: transitionML.getSampleCount(),
    ready: transitionML.isReady,
    source: 'heuristic',
  }))
  // Sync stable state setters into refs so triggerLayer (no-dep callback) can call them
  useEffect(() => { setTransParamsRef.current = setTransitionParams }, [])
  useEffect(() => { setMlStatusRef.current = setMlStatus }, [])

  const [audioFile, setAudioFile] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [markers, setMarkers] = useState({})
  const [volume, setVolume] = useState(1)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const zoomRef = useRef(DEFAULT_ZOOM)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState(`Drop or select an MP3 for ${label}.`)

  useEffect(() => { isLoadedRef.current = isLoaded }, [isLoaded])

  // ── Beat-snap: round time to nearest beat given current BPM/offset ──
  const snapToBeat = useCallback((time) => {
    const bpm = bpmRef.current
    if (!bpm) return time
    const beatLen = 60 / bpm
    const beats = (time - beatOffsetRef.current) / beatLen
    return beatOffsetRef.current + Math.round(beats) * beatLen
  }, [])

  // ── Feature extraction loop ──
  const stopFeatureExtraction = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
  }, [])

  const startFeatureExtraction = useCallback((analyser) => {
    stopFeatureExtraction()
    const bufLen = analyser.frequencyBinCount
    const timeDomain = new Float32Array(bufLen)
    const freqDomain = new Float32Array(bufLen)
    prevFreqRef.current = new Float32Array(bufLen)

    const tick = () => {
      if (!analyserRef.current) return

      // RMS from time-domain data
      analyser.getFloatTimeDomainData(timeDomain)
      let sumSq = 0
      for (let i = 0; i < bufLen; i++) sumSq += timeDomain[i] * timeDomain[i]
      const rms = Math.sqrt(sumSq / bufLen)

      // Spectral flux: sum of positive magnitude changes between frames
      analyser.getFloatFrequencyData(freqDomain)
      let flux = 0
      const prev = prevFreqRef.current
      for (let i = 0; i < bufLen; i++) {
        const mag = Math.pow(10, freqDomain[i] / 20) // dB → linear
        const prevMag = Math.pow(10, prev[i] / 20)
        flux += Math.max(0, mag - prevMag)
      }
      flux /= bufLen
      prev.set(freqDomain)

      // Rolling 200 ms window
      const now = Date.now()
      featuresWindowRef.current.push({ rms, flux, t: now })
      featuresWindowRef.current = featuresWindowRef.current.filter((f) => now - f.t < FEATURE_PEEK_MS)
      const w = featuresWindowRef.current
      if (w.length > 0) {
        featuresRef.current = {
          rms: w.reduce((s, f) => s + f.rms, 0) / w.length,
          flux: w.reduce((s, f) => s + f.flux, 0) / w.length,
        }
      }

      animFrameRef.current = requestAnimationFrame(tick)
    }
    animFrameRef.current = requestAnimationFrame(tick)
  }, [stopFeatureExtraction])

  // ── Build / rebuild WaveSurfer whenever audioFile changes ──
  useEffect(() => {
    if (!audioFile || !waveformRef.current) return

    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
      wavesurferRef.current = null
    }
    stopFeatureExtraction()

    // Create a WebAudioPlayer backed by the shared AudioContext
    const audioCtx = getAudioContextRef.current()
    const webAudioPlayer = new WebAudioPlayer(audioCtx)
    webAudioPlayerRef.current = webAudioPlayer

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
      media: webAudioPlayer, // route audio through our shared AudioContext
    })

    wavesurferRef.current = ws
    ws.setVolume(volumeRef.current)

    ws.on('ready', () => {
      // ── Wire up per-track audio chain ──
      const masterGain = getMasterGainRef.current()
      if (masterGain) {
        const wsGainNode = webAudioPlayer.getGainNode()
        // Redirect: disconnect from default destination, route through our chain
        try {
          wsGainNode.disconnect()
        } catch (e) {
          if (!(e instanceof DOMException)) throw e // rethrow unexpected errors
        }

        const autoGain = audioCtx.createGain()
        autoGain.gain.value = 1

        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.8

        // source (wsGainNode / baseGain) → autoGain → analyser → masterGain
        wsGainNode.connect(autoGain)
        autoGain.connect(analyser)
        analyser.connect(masterGain)

        autoGainRef.current = autoGain
        analyserRef.current = analyser

        startFeatureExtraction(analyser)
      }

      setIsLoaded(true)
      setDuration(ws.getDuration())
      setCurrentTime(0)

      // Compute and store the fit-to-container zoom level
      const dur = ws.getDuration()
      const containerWidth = waveformRef.current?.clientWidth ?? 400
      const fitZoom = Math.max(MIN_ZOOM, Math.floor(containerWidth / dur))
      zoomRef.current = fitZoom
      setZoom(fitZoom)

      setStatus(`File loaded. Press ${assignedKeysRef.current.join('/')} while playing to set markers, or click waveform then press a key.`)

      // Run beat detection on the decoded audio buffer
      const audioBuffer = ws.getDecodedData()
      if (audioBuffer) {
        guess(audioBuffer)
          .then(({ bpm, offset }) => {
            bpmRef.current = bpm
            beatOffsetRef.current = offset
            setDetectedBpm(Math.round(bpm))
          })
          .catch(() => {
            // Beat detection failed — continue without snapping
            bpmRef.current = null
          })
      }
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => setIsPlaying(false))
    ws.on('timeupdate', (t) => {
      setCurrentTime(t)
      const loopKey = activeLoopRef.current
      if (loopKey !== null && ws.isPlaying()) {
        const marker = markersRef.current[loopKey]
        const autoGain = autoGainRef.current
        if (marker && marker.end !== null && autoGain && t >= marker.end - 0.05) {
          const featuresB = { ...featuresRef.current }
          const { fadeInMs, layerLevel, curve } = pickLayerParams(featuresB)
          const fadeSec = fadeInMs / 1000
          
          const now = audioCtx.currentTime
          autoGain.gain.cancelScheduledValues(now)
          autoGain.gain.setValueAtTime(autoGain.gain.value, now)
          autoGain.gain.linearRampToValueAtTime(0, now + 0.02)
          
          setTimeout(() => {
            ws.setTime(marker.start)
            const nowAfter = audioCtx.currentTime
            const steps = Math.max(2, Math.round(fadeSec * 100))
            autoGain.gain.cancelScheduledValues(nowAfter)
            autoGain.gain.setValueAtTime(0, nowAfter)
            
            if (curve === 'equalPower') {
              const curveArr = equalPowerCurve(steps)
              for (let i = 0; i < steps; i++) curveArr[i] *= layerLevel
              autoGain.gain.setValueCurveAtTime(curveArr, nowAfter, fadeSec)
            } else {
              autoGain.gain.linearRampToValueAtTime(layerLevel, nowAfter + fadeSec)
            }
          }, 20)
        }
      }
    })

    ws.on('interaction', (newTime) => {
      lastInteractionRef.current = { time: Date.now(), timestamp: newTime }
    })

    ws.loadBlob(audioFile)

    return () => {
      stopFeatureExtraction()
      if (autoGainRef.current) {
        try { autoGainRef.current.disconnect() } catch { /* ignore */ }
        autoGainRef.current = null
      }
      if (analyserRef.current) {
        try { analyserRef.current.disconnect() } catch { /* ignore */ }
        analyserRef.current = null
      }
      ws.destroy()
      wavesurferRef.current = null
      webAudioPlayerRef.current = null
    }
  }, [audioFile, startFeatureExtraction, stopFeatureExtraction])

  // ── VOLUME ──
  const handleVolumeChange = useCallback((e) => {
    const v = parseFloat(e.target.value)
    volumeRef.current = v
    setVolume(v)
    wavesurferRef.current?.setVolume(v)
  }, [])

  // ── ZOOM ──
  const handleZoomChange = useCallback((e) => {
    const z = parseInt(e.target.value)
    zoomRef.current = z
    setZoom(z)
    wavesurferRef.current?.zoom(z)
  }, [])

  const handleZoomReset = useCallback(() => {
    const ws = wavesurferRef.current
    if (!ws) return
    const dur = ws.getDuration()
    const containerWidth = waveformRef.current?.clientWidth ?? 400
    const fitZoom = Math.max(MIN_ZOOM, Math.floor(containerWidth / dur))
    zoomRef.current = fitZoom
    setZoom(fitZoom)
    ws.zoom(fitZoom)
  }, [])

  // ── Duck this track (called from App when another track layers in) ──
  const duck = useCallback((featuresB) => {
    const autoGain = autoGainRef.current
    const audioCtx = getAudioContextRef.current?.()
    if (!autoGain || !audioCtx) return

    const { duckRatio } = pickLayerParams(featuresB || { rms: 0.1, flux: 0 })
    const now = audioCtx.currentTime

    autoGain.gain.cancelScheduledValues(now)
    autoGain.gain.setValueAtTime(autoGain.gain.value, now)
    // Ramp down to duck level, hold, then return to full
    autoGain.gain.linearRampToValueAtTime(duckRatio, now + DUCK_FADE_IN_S)
    autoGain.gain.setValueAtTime(duckRatio, now + DUCK_FADE_IN_S + DUCK_HOLD_S)
    autoGain.gain.linearRampToValueAtTime(1.0, now + DUCK_FADE_IN_S + DUCK_HOLD_S + DUCK_RETURN_S)
  }, [])

  // ── Trigger layer: fade this track in and duck all others ──
  const triggerLayer = useCallback((markerStart) => {
    const ws = wavesurferRef.current
    const autoGain = autoGainRef.current
    const audioCtx = getAudioContextRef.current?.()
    if (!ws || !autoGain || !audioCtx) return

    // 1. Seek + start muted
    ws.setTime(markerStart)
    autoGain.gain.cancelScheduledValues(audioCtx.currentTime)
    autoGain.gain.setValueAtTime(0, audioCtx.currentTime)
    ws.play()

    // 2. Peek features for FEATURE_PEEK_MS (track plays muted while analyser collects data)
    setTimeout(() => {
      const featuresB = { ...featuresRef.current }
      const bpmVal = bpmRef.current || 120

      // 3. Pick fade params — prefer ML prediction, fall back to heuristics
      const heuristic = pickLayerParams(featuresB)
      const mlPred = transitionML.predict({ rms: featuresB.rms, flux: featuresB.flux, bpm: bpmVal })
      const params = mlPred
        ? { ...heuristic, ...mlPred, curve: mlPred.fadeInMs < 100 ? 'linear' : 'equalPower' }
        : heuristic

      const { fadeInMs, layerLevel, curve } = params

      // Store features + params so the UI can display them and the user can save them
      lastFeaturesRef.current = { rms: featuresB.rms, flux: featuresB.flux, bpm: bpmVal }
      setTransParamsRef.current?.({
        fadeInMs:   params.fadeInMs,
        duckRatio:  params.duckRatio,
        layerLevel: params.layerLevel,
      })
      setMlStatusRef.current?.({
        sampleCount: transitionML.getSampleCount(),
        ready: transitionML.isReady,
        source: mlPred ? 'ml' : 'heuristic',
      })

      // 4. Schedule fade-in for this track
      const now = audioCtx.currentTime
      const fadeSec = fadeInMs / 1000
      const steps = Math.max(2, Math.round(fadeSec * 100))

      autoGain.gain.cancelScheduledValues(now)
      autoGain.gain.setValueAtTime(0, now)

      if (curve === 'equalPower') {
        const curveArr = equalPowerCurve(steps)
        // Scale curve to layerLevel
        for (let i = 0; i < steps; i++) curveArr[i] *= layerLevel
        autoGain.gain.setValueCurveAtTime(curveArr, now, fadeSec)
      } else {
        // Linear
        autoGain.gain.linearRampToValueAtTime(layerLevel, now + fadeSec)
      }

      // 5. Duck all other tracks
      onLayerTriggerRef.current?.(featuresB)
    }, FEATURE_PEEK_MS)
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
      // Reset autoGain to 1 when stopped
      const autoGain = autoGainRef.current
      const audioCtx = getAudioContextRef.current?.()
      if (autoGain && audioCtx) {
        autoGain.gain.cancelScheduledValues(audioCtx.currentTime)
        autoGain.gain.setValueAtTime(1, audioCtx.currentTime)
      }
      setStatus(`Stopped (${labelRef.current}). Press ${assignedKeysRef.current.join('/')} to jump to a marker.`)
      return
    }

    const regions = regionsRef.current
    const timeSinceCursor = Date.now() - lastInteractionRef.current.time

    if (timeSinceCursor < 1500) {
      // ── PLACE / UPDATE MARKER ──
      const rawTime = lastInteractionRef.current.timestamp
      const clickedTime = snapToBeat(rawTime)
      lastInteractionRef.current = { time: 0, timestamp: 0 }

      const existing = markersRef.current[key]

      if (existing && existing.end === null) {
        // Start already set — this click sets the end
        // Snap to beat only if the nearest beat is within 1 second of where the user clicked
        const endTime = Math.abs(clickedTime - rawTime) <= END_MARKER_BEAT_SNAP_THRESHOLD_S ? clickedTime : rawTime
        if (endTime <= existing.start) {
          setStatus(`End marker for key ${key} must be after the start (${formatTime(existing.start)}). Click at a later time position.`)
          return
        }

        regions.getRegions().forEach((r) => {
          if (r.id === `marker-${key}`) r.remove()
        })

        regions.addRegion({
          id: `marker-${key}`,
          start: existing.start,
          end: endTime,
          color: MARKER_COLORS[parseInt(key)],
          content: key,
          drag: false,
          resize: false,
        })

        const updated = { ...markersRef.current, [key]: { start: existing.start, end: endTime } }
        markersRef.current = updated
        setMarkers({ ...updated })
        setStatus(`Marker ${key}: ${formatTime(existing.start)} → ${formatTime(endTime)}. Press ${key} to jump and loop.`)
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
        setStatus(`Marker ${key} start set at ${formatTime(clickedTime)}${bpmRef.current ? ` (beat-snapped, ${bpmRef.current} BPM)` : ''}. Click another spot and press ${key} again to set the end marker.`)
      }
    } else if (ws.isPlaying() && (markersRef.current[key] === undefined || markersRef.current[key].end === null)) {
      // ── PLACE MARKER AT CURRENT PLAYBACK POSITION (while playing, no recent click) ──
      const rawTime = ws.getCurrentTime()
      const clickedTime = snapToBeat(rawTime)
      const existing = markersRef.current[key]

      if (existing && existing.end === null) {
        // Start already set — set end at current playback position
        const endTime = Math.abs(clickedTime - rawTime) <= END_MARKER_BEAT_SNAP_THRESHOLD_S ? clickedTime : rawTime
        if (endTime <= existing.start) {
          setStatus(`End marker for key ${key} must be after the start (${formatTime(existing.start)}). Wait until playback passes the start position.`)
          return
        }

        regions.getRegions().forEach((r) => {
          if (r.id === `marker-${key}`) r.remove()
        })

        regions.addRegion({
          id: `marker-${key}`,
          start: existing.start,
          end: endTime,
          color: MARKER_COLORS[parseInt(key)],
          content: key,
          drag: false,
          resize: false,
        })

        const updated = { ...markersRef.current, [key]: { start: existing.start, end: endTime } }
        markersRef.current = updated
        setMarkers({ ...updated })
        setStatus(`Marker ${key}: ${formatTime(existing.start)} → ${formatTime(endTime)}. Press ${key} to jump and loop.`)
      } else {
        // No marker — set start at current playback position
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
        setStatus(`Marker ${key} start set at ${formatTime(clickedTime)}${bpmRef.current ? ` (beat-snapped, ${bpmRef.current} BPM)` : ''}. Press ${key} again while playing to set the end marker.`)
      }
    } else if (markersRef.current[key] !== undefined) {
      // ── LAYER TRIGGER: jump to marker, fade in, duck others ──
      const marker = markersRef.current[key]
      activeLoopRef.current = marker.end !== null ? key : null
      triggerLayer(marker.start)
      setStatus(`Layering in at marker ${key} (${formatTime(marker.start)}) — fading in, ducking others.`)
    } else {
      setStatus(`No marker on key ${key} yet. Click waveform or press ${key} while playing to place a start marker.`)
    }
  }, [triggerLayer, snapToBeat]) // triggerLayer and snapToBeat are stable (no deps), safe to include

  // ── SAVE TRANSITION: add current features + (possibly user-edited) params to ML training ──
  const saveTransition = useCallback(async () => {
    if (!lastFeaturesRef.current || !transitionParams) return
    transitionML.addSample(lastFeaturesRef.current, transitionParams)
    await transitionML.train()
    setMlStatus({
      sampleCount: transitionML.getSampleCount(),
      ready: transitionML.isReady,
      source: transitionML.isReady ? 'ml' : 'heuristic',
    })
  }, [transitionParams])

  useImperativeHandle(ref, () => ({ handleKey, duck }), [handleKey, duck])

  // ── WHEEL ZOOM: scroll on waveform zooms in/out ──
  useEffect(() => {
    const el = waveformRef.current
    if (!el || !isLoaded) return
    const onWheel = (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoomRef.current * factor)))
      if (next === zoomRef.current) return
      zoomRef.current = next
      setZoom(next)
      wavesurferRef.current?.zoom(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isLoaded])

  // ── PLAYBACK CONTROLS ──
  const handlePlayPause = () => wavesurferRef.current?.playPause()
  const handleStop = () => {
    wavesurferRef.current?.stop()
    activeLoopRef.current = null
    const autoGain = autoGainRef.current
    const audioCtx = getAudioContextRef.current?.()
    if (autoGain && audioCtx) {
      autoGain.gain.cancelScheduledValues(audioCtx.currentTime)
      autoGain.gain.setValueAtTime(1, audioCtx.currentTime)
    }
  }

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
    setDuration(0)
    setCurrentTime(0)
    zoomRef.current = DEFAULT_ZOOM
    setZoom(DEFAULT_ZOOM)
    bpmRef.current = null
    beatOffsetRef.current = 0
    setDetectedBpm(null)
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
    stopFeatureExtraction()
    autoGainRef.current = null
    analyserRef.current = null
    bpmRef.current = null
    beatOffsetRef.current = 0
    setDetectedBpm(null)
    setAudioFile(null)
    setIsLoaded(false)
    setIsPlaying(false)
    setMarkers({})
    markersRef.current = {}
    activeLoopRef.current = null
    setDuration(0)
    setCurrentTime(0)
    zoomRef.current = DEFAULT_ZOOM
    setZoom(DEFAULT_ZOOM)
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

          {isLoaded && (
            <div className="zoom-control">
              <span className="zoom-icon">🔍</span>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="5"
                value={zoom}
                onChange={handleZoomChange}
                className="zoom-slider"
                aria-label={`Waveform zoom level for ${label}`}
              />
              <button
                className="btn btn-ghost"
                onClick={handleZoomReset}
                title="Reset zoom to fit entire track"
                aria-label="Reset zoom to fit"
              >
                ↺
              </button>
              <span className="zoom-value">{zoom} px/s</span>
            </div>
          )}

          <div className="track-time-volume">
            <div className="time-display">
              <span>{formatTime(currentTime)}</span>
              <span className="time-sep">/</span>
              <span>{formatTime(duration)}</span>
            </div>
            {detectedBpm !== null && (
              <div className="bpm-display" title="Detected BPM — markers will snap to the nearest beat">
                🥁 {detectedBpm} BPM
              </div>
            )}
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

          {/* ── Transition Params editor (shown after first layer trigger) ── */}
          {transitionParams && (
            <div className="transition-params">
              <div className="transition-params-header">
                <span className="transition-params-title">🎛 Transition Params</span>
                <span className={`ml-badge ml-badge--${mlStatus.source}`}>
                  {mlStatus.source === 'ml'
                    ? `🤖 ML (${mlStatus.sampleCount} samples)`
                    : mlStatus.sampleCount > 0
                      ? `⚙️ Heuristic (${mlStatus.sampleCount} saved)`
                      : '⚙️ Heuristic'}
                </span>
              </div>
              <div className="param-row">
                <label className="param-label">Fade In</label>
                <input
                  type="range" min="20" max="500" step="10"
                  value={transitionParams.fadeInMs}
                  onChange={(e) => setTransitionParams((p) => ({ ...p, fadeInMs: +e.target.value }))}
                  className="param-slider"
                  aria-label="Fade-in milliseconds"
                  aria-valuetext={`${transitionParams.fadeInMs} ms`}
                />
                <span className="param-value">{transitionParams.fadeInMs} ms</span>
              </div>
              <div className="param-row">
                <label className="param-label">Duck Ratio</label>
                <input
                  type="range" min="0.3" max="1" step="0.05"
                  value={transitionParams.duckRatio}
                  onChange={(e) => setTransitionParams((p) => ({ ...p, duckRatio: +e.target.value }))}
                  className="param-slider"
                  aria-label="Duck ratio for other tracks"
                  aria-valuetext={`${Math.round(transitionParams.duckRatio * 100)}%`}
                />
                <span className="param-value">{Math.round(transitionParams.duckRatio * 100)}%</span>
              </div>
              <div className="param-row">
                <label className="param-label">Layer Level</label>
                <input
                  type="range" min="0.3" max="1" step="0.05"
                  value={transitionParams.layerLevel}
                  onChange={(e) => setTransitionParams((p) => ({ ...p, layerLevel: +e.target.value }))}
                  className="param-slider"
                  aria-label="Layer volume level"
                  aria-valuetext={`${Math.round(transitionParams.layerLevel * 100)}%`}
                />
                <span className="param-value">{Math.round(transitionParams.layerLevel * 100)}%</span>
              </div>
              <button
                className="btn btn-save-transition"
                onClick={saveTransition}
                title={`Save these params as a training example (${mlStatus.sampleCount + 1} total)`}
              >
                💾 Save Transition
              </button>
            </div>
          )}

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
        </>
      )}
    </div>
  )
})

export default TrackPlayer
