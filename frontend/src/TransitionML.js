/**
 * TransitionML – TensorFlow.js-backed model that learns optimal transition
 * parameters (fadeInMs, duckRatio, layerLevel) from user-saved examples.
 *
 * Features  (inputs):  rms, flux, bpm
 * Labels    (outputs): fadeInMs, duckRatio, layerLevel
 *
 * Training data is persisted in localStorage so it survives page reloads.
 * The model falls back to null (caller uses heuristics) until MIN_SAMPLES
 * examples have been collected.
 */

import * as tf from '@tensorflow/tfjs'

const STORAGE_KEY = 'easy-sampler-transition-training'
const MIN_SAMPLES = 5

// ── Normalisation ranges ──
const FEAT_RANGES = {
  rms:       [0, 0.5],
  flux:      [0, 0.05],
  bpm:       [60, 200],
}
const LABEL_RANGES = {
  fadeInMs:  [20, 500],
  duckRatio: [0.3, 1.0],
  layerLevel:[0.3, 1.0],
}

function normalise(value, [min, max]) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)))
}

function denormalise(value, [min, max]) {
  return min + value * (max - min)
}

function featuresToTensor({ rms, flux, bpm }) {
  return [
    normalise(rms,  FEAT_RANGES.rms),
    normalise(flux, FEAT_RANGES.flux),
    normalise(bpm,  FEAT_RANGES.bpm),
  ]
}

function labelsToTensor({ fadeInMs, duckRatio, layerLevel }) {
  return [
    normalise(fadeInMs,   LABEL_RANGES.fadeInMs),
    normalise(duckRatio,  LABEL_RANGES.duckRatio),
    normalise(layerLevel, LABEL_RANGES.layerLevel),
  ]
}

function tensorToLabels([fadeInNorm, duckRatioNorm, layerLevelNorm]) {
  return {
    fadeInMs:   Math.round(denormalise(fadeInNorm, LABEL_RANGES.fadeInMs)),
    duckRatio:  parseFloat(denormalise(duckRatioNorm, LABEL_RANGES.duckRatio).toFixed(2)),
    layerLevel: parseFloat(denormalise(layerLevelNorm, LABEL_RANGES.layerLevel).toFixed(2)),
  }
}

class TransitionML {
  constructor() {
    this.model = null
    this.isReady = false
    this.trainingData = this._loadData()
    // Kick off training if data already exists from a previous session
    if (this.trainingData.length >= MIN_SAMPLES) {
      this.train().catch(() => {/* ignore */})
    }
  }

  // ── Persistence ──

  _loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  _saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.trainingData))
    } catch (err) {
      console.warn('[TransitionML] Could not persist training data:', err)
    }
  }

  getSampleCount() {
    return this.trainingData.length
  }

  /** Add a user-confirmed training example and retrain the model. */
  addSample(features, labels) {
    this.trainingData.push({ features, labels })
    this._saveData()
  }

  /** Clear all training data and reset the model. */
  clearData() {
    this.trainingData = []
    this.isReady = false
    this.model = null
    localStorage.removeItem(STORAGE_KEY)
  }

  // ── Model ──

  _buildModel() {
    const model = tf.sequential()
    model.add(tf.layers.dense({ inputShape: [3], units: 8, activation: 'relu' }))
    model.add(tf.layers.dense({ units: 8, activation: 'relu' }))
    model.add(tf.layers.dense({ units: 3, activation: 'sigmoid' }))
    model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' })
    return model
  }

  /** (Re-)train the model on all stored examples. Returns a Promise. */
  async train() {
    if (this.trainingData.length < MIN_SAMPLES) return

    const xs = this.trainingData.map((d) => featuresToTensor(d.features))
    const ys = this.trainingData.map((d) => labelsToTensor(d.labels))

    const xTensor = tf.tensor2d(xs)
    const yTensor = tf.tensor2d(ys)

    if (!this.model) {
      this.model = this._buildModel()
    }

    await this.model.fit(xTensor, yTensor, {
      epochs: 80,
      batchSize: Math.max(1, this.trainingData.length),
      shuffle: true,
      verbose: 0,
    })

    xTensor.dispose()
    yTensor.dispose()

    this.isReady = true
  }

  /**
   * Predict transition params from audio features.
   * Returns { fadeInMs, duckRatio, layerLevel } or null if the model isn't
   * ready yet (caller should use heuristics instead).
   */
  predict({ rms, flux, bpm }) {
    if (!this.isReady || !this.model) return null

    const input = tf.tensor2d([featuresToTensor({ rms, flux, bpm })])
    const output = this.model.predict(input)
    const values = Array.from(output.dataSync())
    input.dispose()
    output.dispose()

    return tensorToLabels(values)
  }
}

export const transitionML = new TransitionML()
