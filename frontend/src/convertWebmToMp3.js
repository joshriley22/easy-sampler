import lamejs from '@breezystack/lamejs'

/**
 * Decodes a WebM audio Blob and re-encodes it as an MP3 Blob.
 * @param {Blob} webmBlob  The recorded WebM audio blob.
 * @returns {Promise<Blob>} A new Blob with type "audio/mp3".
 */
export async function convertWebmToMp3(webmBlob) {
  const arrayBuffer = await webmBlob.arrayBuffer()
  const audioCtx = new AudioContext()
  let audioBuffer
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
  } catch {
    audioCtx.close()
    throw new Error('Could not decode audio data. The recording may be empty or unsupported.')
  }
  audioCtx.close()

  const numChannels = Math.min(audioBuffer.numberOfChannels, 2)
  const sampleRate = audioBuffer.sampleRate
  const bitRate = 128

  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitRate)

  const left = float32ToInt16(audioBuffer.getChannelData(0))
  const right = numChannels > 1 ? float32ToInt16(audioBuffer.getChannelData(1)) : left

  const mp3Chunks = []
  const blockSize = 1152

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize)
    const rightChunk = right.subarray(i, i + blockSize)
    const encoded = numChannels > 1
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk)
    if (encoded.length > 0) mp3Chunks.push(new Uint8Array(encoded))
  }

  const tail = encoder.flush()
  if (tail.length > 0) mp3Chunks.push(new Uint8Array(tail))

  return new Blob(mp3Chunks, { type: 'audio/mp3' })
}

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}
