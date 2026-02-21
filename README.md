# easy-sampler

A FastAPI + React audio sampling tool. Upload an MP3, visualise the waveform, place jump markers (keys **0–9**) and record your performance.

## Features

- **Drag & Drop** MP3 upload  
- **WaveSurfer.js** interactive waveform  
- **Marker placement** – click the waveform to position the cursor, then press a number key (0–9) to save that timestamp as a marker  
- **Keyboard jump** – press the same number key (without first clicking) to jump to the saved marker and start playback  
- **MediaRecorder recording** – capture the live audio output while you play and jump between markers, then download the result  

## Quick Start

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

The FastAPI server runs on <http://localhost:8000>.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server runs on <http://localhost:5173> and proxies `/api` requests to the FastAPI backend.

## How to Use

1. Drop or browse for an MP3 file.  
2. The waveform loads automatically.  
3. **Place a marker**: click anywhere on the waveform, then press a number key (0–9) within 1.5 s to save that position.  
4. **Jump to a marker**: press the corresponding number key at any time (without a recent click).  
5. To record a session: click **Start Recording**, play the file and jump between markers using your keys, then click **Stop Recording** and **Download Recording**.
