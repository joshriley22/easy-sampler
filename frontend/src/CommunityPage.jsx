import { useEffect, useState, useRef } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function CommunityPage() {
  const [songs, setSongs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [playingId, setPlayingId] = useState(null)
  const audioElRef = useRef(null)

  useEffect(() => {
    const audio = new Audio()
    audio.onended = () => setPlayingId(null)
    audioElRef.current = audio
    return () => { audio.pause(); audio.src = '' }
  }, [])

  useEffect(() => {
    fetch(`${API_BASE}/api/songs`)
      .then((r) => r.json())
      .then((data) => { setSongs(data); setLoading(false) })
      .catch((err) => { setError(err.message); setLoading(false) })
  }, [])

  const handleLike = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/songs/${id}/like`, { method: 'POST' })
      if (!res.ok) throw new Error(`Like failed (${res.status})`)
      const updated = await res.json()
      setSongs((prev) => prev.map((s) => (s.id === id ? updated : s)))
    } catch (err) {
      alert(`Could not like: ${err.message}`)
    }
  }

  const getPresignedUrl = async (id) => {
    const res = await fetch(`${API_BASE}/api/songs/${id}/download-url`)
    if (!res.ok) throw new Error(`Could not get URL (${res.status})`)
    const { url } = await res.json()
    return url
  }

  const handleDownload = async (id, title) => {
    try {
      const url = await getPresignedUrl(id)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.mp3`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      alert(`Download failed: ${err.message}`)
    }
  }

  const handlePlay = async (id) => {
    const audio = audioElRef.current
    if (!audio) return
    if (playingId === id) {
      audio.pause()
      setPlayingId(null)
      return
    }
    try {
      const url = await getPresignedUrl(id)
      audio.src = url
      await audio.play()
      setPlayingId(id)
    } catch (err) {
      alert(`Playback failed: ${err.message}`)
    }
  }

  return (
    <div className="community-page">
      <h2 className="community-heading">🌐 Community Uploads</h2>
      <p className="community-subtitle">Browse samples shared by other users.</p>
      {loading && <p className="community-subtitle">Loading…</p>}
      {error && <p className="community-subtitle" style={{ color: '#ff8888' }}>Failed to load: {error}</p>}
      <div className="community-list">
        {songs.map((entry) => (
          <div key={entry.id} className="community-entry">
            <span className="community-entry-title">{entry.title}</span>
            <span className="community-entry-likes">♥ {entry.likes}</span>
            <div className="community-entry-actions">
              <button className="btn btn-ghost" aria-label={`Like ${entry.title}`} onClick={() => handleLike(entry.id)}>
                <span aria-hidden="true">♥</span> Like
              </button>
              <button className="btn btn-ghost" aria-label={`Download ${entry.title}`} onClick={() => handleDownload(entry.id, entry.title)}>
                <span aria-hidden="true">⬇</span> Download
              </button>
              <button className="btn btn-primary" aria-label={`Play ${entry.title}`} onClick={() => handlePlay(entry.id)}>
                <span aria-hidden="true">{playingId === entry.id ? '⏸' : '▶'}</span> {playingId === entry.id ? 'Pause' : 'Play'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default CommunityPage
