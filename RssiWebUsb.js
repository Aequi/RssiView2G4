"use strict";

const VENDOR_ID = 0xAAAA;
const PRODUCT_ID = 0xBBBB;
const CONFIGURATION = 1;
const INTERFACE = 0;
const ENDPOINT = 1;
const PACKET_SIZE = 51;
const FIRST_FREQUENCY_MHZ = 2400;
const FREQUENCY_STEP_MHZ = 2;
const MIN_RSSI_DBM = -110;
const MAX_RSSI_DBM = -20;
const HISTORY_ROWS = 420;

const elements = {
  connectButton: document.querySelector("#connectButton"),
  connectLabel: document.querySelector("#connectLabel"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  peakRssi: document.querySelector("#peakRssi"),
  peakFrequency: document.querySelector("#peakFrequency"),
  noiseFloor: document.querySelector("#noiseFloor"),
  packetRate: document.querySelector("#packetRate"),
  packetTotal: document.querySelector("#packetTotal"),
  selectedFrequency: document.querySelector("#selectedFrequency"),
  selectedRssi: document.querySelector("#selectedRssi"),
  spectrumCanvas: document.querySelector("#spectrumCanvas"),
  spectrumWrap: document.querySelector("#spectrumWrap"),
  waterfallCanvas: document.querySelector("#waterfallCanvas"),
  waterfallWrap: document.querySelector("#waterfallWrap"),
  emptyState: document.querySelector("#emptyState"),
  freezeButton: document.querySelector("#freezeButton"),
  clearButton: document.querySelector("#clearButton"),
  smoothingInput: document.querySelector("#smoothingInput"),
  smoothingValue: document.querySelector("#smoothingValue"),
  waterfallSmoothingInput: document.querySelector("#waterfallSmoothingInput"),
  waterfallSmoothingValue: document.querySelector("#waterfallSmoothingValue"),
  gainInput: document.querySelector("#gainInput"),
  gainValue: document.querySelector("#gainValue"),
  waterfallRate: document.querySelector("#waterfallRate"),
  compatibilityNote: document.querySelector("#compatibilityNote"),
  compatibilityText: document.querySelector("#compatibilityText"),
  deviceIdentity: document.querySelector("#deviceIdentity"),
  toast: document.querySelector("#toast"),
};

const state = {
  device: null,
  connecting: false,
  running: false,
  connected: false,
  frozen: false,
  hasData: false,
  packetCount: 0,
  invalidCount: 0,
  packetSequence: 0,
  lastWaterfallSequence: -1,
  lastWaterfallAt: 0,
  rateStartedAt: performance.now(),
  ratePacketCount: 0,
  packetRate: 0,
  lastMetricsAt: 0,
  selectedChannel: 25,
  spectrumSmoothingRetention: 0.9,
  waterfallSmoothingRetention: 0.9,
  waterfallGain: 0.7,
  waterfallFps: 30,
  wakeLock: null,
  latest: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  smoothed: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  waterfallSmoothed: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
  held: new Float32Array(PACKET_SIZE).fill(MIN_RSSI_DBM),
};

let toastTimer = 0;
let chartDirty = true;
const spectrumSurface = createSurface(elements.spectrumCanvas, elements.spectrumWrap);
const waterfallSurface = createSurface(elements.waterfallCanvas, elements.waterfallWrap);
const historyCanvas = document.createElement("canvas");
historyCanvas.width = PACKET_SIZE;
historyCanvas.height = HISTORY_ROWS;
const historyContext = historyCanvas.getContext("2d", { alpha: false });
const historyRow = historyContext.createImageData(PACKET_SIZE, 1);
const colorLut = buildColorLut();

function createSurface(canvas, container) {
  const context = canvas.getContext("2d", { alpha: false });
  const surface = { canvas, container, context, width: 0, height: 0, dpr: 1 };

  surface.resize = () => {
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      surface.width = rect.width;
      surface.height = rect.height;
      surface.dpr = dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      chartDirty = true;
    }
  };

  new ResizeObserver(surface.resize).observe(container);
  surface.resize();
  return surface;
}

function buildColorLut() {
  const stops = [
    [0.00, [8, 12, 34]],
    [0.15, [56, 34, 150]],
    [0.34, [21, 117, 194]],
    [0.52, [20, 199, 194]],
    [0.70, [126, 235, 113]],
    [0.86, [255, 220, 75]],
    [1.00, [255, 83, 105]],
  ];
  const lut = new Uint8ClampedArray(256 * 4);

  for (let index = 0; index < 256; index += 1) {
    const position = index / 255;
    let left = stops[0];
    let right = stops[stops.length - 1];
    for (let stopIndex = 1; stopIndex < stops.length; stopIndex += 1) {
      if (position <= stops[stopIndex][0]) {
        left = stops[stopIndex - 1];
        right = stops[stopIndex];
        break;
      }
    }

    const mix = (position - left[0]) / Math.max(0.0001, right[0] - left[0]);
    const offset = index * 4;
    lut[offset] = Math.round(left[1][0] + (right[1][0] - left[1][0]) * mix);
    lut[offset + 1] = Math.round(left[1][1] + (right[1][1] - left[1][1]) * mix);
    lut[offset + 2] = Math.round(left[1][2] + (right[1][2] - left[1][2]) * mix);
    lut[offset + 3] = 255;
  }
  return lut;
}

function rssiToColorIndex(rssi) {
  const normalized = (rssi - MIN_RSSI_DBM) / (MAX_RSSI_DBM - MIN_RSSI_DBM);
  const clamped = Math.max(0, Math.min(1, normalized));
  const gamma = 1.35 - state.waterfallGain * 0.95;
  return Math.round(Math.pow(clamped, gamma) * 255);
}

function colorCss(rssi, alpha = 1) {
  const offset = rssiToColorIndex(rssi) * 4;
  return `rgba(${colorLut[offset]}, ${colorLut[offset + 1]}, ${colorLut[offset + 2]}, ${alpha})`;
}

function setConnectionUi(mode, message) {
  elements.statusPill.dataset.state = mode;
  elements.statusText.textContent = message;
  elements.connectButton.disabled = mode === "connecting";
  elements.connectLabel.textContent = mode === "connected" ? "Disconnect" : mode === "connecting" ? "Opening…" : "Connect";
  elements.emptyState.dataset.hidden = state.hasData ? "true" : "false";
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  toastTimer = window.setTimeout(() => {
    elements.toast.dataset.visible = "false";
  }, 4200);
}

function frequencyForChannel(channel) {
  return FIRST_FREQUENCY_MHZ + channel * FREQUENCY_STEP_MHZ;
}

function acceptPacket(packet) {
  const spectrumRetention = state.spectrumSmoothingRetention;
  const spectrumIncoming = 1 - spectrumRetention;
  const waterfallRetention = state.waterfallSmoothingRetention;
  const waterfallIncoming = 1 - waterfallRetention;

  for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
    const rssi = -packet[channel];
    state.latest[channel] = rssi;

    if (!state.hasData) {
      state.smoothed[channel] = rssi;
      state.waterfallSmoothed[channel] = rssi;
      state.held[channel] = rssi;
      continue;
    }

    state.smoothed[channel] = state.smoothed[channel] * spectrumRetention + rssi * spectrumIncoming;
    state.waterfallSmoothed[channel] = state.waterfallSmoothed[channel] * waterfallRetention
      + rssi * waterfallIncoming;
    state.held[channel] = rssi > state.held[channel]
      ? rssi
      : state.held[channel] * spectrumRetention + rssi * spectrumIncoming;
  }

  state.hasData = true;
  state.packetCount += 1;
  state.ratePacketCount += 1;
  state.packetSequence += 1;
  elements.emptyState.dataset.hidden = "true";
  chartDirty = true;
}

function updateMetrics(now) {
  const elapsed = now - state.rateStartedAt;
  if (elapsed >= 500) {
    const instantRate = state.ratePacketCount * 1000 / elapsed;
    state.packetRate = state.packetRate === 0
      ? instantRate
      : state.packetRate * 0.7 + instantRate * 0.3;
    state.ratePacketCount = 0;
    state.rateStartedAt = now;
  }

  if (!state.hasData) return;

  let peakChannel = 0;
  const sorted = Array.from(state.latest).sort((a, b) => a - b);
  for (let channel = 1; channel < PACKET_SIZE; channel += 1) {
    if (state.latest[channel] > state.latest[peakChannel]) peakChannel = channel;
  }

  elements.peakRssi.textContent = `${Math.round(state.latest[peakChannel])} dBm`;
  elements.peakFrequency.textContent = `${frequencyForChannel(peakChannel)} MHz · channel ${peakChannel + 1}`;
  elements.noiseFloor.textContent = `${Math.round(sorted[Math.floor(sorted.length / 2)])} dBm`;
  elements.packetRate.textContent = `${state.packetRate.toFixed(state.packetRate < 100 ? 1 : 0)}/s`;
  elements.packetTotal.textContent = `${state.packetCount.toLocaleString()} sweeps received`;
  updateSelectedReadout();
}

function updateSelectedReadout() {
  const channel = state.selectedChannel;
  elements.selectedFrequency.textContent = `${frequencyForChannel(channel)} MHz`;
  elements.selectedRssi.textContent = state.hasData ? `${Math.round(state.latest[channel])} dBm` : "— dBm";
}

function spectrumGeometry(surface) {
  const compact = surface.width < 430;
  return {
    left: compact ? 40 : 48,
    top: 15,
    right: compact ? 10 : 16,
    bottom: 27,
  };
}

function drawSpectrum() {
  spectrumSurface.resize();
  const { context, width, height } = spectrumSurface;
  if (!width || !height) return;

  const margin = spectrumGeometry(spectrumSurface);
  const plotLeft = margin.left;
  const plotTop = margin.top;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const plotBottom = plotTop + plotHeight;
  const yForRssi = (rssi) => plotBottom - (Math.max(MIN_RSSI_DBM, Math.min(MAX_RSSI_DBM, rssi)) - MIN_RSSI_DBM)
    / (MAX_RSSI_DBM - MIN_RSSI_DBM) * plotHeight;

  context.fillStyle = "#0b1017";
  context.fillRect(0, 0, width, height);
  context.lineWidth = 1;
  context.font = "11px ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";

  for (let rssi = -100; rssi <= -20; rssi += 20) {
    const y = yForRssi(rssi);
    context.strokeStyle = rssi === -100 ? "rgba(190, 204, 222, 0.38)" : "rgba(190, 204, 222, 0.2)";
    context.beginPath();
    context.moveTo(plotLeft, y + 0.5);
    context.lineTo(plotLeft + plotWidth, y + 0.5);
    context.stroke();
    context.fillStyle = "#b8c5d5";
    context.fillText(`${rssi}`, plotLeft - 7, y);
  }

  for (let frequency = 2400; frequency <= 2500; frequency += 20) {
    const x = plotLeft + (frequency - FIRST_FREQUENCY_MHZ) / 100 * plotWidth;
    context.strokeStyle = "rgba(190, 204, 222, 0.13)";
    context.beginPath();
    context.moveTo(x + 0.5, plotTop);
    context.lineTo(x + 0.5, plotBottom);
    context.stroke();
  }

  const channelWidth = plotWidth / PACKET_SIZE;
  const barWidth = Math.max(1, channelWidth - Math.min(2, channelWidth * 0.24));
  for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
    const x = plotLeft + channel * channelWidth + (channelWidth - barWidth) / 2;
    const top = yForRssi(state.hasData ? state.held[channel] : MIN_RSSI_DBM);
    context.fillStyle = colorCss(state.held[channel], 0.94);
    context.fillRect(x, top, barWidth, Math.max(1, plotBottom - top));
  }

  if (state.hasData) {
    const fill = context.createLinearGradient(0, plotTop, 0, plotBottom);
    fill.addColorStop(0, "rgba(92, 225, 255, 0.24)");
    fill.addColorStop(1, "rgba(92, 225, 255, 0.015)");
    context.beginPath();
    for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
      const x = plotLeft + (channel + 0.5) * channelWidth;
      const y = yForRssi(state.smoothed[channel]);
      if (channel === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.lineTo(plotLeft + plotWidth, plotBottom);
    context.lineTo(plotLeft, plotBottom);
    context.closePath();
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
      const x = plotLeft + (channel + 0.5) * channelWidth;
      const y = yForRssi(state.smoothed[channel]);
      if (channel === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.strokeStyle = "#5ce1ff";
    context.lineWidth = 2;
    context.shadowColor = "rgba(92, 225, 255, 0.68)";
    context.shadowBlur = 9;
    context.stroke();
    context.shadowBlur = 0;
  }

  const selectedX = plotLeft + (state.selectedChannel + 0.5) * channelWidth;
  context.strokeStyle = "rgba(255, 255, 255, 0.42)";
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(selectedX, plotTop);
  context.lineTo(selectedX, plotBottom);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = "#a9b7c8";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillText("dBm", 6, plotTop + 2);
}

function appendWaterfallRow() {
  historyContext.drawImage(historyCanvas, 0, 0, PACKET_SIZE, HISTORY_ROWS - 1, 0, 1, PACKET_SIZE, HISTORY_ROWS - 1);

  for (let channel = 0; channel < PACKET_SIZE; channel += 1) {
    const sourceOffset = rssiToColorIndex(state.waterfallSmoothed[channel]) * 4;
    const destinationOffset = channel * 4;
    historyRow.data[destinationOffset] = colorLut[sourceOffset];
    historyRow.data[destinationOffset + 1] = colorLut[sourceOffset + 1];
    historyRow.data[destinationOffset + 2] = colorLut[sourceOffset + 2];
    historyRow.data[destinationOffset + 3] = 255;
  }
  historyContext.putImageData(historyRow, 0, 0);
}

function clearWaterfall() {
  historyContext.fillStyle = "#070a15";
  historyContext.fillRect(0, 0, PACKET_SIZE, HISTORY_ROWS);
  state.lastWaterfallSequence = state.packetSequence;
  chartDirty = true;
  drawWaterfall();
}

function drawWaterfall() {
  waterfallSurface.resize();
  const { context, width, height } = waterfallSurface;
  if (!width || !height) return;

  const compact = width < 430;
  const left = compact ? 8 : 14;
  const right = compact ? 8 : 14;
  const top = 8;
  const bottom = 24;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  context.fillStyle = "#070a15";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(historyCanvas, left, top, plotWidth, plotHeight);

  context.strokeStyle = "rgba(230, 239, 247, 0.2)";
  context.lineWidth = 1;
  for (let frequency = 2400; frequency <= 2500; frequency += 20) {
    const x = left + (frequency - FIRST_FREQUENCY_MHZ) / 100 * plotWidth;
    context.beginPath();
    context.moveTo(x + 0.5, top);
    context.lineTo(x + 0.5, top + plotHeight);
    context.stroke();
  }

  context.fillStyle = "rgba(238, 245, 252, 0.88)";
  context.font = "10px ui-sans-serif, system-ui, sans-serif";
  context.textBaseline = "bottom";
  context.textAlign = "left";
  context.fillText("2400", left, height - 5);
  context.textAlign = "center";
  context.fillText("2450 MHz", left + plotWidth / 2, height - 5);
  context.textAlign = "right";
  context.fillText("2500", left + plotWidth, height - 5);
}

function animationFrame(now) {
  const interval = 1000 / state.waterfallFps;
  const canAppend = state.hasData
    && !state.frozen
    && state.packetSequence !== state.lastWaterfallSequence
    && now - state.lastWaterfallAt >= interval;

  if (canAppend) {
    appendWaterfallRow();
    state.lastWaterfallSequence = state.packetSequence;
    state.lastWaterfallAt = now;
    chartDirty = true;
  }

  if (chartDirty && !state.frozen) {
    if (now - state.lastMetricsAt >= 250) {
      updateMetrics(now);
      state.lastMetricsAt = now;
    }
    drawSpectrum();
    drawWaterfall();
    chartDirty = false;
  } else if (state.connected && now - state.rateStartedAt >= 500) {
    updateMetrics(now);
  }

  requestAnimationFrame(animationFrame);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null;
  }
}

async function openDevice(device) {
  state.connecting = true;
  setConnectionUi("connecting", "Opening device");

  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(CONFIGURATION);
    await device.claimInterface(INTERFACE);

    state.device = device;
    state.running = true;
    state.connected = true;
    state.connecting = false;
    state.packetCount = 0;
    state.invalidCount = 0;
    state.ratePacketCount = 0;
    state.packetRate = 0;
    state.rateStartedAt = performance.now();
    state.hasData = false;
    clearWaterfall();
    elements.emptyState.dataset.hidden = "false";
    elements.deviceIdentity.textContent = `${device.productName || "RssiDongle"} · ${device.serialNumber || "No serial"}`;
    setConnectionUi("connected", "Connected");
    await requestWakeLock();
    receiveLoop(device);
  } catch (error) {
    state.connecting = false;
    state.running = false;
    state.connected = false;
    state.device = null;
    setConnectionUi("error", "Connection failed");
    showToast(friendlyError(error));
    try { if (device.opened) await device.close(); } catch { /* Device is already gone. */ }
  }
}

async function receiveLoop(device) {
  try {
    while (state.running && state.device === device) {
      const result = await device.transferIn(ENDPOINT, PACKET_SIZE);
      if (result.status !== "ok" || result.data.byteLength !== PACKET_SIZE) {
        state.invalidCount += 1;
        continue;
      }
      acceptPacket(new Uint8Array(result.data.buffer, result.data.byteOffset, PACKET_SIZE));
    }
  } catch (error) {
    if (state.running && state.device === device) {
      showToast(`RSSI stream stopped: ${friendlyError(error)}`);
      await disconnectDevice(false);
    }
  }
}

async function disconnectDevice(closeDevice = true) {
  const device = state.device;
  state.running = false;
  state.connected = false;
  state.connecting = false;
  state.device = null;

  if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch { /* Lock was already released. */ }
    state.wakeLock = null;
  }

  if (closeDevice && device?.opened) {
    try { await device.releaseInterface(INTERFACE); } catch { /* Interface may be detached. */ }
    try { await device.close(); } catch { /* Device may already be gone. */ }
  }

  setConnectionUi("idle", "Offline");
  chartDirty = true;
}

function friendlyError(error) {
  if (!error) return "Unable to open the device.";
  if (error.name === "NotFoundError") return "No device was selected.";
  if (error.name === "SecurityError") return "WebUSB needs HTTPS or localhost and permission to access the device.";
  if (error.name === "NetworkError") return "The device is busy or its WinUSB interface could not be claimed.";
  return error.message || String(error);
}

async function chooseDevice() {
  if (!("usb" in navigator)) {
    elements.compatibilityNote.hidden = false;
    showToast("This browser does not support WebUSB.");
    return;
  }

  if (state.connected) {
    await disconnectDevice();
    return;
  }

  try {
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
    });
    await openDevice(device);
  } catch (error) {
    setConnectionUi("idle", "Offline");
    if (error.name !== "NotFoundError") showToast(friendlyError(error));
  }
}

async function reconnectKnownDevice() {
  if (!("usb" in navigator)) {
    elements.compatibilityNote.hidden = false;
    elements.connectButton.disabled = true;
    setConnectionUi("error", "Unsupported");
    return;
  }

  try {
    const devices = await navigator.usb.getDevices();
    const known = devices.find((device) => device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID);
    if (known) await openDevice(known);
  } catch {
    setConnectionUi("idle", "Offline");
  }
}

function selectSpectrumChannel(event) {
  const rect = elements.spectrumCanvas.getBoundingClientRect();
  const margin = spectrumGeometry(spectrumSurface);
  const plotWidth = rect.width - margin.left - margin.right;
  const relative = Math.max(0, Math.min(plotWidth, event.clientX - rect.left - margin.left));
  state.selectedChannel = Math.max(0, Math.min(PACKET_SIZE - 1, Math.floor(relative / plotWidth * PACKET_SIZE)));
  updateSelectedReadout();
  chartDirty = true;
}

elements.connectButton.addEventListener("click", chooseDevice);
elements.clearButton.addEventListener("click", clearWaterfall);
elements.freezeButton.addEventListener("click", () => {
  state.frozen = !state.frozen;
  elements.freezeButton.setAttribute("aria-pressed", String(state.frozen));
  elements.freezeButton.textContent = state.frozen ? "Resume" : "Freeze";
  if (!state.frozen) chartDirty = true;
});
elements.smoothingInput.addEventListener("input", () => {
  state.spectrumSmoothingRetention = Number(elements.smoothingInput.value) / 100;
  elements.smoothingValue.value = `${elements.smoothingInput.value}%`;
  try { localStorage.setItem("rssi-smoothing", elements.smoothingInput.value); } catch { /* Storage is optional. */ }
});
elements.waterfallSmoothingInput.addEventListener("input", () => {
  state.waterfallSmoothingRetention = Number(elements.waterfallSmoothingInput.value) / 100;
  elements.waterfallSmoothingValue.value = `${elements.waterfallSmoothingInput.value}%`;
  try {
    localStorage.setItem("rssi-waterfall-smoothing", elements.waterfallSmoothingInput.value);
  } catch { /* Storage is optional. */ }
});
elements.gainInput.addEventListener("input", () => {
  state.waterfallGain = Number(elements.gainInput.value) / 100;
  elements.gainValue.value = `${elements.gainInput.value}%`;
  try { localStorage.setItem("rssi-waterfall-gain", elements.gainInput.value); } catch { /* Storage is optional. */ }
  chartDirty = true;
});
elements.waterfallRate.addEventListener("change", () => {
  state.waterfallFps = Number(elements.waterfallRate.value);
  try { localStorage.setItem("rssi-waterfall-fps", elements.waterfallRate.value); } catch { /* Storage is optional. */ }
});
elements.spectrumCanvas.addEventListener("pointerdown", selectSpectrumChannel);
elements.spectrumCanvas.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse") selectSpectrumChannel(event);
});

if ("usb" in navigator) {
  navigator.usb.addEventListener("disconnect", (event) => {
    if (event.device === state.device) {
      disconnectDevice(false);
      showToast("RssiDongle disconnected.");
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.connected && !state.wakeLock) requestWakeLock();
});

try {
  const storedSmoothing = localStorage.getItem("rssi-smoothing");
  const storedWaterfallSmoothing = localStorage.getItem("rssi-waterfall-smoothing");
  const storedWaterfallGain = localStorage.getItem("rssi-waterfall-gain");
  const storedWaterfallFps = localStorage.getItem("rssi-waterfall-fps");
  if (storedSmoothing !== null && Number(storedSmoothing) >= 0 && Number(storedSmoothing) <= 97) {
    elements.smoothingInput.value = storedSmoothing;
    elements.smoothingValue.value = `${storedSmoothing}%`;
    state.spectrumSmoothingRetention = Number(storedSmoothing) / 100;
  }
  if (storedWaterfallSmoothing !== null
      && Number(storedWaterfallSmoothing) >= 0
      && Number(storedWaterfallSmoothing) <= 97) {
    elements.waterfallSmoothingInput.value = storedWaterfallSmoothing;
    elements.waterfallSmoothingValue.value = `${storedWaterfallSmoothing}%`;
    state.waterfallSmoothingRetention = Number(storedWaterfallSmoothing) / 100;
  }
  if (storedWaterfallGain !== null && Number(storedWaterfallGain) >= 0 && Number(storedWaterfallGain) <= 100) {
    elements.gainInput.value = storedWaterfallGain;
    elements.gainValue.value = `${storedWaterfallGain}%`;
    state.waterfallGain = Number(storedWaterfallGain) / 100;
  }
  if (["15", "30", "60"].includes(storedWaterfallFps)) {
    elements.waterfallRate.value = storedWaterfallFps;
    state.waterfallFps = Number(storedWaterfallFps);
  }
} catch {
  // Device-local preferences are optional.
}

if (!("usb" in navigator) && location.protocol === "file:") {
  elements.compatibilityText.textContent = "WebUSB cannot run from a file URL. Serve the Tools folder from localhost, then open this page in Chrome or Edge.";
}

clearWaterfall();
updateSelectedReadout();
setConnectionUi("idle", "Offline");
requestAnimationFrame(animationFrame);
reconnectKnownDevice();
