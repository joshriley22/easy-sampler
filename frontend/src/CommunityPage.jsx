import './App.css'

const SAMPLE_ENTRIES = [
  { id: 1, title: 'Chill Lo-Fi Beat' },
  { id: 2, title: 'Drum Loop 120 BPM' },
  { id: 3, title: 'Ambient Pad Layer' },
  { id: 4, title: 'Hip Hop Bass Line' },
  { id: 5, title: 'Jazz Guitar Riff' },
  { id: 6, title: 'Synthwave Arp' },
]

function CommunityPage() {
  return (
    <div className="community-page">
      <h2 className="community-heading">🌐 Community Uploads</h2>
      <p className="community-subtitle">Browse samples shared by other users.</p>
      <div className="community-list">
        {SAMPLE_ENTRIES.map((entry) => (
          <div key={entry.id} className="community-entry">
            <span className="community-entry-title">{entry.title}</span>
            <div className="community-entry-actions">
              <button className="btn btn-ghost" aria-label={`Like ${entry.title}`}><span aria-hidden="true">♥</span> Like</button>
              <button className="btn btn-ghost" aria-label={`Download ${entry.title}`}><span aria-hidden="true">⬇</span> Download</button>
              <button className="btn btn-primary" aria-label={`Play ${entry.title}`}><span aria-hidden="true">▶</span> Play</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default CommunityPage
