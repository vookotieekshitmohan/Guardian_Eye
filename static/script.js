// DOM Element Bindings
const video = document.getElementById('webcam');
const earDisplay = document.getElementById('ear-display');
const stateDisplay = document.getElementById('state-display');
const poseDisplay = document.getElementById('pose-display');
const alertCounterDisplay = document.getElementById('alert-counter');
const warningBanner = document.getElementById('warning-banner');
const warningText = document.getElementById('warning-text');
const btnToggle = document.getElementById('btn-toggle');
const btnClear = document.getElementById('btn-clear');
const badgeStatus = document.getElementById('badge-status');
const logList = document.getElementById('log-list');

// Cockpit HUD Specific Elements (handles gauge bars if present)
const speedDisplay = document.getElementById('speed-display');
const speedProgress = document.getElementById('speed-progress');
const earFill = document.getElementById('ear-fill');
const stateSub = document.getElementById('state-sub');

// Landmark configurations (MediaPipe Face Mesh)
const LEFT_EYE = [362, 385, 387, 263, 373, 380];
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const FOREHEAD = 10;
const NOSE_TIP = 1;
const CHIN = 152;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

// Operational Thresholds
const EAR_THRESHOLD = 0.22;
const DROWSY_FRAMES = 22;

// Runtime State Variables
let closedFrames = 0;
let headBowedStartTime = null;
let lastKnownPosture = "Center";
let lastSeenFaceTime = 0;
let totalAlerts = 0;
let isMonitoring = false;
let cameraInstance = null;
let audioCtx = null;
let alarmInterval = null;
let currentAlarmType = null;
let sirenToggle = false;

// GPS Speed State
let currentSpeedKmh = 0;
let geoWatchId = null;

// Euclidean distance calculation
function dist(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Eye Aspect Ratio (EAR)
function calculateEAR(landmarks, indices) {
  const p1 = landmarks[indices[0]];
  const p2 = landmarks[indices[1]];
  const p3 = landmarks[indices[2]];
  const p4 = landmarks[indices[3]];
  const p5 = landmarks[indices[4]];
  const p6 = landmarks[indices[5]];

  const vertical = dist(p2, p6) + dist(p3, p5);
  const horizontal = 2.0 * dist(p1, p4);
  return vertical / horizontal;
}

// Head Pose & Bow Detection
function checkHeadPosture(landmarks) {
  const forehead = landmarks[FOREHEAD];
  const nose = landmarks[NOSE_TIP];
  const chin = landmarks[CHIN];
  const leftCheek = landmarks[LEFT_CHEEK];
  const rightCheek = landmarks[RIGHT_CHEEK];

  const faceWidth = dist(leftCheek, rightCheek);
  const faceHeight = dist(forehead, chin);

  const noseToChinRatio = (chin.y - nose.y) / faceHeight;
  const noseToLeftRatio = Math.abs(nose.x - leftCheek.x) / faceWidth;

  // Tolerant pitch down detection threshold
  if (noseToChinRatio < 0.33 || (faceHeight / faceWidth) < 1.15 || nose.y > 0.65) {
    return "Head Bowed Down";
  }
  if (noseToLeftRatio < 0.28) return "Looking Left";
  if (noseToLeftRatio > 0.72) return "Looking Right";

  return "Center";
}

// Sound 1: High-pitched sawtooth chirp for Drowsiness
function playDrowsyTone() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sawtooth";
  osc.frequency.value = 950;
  gain.gain.setValueAtTime(0.28, audioCtx.currentTime);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.15);

  if (navigator.vibrate) navigator.vibrate([150, 50, 150]);
}

// Sound 2: Alternating dual-frequency heavy square siren for Head Bowed Down
function playBowedTone() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  sirenToggle = !sirenToggle;
  osc.type = "square";
  osc.frequency.value = sirenToggle ? 420 : 560;
  gain.gain.setValueAtTime(0.35, audioCtx.currentTime);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.22);

  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
}

function startSound(type) {
  if (currentAlarmType === type && alarmInterval) return;
  stopSound();

  currentAlarmType = type;
  if (type === "HEAD_BOWED") {
    playBowedTone();
    alarmInterval = setInterval(playBowedTone, 240);
  } else if (type === "DROWSINESS") {
    playDrowsyTone();
    alarmInterval = setInterval(playDrowsyTone, 260);
  }
}

function stopSound() {
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  currentAlarmType = null;
}

// Logging to backend API
function recordAlert(type, detail) {
  totalAlerts++;
  if (alertCounterDisplay) alertCounterDisplay.innerText = totalAlerts;

  fetch('/api/alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: type, detail: detail })
  })
    .then(res => res.json())
    .then(data => {
      if (data.record) appendLogItem(data.record);
    })
    .catch(() => {});
}

function appendLogItem(record) {
  if (!logList) return;
  const empty = logList.querySelector('.empty-log');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'log-item';
  li.innerHTML = `
    <span class="log-type">${record.type}</span>
    <span class="log-time">${record.timestamp}</span>
  `;
  logList.prepend(li);
}

// Face landmark inference callback
function handleLandmarks(results) {
  const now = Date.now();

  // Face disappearance & occlusion handling
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    // If lost while bowing down, keep accumulating bowed time up to 4.5 seconds
    if (lastKnownPosture === "Head Bowed Down" && (now - lastSeenFaceTime) < 4500) {
      if (poseDisplay) poseDisplay.innerText = "Head Bowed (Obscured)";
      if (stateDisplay) stateDisplay.innerText = "Tracking Down...";
      
      const elapsed = (now - headBowedStartTime) / 1000;
      if (elapsed >= 3.0) {
        triggerWarning("HEAD BOWED DOWN (>3s)! LOOK UP!", "HEAD_BOWED");
      }
      return;
    }

    if (stateDisplay) {
      stateDisplay.innerText = "No Face Found";
      stateDisplay.className = "metric-value status-warn";
    }
    if (poseDisplay) poseDisplay.innerText = "--";
    if (stateSub) stateSub.innerText = "SCANNING FIELD OF VIEW";
    headBowedStartTime = null;
    clearWarning();
    return;
  }

  // Active tracking
  lastSeenFaceTime = now;
  const landmarks = results.multiFaceLandmarks[0];
  const leftEAR = calculateEAR(landmarks, LEFT_EYE);
  const rightEAR = calculateEAR(landmarks, RIGHT_EYE);
  const avgEAR = (leftEAR + rightEAR) / 2.0;
  const posture = checkHeadPosture(landmarks);

  lastKnownPosture = posture;

  if (earDisplay) earDisplay.innerText = avgEAR.toFixed(2);
  if (poseDisplay) poseDisplay.innerText = posture;

  // Update EAR gauge fill bar if in HUD layout
  if (earFill) {
    const earPercent = Math.min(Math.max((avgEAR / 0.40) * 100, 0), 100);
    earFill.style.width = `${earPercent}%`;
  }

  // Drowsiness evaluation
  if (avgEAR < EAR_THRESHOLD) {
    closedFrames++;
  } else {
    closedFrames = 0;
  }

  // 3-second Bow Down timing
  let bowedMoreThan3Sec = false;
  if (posture === "Head Bowed Down") {
    if (!headBowedStartTime) {
      headBowedStartTime = now;
    } else {
      const elapsed = (now - headBowedStartTime) / 1000;
      if (elapsed >= 3.0) {
        bowedMoreThan3Sec = true;
      }
    }
  } else {
    headBowedStartTime = null;
  }

  // Warning trigger checks
  if (bowedMoreThan3Sec) {
    triggerWarning("HEAD BOWED DOWN (>3s)! LOOK UP!", "HEAD_BOWED");
  } else if (closedFrames >= DROWSY_FRAMES) {
    triggerWarning("DROWSINESS DETECTED! WAKE UP!", "DROWSINESS");
  } else {
    clearWarning();
  }
}

function triggerWarning(message, type) {
  if (warningBanner) warningBanner.classList.remove('hidden');
  if (warningText) warningText.innerText = message;
  
  if (stateDisplay) {
    stateDisplay.innerText = type === "HEAD_BOWED" ? "HEAD DOWN!" : "DROWSY!";
    stateDisplay.className = "metric-value status-danger";
  }
  if (stateSub) stateSub.innerText = "SAFETY SYSTEM ENGAGED";

  if (currentAlarmType !== type) {
    startSound(type);
    recordAlert(type, message);
  }
}

function clearWarning() {
  if (warningBanner) warningBanner.classList.add('hidden');
  if (stateDisplay) {
    stateDisplay.innerText = "Attentive";
    stateDisplay.className = "metric-value status-good";
  }
  if (stateSub) stateSub.innerText = "SYSTEM OPTIMAL";
  stopSound();
}

// GPS Speed Tracking via Geolocation API
function startSpeedTracking() {
  if ("geolocation" in navigator) {
    geoWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const speedMps = position.coords.speed;
        if (speedMps !== null && !isNaN(speedMps) && speedMps > 0) {
          currentSpeedKmh = Math.round(speedMps * 3.6);
        } else {
          currentSpeedKmh = 0;
        }

        if (speedDisplay) {
          // If in HUD format with separate unit span, update numeric only
          speedDisplay.innerText = currentSpeedKmh;
        }
        if (speedProgress) {
          const speedPercent = Math.min((currentSpeedKmh / 120) * 100, 100);
          speedProgress.style.width = `${speedPercent}%`;
        }
      },
      () => {
        if (speedDisplay) speedDisplay.innerText = "0";
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 5000
      }
    );
  } else if (speedDisplay) {
    speedDisplay.innerText = "0";
  }
}

function stopSpeedTracking() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
    currentSpeedKmh = 0;
    if (speedDisplay) speedDisplay.innerText = "0";
    if (speedProgress) speedProgress.style.width = "0%";
  }
}

// Initialize MediaPipe FaceMesh
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.3,
  minTrackingConfidence: 0.3
});

faceMesh.onResults(handleLandmarks);

// Toggle Monitoring Control
btnToggle.addEventListener('click', async () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  if (!isMonitoring) {
    cameraInstance = new Camera(video, {
      onFrame: async () => {
        await faceMesh.send({ image: video });
      },
      width: 640,
      height: 480
    });
    await cameraInstance.start();
    startSpeedTracking();

    const btnTextSpan = btnToggle.querySelector('.btn-text');
    if (btnTextSpan) {
      btnTextSpan.innerText = "DISENGAGE MONITOR";
    } else {
      btnToggle.innerText = "Stop Monitor";
    }

    if (badgeStatus) {
      badgeStatus.innerText = "ONLINE";
      badgeStatus.className = "hud-pill pill-active";
    }
    isMonitoring = true;
  } else {
    await cameraInstance.stop();
    stopSpeedTracking();
    clearWarning();
    headBowedStartTime = null;
    lastKnownPosture = "Center";

    const btnTextSpan = btnToggle.querySelector('.btn-text');
    if (btnTextSpan) {
      btnTextSpan.innerText = "INITIALIZE SYSTEM";
    } else {
      btnToggle.innerText = "Activate Monitor";
    }

    if (badgeStatus) {
      badgeStatus.innerText = "STANDBY";
      badgeStatus.className = "hud-pill pill-standby";
    }
    isMonitoring = false;
  }
});

// Clear incident logs
btnClear.addEventListener('click', () => {
  fetch('/api/clear', { method: 'POST' }).then(() => {
    if (logList) logList.innerHTML = '<li class="empty-log">Telemetry stream waiting for initialization...</li>';
    totalAlerts = 0;
    if (alertCounterDisplay) alertCounterDisplay.innerText = "0";
  });
});