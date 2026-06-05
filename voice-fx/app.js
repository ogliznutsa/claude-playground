'use strict';

/* ===================================================================
   Voice FX — запись голоса в браузере и наложение эффектов
   на чистом Web Audio API, без зависимостей и сборки.
   =================================================================== */

// ---- Описание эффектов -------------------------------------------------
// playbackRate  — скорость/высота воспроизведения (>1 выше и быстрее)
// tail          — запас секунд для «хвоста» эффекта при экспорте (эхо)
// build(ctx, in) — строит цепочку узлов, возвращает выходной узел
const EFFECTS = {
  none: {
    label: 'Оригинал', emoji: '🎤', playbackRate: 1, tail: 0,
    build: (ctx, input) => input,
  },
  robot: {
    label: 'Робот', emoji: '🤖', playbackRate: 1, tail: 0,
    build: ringModulator,
  },
  beaver: {
    label: 'Бобёр', emoji: '🦫', playbackRate: 1.5, tail: 0,
    build: beaverVoice,
  },
  monster: {
    label: 'Монстр', emoji: '👹', playbackRate: 0.7, tail: 0,
    build: monsterVoice,
  },
  echo: {
    label: 'Эхо', emoji: '🌀', playbackRate: 1, tail: 1.6,
    build: echoEffect,
  },
  radio: {
    label: 'Рация', emoji: '📻', playbackRate: 1, tail: 0.25,
    build: radioEffect,
  },
};

// ---- Состояние ---------------------------------------------------------
let audioCtx = null;          // общий AudioContext (создаётся по жесту пользователя)
let mediaRecorder = null;
let recordedChunks = [];
let recordedBuffer = null;    // декодированная запись (AudioBuffer)
let currentEffect = 'robot';
let activeSource = null;      // текущий играющий источник (чтобы останавливать)
let timerInterval = null;
let recordStartTime = 0;
let waveCache = null;         // оффскрин-канва со статичной осциллограммой
let playRAF = null;           // requestAnimationFrame бегущей полоски
let playStartTime = 0;        // audioCtx.currentTime в момент старта
let playDuration = 0;         // длительность с учётом скорости эффекта

// ---- DOM ---------------------------------------------------------------
const recordBtn   = document.getElementById('recordBtn');
const timerEl     = document.getElementById('timer');
const hintEl      = document.getElementById('hint');
const waveform    = document.getElementById('waveform');
const effectsEl   = document.getElementById('effects');
const effectList  = document.getElementById('effectList');
const controlsEl  = document.getElementById('controls');
const playBtn     = document.getElementById('playBtn');
const stopBtn     = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const errorEl     = document.getElementById('error');

// =======================================================================
//  ЗАПИСЬ
// =======================================================================
recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  hideError();
  try {
    // AudioContext нужно создать/возобновить после жеста пользователя
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    const mimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // Освобождаем микрофон
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'audio/webm' });
      await handleRecorded(blob);
    };

    mediaRecorder.start();
    setRecordingUI(true);
    startTimer();
  } catch (err) {
    console.error(err);
    showError('Не удалось получить доступ к микрофону. Разреши доступ в браузере и попробуй снова.');
    setRecordingUI(false);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  setRecordingUI(false);
  stopTimer();
}

// Декодируем запись в AudioBuffer и показываем интерфейс эффектов
async function handleRecorded(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    recordedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    drawWaveform(recordedBuffer);
    effectsEl.classList.remove('hidden');
    controlsEl.classList.remove('hidden');
    hintEl.textContent = 'Готово! Выбери эффект и нажми «Прослушать».';
  } catch (err) {
    console.error(err);
    showError('Не удалось обработать запись. Попробуй записать ещё раз.');
  }
}

// =======================================================================
//  ВОСПРОИЗВЕДЕНИЕ
// =======================================================================
playBtn.addEventListener('click', () => playWithEffect(currentEffect));
stopBtn.addEventListener('click', stopPlayback);

function playWithEffect(effectKey) {
  if (!recordedBuffer) return;
  stopPlayback();

  const eff = EFFECTS[effectKey];
  const src = audioCtx.createBufferSource();
  src.buffer = recordedBuffer;
  src.playbackRate.value = eff.playbackRate;

  const output = eff.build(audioCtx, src);
  output.connect(audioCtx.destination);

  src.onended = () => {
    stopAux(src);
    if (activeSource === src) {
      activeSource = null;
      stopPlayhead();
    }
  };
  src.start();
  activeSource = src;
  startPlayhead(recordedBuffer.duration / eff.playbackRate);
}

function stopPlayback() {
  if (activeSource) {
    stopAux(activeSource);
    try { activeSource.stop(); } catch (_) {}
    activeSource = null;
  }
  stopPlayhead();
}

// Регистрируем вспомогательные источники (шум, осцилляторы), чтобы
// останавливать их вместе с голосом по кнопке «Стоп» / в конце фразы.
function registerAux(source, node) {
  if (!source._aux) source._aux = [];
  source._aux.push(node);
}
function stopAux(source) {
  if (source && source._aux) {
    source._aux.forEach((n) => { try { n.stop(); } catch (_) {} });
    source._aux = [];
  }
}

// =======================================================================
//  ЭКСПОРТ В WAV (через OfflineAudioContext)
// =======================================================================
downloadBtn.addEventListener('click', async () => {
  if (!recordedBuffer) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = '⏳ Рендер...';
  try {
    const rendered = await renderEffect(currentEffect);
    const wavBlob = audioBufferToWav(rendered);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voice-${currentEffect}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error(err);
    showError('Не удалось сохранить файл.');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = '⬇ Скачать (.wav)';
  }
});

async function renderEffect(effectKey) {
  const eff = EFFECTS[effectKey];
  const sampleRate = recordedBuffer.sampleRate;
  const length = Math.ceil(
    (recordedBuffer.duration / eff.playbackRate + eff.tail) * sampleRate
  );
  const offline = new OfflineAudioContext(
    recordedBuffer.numberOfChannels, length, sampleRate
  );
  const src = offline.createBufferSource();
  src.buffer = recordedBuffer;
  src.playbackRate.value = eff.playbackRate;
  const output = eff.build(offline, src);
  output.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

// =======================================================================
//  ЭФФЕКТЫ (узлы Web Audio)
// =======================================================================

// Робот: кольцевая модуляция (сигнал × несущая ~50 Гц) + лёгкий дисторшн
function ringModulator(ctx, input) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = 50;

  const ring = ctx.createGain();
  ring.gain.value = 0;            // постоянная часть = 0
  carrier.connect(ring.gain);    // несущая (-1..1) модулирует усиление
  input.connect(ring);
  carrier.start();
  registerAux(input, carrier);

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(18);

  ring.connect(shaper);
  return shaper;
}

// Бобёр: высоко и быстро (playbackRate=1.5) + подъём верхов для «писклявости»
function beaverVoice(ctx, input) {
  const presence = ctx.createBiquadFilter();
  presence.type = 'highshelf';
  presence.frequency.value = 2500;
  presence.gain.value = 6;
  input.connect(presence);
  return presence;
}

// Монстр: низко и медленно (playbackRate=0.7) + тёплый низ и небольшой грязный окрас
function monsterVoice(ctx, input) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1800;

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(8);

  input.connect(lp);
  lp.connect(shaper);
  return shaper;
}

// Эхо: задержка с обратной связью, смешанная с сухим сигналом
function echoEffect(ctx, input) {
  const mix = ctx.createGain();        // сумма «сухой + мокрый»
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.25;

  const feedback = ctx.createGain();
  feedback.gain.value = 0.42;

  const wet = ctx.createGain();
  wet.gain.value = 0.6;

  input.connect(mix);                  // сухой
  input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);             // петля обратной связи
  delay.connect(wet);
  wet.connect(mix);
  return mix;
}

// Рация: узкая «телефонная» полоса + гнусавый пик + дисторшн + компрессия +
// фоновая статика. Всё вместе даёт ярко выраженный эффект радиосвязи.
function radioEffect(ctx, input) {
  const mix = ctx.createGain();

  // --- тракт голоса ---
  const pre = ctx.createGain();
  pre.gain.value = 2.5;                  // загоняем сигнал в насыщение

  // крутые срезы снизу и сверху (по два каскада ≈ 24 дБ/окт)
  const hp1 = makeFilter(ctx, 'highpass', 600);
  const hp2 = makeFilter(ctx, 'highpass', 600);
  const lp1 = makeFilter(ctx, 'lowpass', 2600);
  const lp2 = makeFilter(ctx, 'lowpass', 2600);

  // гнусавый «жестяной» резонанс в середине
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 1700;
  peak.Q.value = 1.4;
  peak.gain.value = 9;

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(90);
  shaper.oversample = '4x';

  // компрессор «съедает» динамику — как АРУ в рации
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -28;
  comp.knee.value = 6;
  comp.ratio.value = 14;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;

  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 1.6;            // компенсируем потерю громкости

  input.connect(pre);
  pre.connect(hp1); hp1.connect(hp2); hp2.connect(peak);
  peak.connect(lp1); lp1.connect(lp2);
  lp2.connect(shaper); shaper.connect(comp);
  comp.connect(voiceGain); voiceGain.connect(mix);

  // --- фоновая статика ---
  const noise = createNoiseSource(ctx);
  const noiseBp = ctx.createBiquadFilter();
  noiseBp.type = 'bandpass';
  noiseBp.frequency.value = 1700;
  noiseBp.Q.value = 0.7;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.05;
  noise.connect(noiseBp); noiseBp.connect(noiseGain); noiseGain.connect(mix);

  // статика звучит ровно столько же, сколько длится фраза
  const dur = input.buffer.duration / (input.playbackRate.value || 1);
  noise.start(ctx.currentTime);
  noise.stop(ctx.currentTime + dur + 0.2);
  registerAux(input, noise);

  return mix;
}

// Тужится: низко и медленно (playbackRate=0.6) + «грудной» резонанс +
// густой рык (дисторшн) + медленная дрожь от натуги (LFO ~6 Гц).
function strainVoice(ctx, input) {
  // «грудной» подъём низа — кряхтение из глубины
  const chest = ctx.createBiquadFilter();
  chest.type = 'peaking';
  chest.frequency.value = 220;
  chest.Q.value = 1.0;
  chest.gain.value = 11;

  // зажатый, глухой верх — звук «сдавлен»
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 850;
  lp.Q.value = 4;                      // резонанс даёт напряжённый «горловой» окрас

  // густое насыщение — рык от усилия
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(80);
  shaper.oversample = '4x';

  // дрожь от натуги: медленный неглубокий LFO (усиление колеблется 0.5…1.0)
  const tremolo = ctx.createGain();
  tremolo.gain.value = 0.75;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 6;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.25;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tremolo.gain);
  lfo.start();
  registerAux(input, lfo);

  const out = ctx.createGain();
  out.gain.value = 1.3;

  input.connect(chest);
  chest.connect(lp);
  lp.connect(shaper);
  shaper.connect(tremolo);
  tremolo.connect(out);
  return out;
}

// Biquad-фильтр одной строкой
function makeFilter(ctx, type, freq) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  return f;
}

// Источник белого шума (2-секундный буфер, проигрываемый по кругу)
function createNoiseSource(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

// Кривая мягкого искажения (классическая формула)
function makeDistortionCurve(amount) {
  const k = amount;
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// =======================================================================
//  ИНТЕРФЕЙС
// =======================================================================
function buildEffectButtons() {
  Object.entries(EFFECTS).forEach(([key, eff]) => {
    const card = document.createElement('button');
    card.className = 'effect-card' + (key === currentEffect ? ' active' : '');
    card.dataset.key = key;
    card.innerHTML =
      `<span class="effect-card__emoji">${eff.emoji}</span>` +
      `<span class="effect-card__name">${eff.label}</span>`;
    card.addEventListener('click', () => {
      currentEffect = key;
      document.querySelectorAll('.effect-card').forEach((c) =>
        c.classList.toggle('active', c.dataset.key === key)
      );
      // сразу проигрываем с выбранным эффектом для предпрослушки
      playWithEffect(key);
    });
    effectList.appendChild(card);
  });
}

function setRecordingUI(isRecording) {
  recordBtn.classList.toggle('recording', isRecording);
  if (isRecording) {
    hintEl.textContent = 'Идёт запись... Нажми, чтобы остановить.';
    effectsEl.classList.add('hidden');
    controlsEl.classList.add('hidden');
    stopPlayback();
  }
}

function startTimer() {
  recordStartTime = performance.now();
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    const sec = Math.floor((performance.now() - recordStartTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// Рисуем осциллограмму записанного буфера в оффскрин-кэш (один раз),
// чтобы потом дёшево перерисовывать её под бегущей полоской каждый кадр.
function drawWaveform(buffer) {
  const W = waveform.width;
  const H = waveform.height;

  waveCache = document.createElement('canvas');
  waveCache.width = W;
  waveCache.height = H;
  const ctx = waveCache.getContext('2d');

  const data = buffer.getChannelData(0);
  const step = Math.floor(data.length / W) || 1;
  const mid = H / 2;

  ctx.fillStyle = '#1f242d';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#6c8cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let x = 0; x < W; x++) {
    let min = 1.0, max = -1.0;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x + 0.5, mid + min * mid * 0.95);
    ctx.lineTo(x + 0.5, mid + max * mid * 0.95);
  }
  ctx.stroke();

  renderWaveformFrame(null);   // показать статичную осциллограмму
}

// Перерисовывает осциллограмму + бегущую полоску. progress: 0..1 или null.
function renderWaveformFrame(progress) {
  const ctx = waveform.getContext('2d');
  const W = waveform.width;
  const H = waveform.height;
  ctx.clearRect(0, 0, W, H);
  if (waveCache) ctx.drawImage(waveCache, 0, 0);
  if (progress == null) return;

  const x = Math.max(0, Math.min(1, progress)) * W;
  // затемняем уже проигранную часть
  ctx.fillStyle = 'rgba(108, 140, 255, 0.16)';
  ctx.fillRect(0, 0, x, H);
  // сама полоска
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, H);
  ctx.stroke();
}

// Запускает анимацию полоски на время воспроизведения
function startPlayhead(durationSec) {
  playStartTime = audioCtx.currentTime;
  playDuration = durationSec;
  const tick = () => {
    const elapsed = audioCtx.currentTime - playStartTime;
    const progress = playDuration > 0 ? elapsed / playDuration : 1;
    renderWaveformFrame(Math.min(progress, 1));
    if (progress < 1 && activeSource) {
      playRAF = requestAnimationFrame(tick);
    } else {
      playRAF = null;
    }
  };
  tick();
}

// Останавливает анимацию и возвращает статичную осциллограмму
function stopPlayhead() {
  if (playRAF) cancelAnimationFrame(playRAF);
  playRAF = null;
  renderWaveformFrame(null);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}
function hideError() {
  errorEl.classList.add('hidden');
}

// Выбираем поддерживаемый браузером формат записи
function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// =======================================================================
//  WAV-энкодер (16-бит PCM)
// =======================================================================
function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;

  // Собираем каналы
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  const frameCount = buffer.length;

  const dataLength = frameCount * blockAlign;
  const bufferLength = 44 + dataLength;
  const ab = new ArrayBuffer(bufferLength);
  const view = new DataView(ab);

  let offset = 0;
  const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };

  writeStr('RIFF');
  view.setUint32(offset, 36 + dataLength, true); offset += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(offset, 16, true); offset += 4;          // размер fmt
  view.setUint16(offset, 1, true); offset += 2;           // PCM
  view.setUint16(offset, numCh, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4; // byte rate
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bitDepth, true); offset += 2;
  writeStr('data');
  view.setUint32(offset, dataLength, true); offset += 4;

  // Перемежаем сэмплы и переводим в 16-бит
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numCh; c++) {
      let sample = Math.max(-1, Math.min(1, channels[c][i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: 'audio/wav' });
}

// ---- старт -------------------------------------------------------------
buildEffectButtons();
