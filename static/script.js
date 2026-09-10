// DOM Element Bindings
const video = document.getElementById('webcam');
const earDisplay = document.getElementById('ear-display');
const earBar = document.getElementById('earBar');
const stateDisplay = document.getElementById('state-display');
const poseDisplay = document.getElementById('pose-display');
const speedDisplay = document.getElementById('speed-display');
const speedBar = document.getElementById('speedBar');
const alertCounterDisplay = document.getElementById('alert-counter');

// Header and Status Badges
const badgeStatus = document.getElementById('badge-status');
const statusAlert = document.getElementById('statusAlert');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const confidenceText = document.getElementById('confidenceText');
const predictionBadge = document.getElementById('predictionBadge');

// Threat Detection Panels
const alertPanel = document.getElementById('alertPanel');
const warningText = document.getElementById('warning-text');
const warningSub = document.getElementById('warning-sub');
const alertSpeed = document.getElementById('alertSpeed');
const alertEAR = document.getElementById('alertEAR');
const alertPose = document.getElementById('alertPose');
const alertDiagnostic = document.getElementById('alertDiagnostic');

// Controls & Logs
const btnToggle = document.getElementById('btn-toggle');
const btnClear = document.getElementById('btn-clear');
const eventCount = document.getElementById('eventCount');
const logList = document.getElementById('log-list');
const emptyLog = document.getElementById('emptyLog');
const gpsStatusText = document.getElementById('gps-status-text');

// MediaPipe Landmark Index Configurations
const LEFT_EYE = [362, 385, 387, 263, 373, 380];
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const FOREHEAD = 10;
const NOSE_TIP = 1;
const CHIN = 152;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

const EAR_THRESHOLD = 0.22;
const DROWSY_FRAMES = 22;

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

// Speed tracking state
let currentSpeedKmh = 0;
let geoWatchId = null;

function dist(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

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

    if (noseToChinRatio < 0.33 || (faceHeight / faceWidth) < 1.15 || nose.y > 0.65) {
        return "Head Bowed Down";
    }
    if (noseToLeftRatio < 0.28) return "Looking Left";
    if (noseToLeftRatio > 0.72) return "Looking Right";

    return "Center";
}

// Audio Alerts (Web Audio API)
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

function recordAlert(type, detail) {
    totalAlerts++;
    if (alertCounterDisplay) alertCounterDisplay.innerText = totalAlerts;
    if (eventCount) eventCount.innerText = totalAlerts;

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
    if (emptyLog) emptyLog.style.display = 'none';

    const li = document.createElement('li');
    li.className = 'event';
    li.innerHTML = `
        <div class="event-icon">⚠️</div>
        <div class="event-info">
            <strong>${record.type}</strong>
            <span>${record.timestamp} • Speed: ${currentSpeedKmh} km/h</span>
        </div>
        <div class="event-confidence">CRITICAL</div>
    `;
    logList.prepend(li);
}

// GPS Speed Watcher
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

                if (speedDisplay) speedDisplay.innerText = currentSpeedKmh;
                if (speedBar) {
                    const speedPct = Math.min((currentSpeedKmh / 120) * 100, 100);
                    speedBar.style.width = `${speedPct}%`;
                }
                if (gpsStatusText) gpsStatusText.innerText = "ONLINE";
            },
            () => {
                if (speedDisplay) speedDisplay.innerText = "0";
                if (gpsStatusText) gpsStatusText.innerText = "STANDBY";
            },
            {
                enableHighAccuracy: true,
                maximumAge: 1000,
                timeout: 5000
            }
        );
    }
}

function stopSpeedTracking() {
    if (geoWatchId !== null) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
        currentSpeedKmh = 0;
        if (speedDisplay) speedDisplay.innerText = "0";
        if (speedBar) speedBar.style.width = "0%";
        if (gpsStatusText) gpsStatusText.innerText = "STANDBY";
    }
}

// Landmark Inference Loop
function handleLandmarks(results) {
    const now = Date.now();

    // Occlusion persistence: If head pitched down and landmarks drop, retain tracking up to 4.5s
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
        if (lastKnownPosture === "Head Bowed Down" && (now - lastSeenFaceTime) < 4500) {
            poseDisplay.innerText = "Bowed (Obscured)";
            stateDisplay.innerText = "Tracking Down";
            stateDisplay.className = "metric-value metric-text status-warn";

            const elapsed = (now - headBowedStartTime) / 1000;
            if (elapsed >= 3.0) {
                triggerWarning("HEAD BOWED DOWN (>3s)! LOOK UP!", "HEAD_BOWED");
            }
            return;
        }

        stateDisplay.innerText = "No Face Found";
        stateDisplay.className = "metric-value metric-text status-warn";
        poseDisplay.innerText = "--";
        headBowedStartTime = null;
        clearWarning();
        return;
    }

    // Active Face Tracking
    lastSeenFaceTime = now;
    const landmarks = results.multiFaceLandmarks[0];
    const leftEAR = calculateEAR(landmarks, LEFT_EYE);
    const rightEAR = calculateEAR(landmarks, RIGHT_EYE);
    const avgEAR = (leftEAR + rightEAR) / 2.0;
    const posture = checkHeadPosture(landmarks);

    lastKnownPosture = posture;

    if (earDisplay) earDisplay.innerText = avgEAR.toFixed(2);
    if (earBar) {
        const earPct = Math.min(Math.max((avgEAR / 0.40) * 100, 0), 100);
        earBar.style.width = `${earPct}%`;
    }
    if (poseDisplay) poseDisplay.innerText = posture;

    // Drowsiness frames accumulation
    if (avgEAR < EAR_THRESHOLD) {
        closedFrames++;
    } else {
        closedFrames = 0;
    }

    // Head Bow 3-second timing
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

    // Trigger Evaluation
    if (bowedMoreThan3Sec) {
        triggerWarning("HEAD BOWED DOWN (>3s)! LOOK UP!", "HEAD_BOWED");
    } else if (closedFrames >= DROWSY_FRAMES) {
        triggerWarning("DROWSINESS DETECTED! WAKE UP!", "DROWSINESS");
    } else {
        clearWarning();
    }
}

function triggerWarning(message, type) {
    statusAlert.className = "status anomaly";
    statusIcon.innerText = "🚨";
    statusText.innerText = message;
    confidenceText.innerText = `Intervention Dispatched • Speed: ${currentSpeedKmh} km/h`;

    predictionBadge.className = "prediction anomaly";
    predictionBadge.innerText = "🚨 ANOMALY DETECTED";

    stateDisplay.innerText = type === "HEAD_BOWED" ? "HEAD DOWN!" : "DROWSY!";
    stateDisplay.className = "metric-value metric-text status-danger";

    alertPanel.classList.remove('hidden');
    warningText.innerText = message;
    warningSub.innerText = type === "HEAD_BOWED" ? "Head bowed below safe sightline" : "Extended eye closure detected";
    alertSpeed.innerText = `${currentSpeedKmh} km/h`;
    alertEAR.innerText = earDisplay.innerText;
    alertPose.innerText = poseDisplay.innerText;
    alertDiagnostic.innerText = type === "HEAD_BOWED"
        ? "Driver head tilted downward for > 3 continuous seconds. Road visibility compromised."
        : "Driver eyelid closure exceeded safe reaction threshold. Immediate alert active.";

    if (currentAlarmType !== type) {
        startSound(type);
        recordAlert(type, message);
    }
}

function clearWarning() {
    statusAlert.className = "status normal";
    statusIcon.innerText = "🟢";
    statusText.innerText = "DRIVER ATTENTIVE & ROAD FOCUSED";
    confidenceText.innerText = `Head Pose: ${lastKnownPosture} • Live Speed: ${currentSpeedKmh} km/h`;

    predictionBadge.className = "prediction normal";
    predictionBadge.innerText = "🟢 OPTIMAL";

    stateDisplay.innerText = "Attentive";
    stateDisplay.className = "metric-value metric-text status-good";

    alertPanel.classList.add('hidden');
    stopSound();
}

// MediaPipe Setup
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

// Toggle Start / Stop
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

        btnToggle.innerText = "STOP MONITORING";
        btnToggle.style.background = "#7f1d1d";
        badgeStatus.innerText = "LIVE MONITORING";
        isMonitoring = true;
    } else {
        await cameraInstance.stop();
        stopSpeedTracking();
        clearWarning();
        headBowedStartTime = null;
        lastKnownPosture = "Center";

        btnToggle.innerText = "START MONITORING";
        btnToggle.style.background = "";
        badgeStatus.innerText = "STANDBY";
        isMonitoring = false;
    }
});

// Clear incident logs
btnClear.addEventListener('click', () => {
    fetch('/api/clear', { method: 'POST' }).then(() => {
        logList.innerHTML = '';
        if (emptyLog) emptyLog.style.display = 'block';
        totalAlerts = 0;
        alertCounterDisplay.innerText = "0";
        eventCount.innerText = "0";
    });
});