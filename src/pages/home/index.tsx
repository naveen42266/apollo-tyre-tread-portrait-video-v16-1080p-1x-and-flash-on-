import { useState, useRef, useEffect } from 'react';
import InstructionImg from "../../assets/instruction_img.jpeg";

// ─── UTILITY: DETECT IOS / IPHONE ─────────────────────────────────────────────
const isIOSDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
};

// ─── MEDIA RECORDER HELPERS ──────────────────────────────────────────────────
const getSupportedRecorderMimeType = (): string => {
  const candidates = [
    'video/mp4;codecs=avc1.4d002a',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm',
  ];

  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
};

/**
 * Injects duration metadata into a WebM Blob so Android/Samsung Gallery
 * and native media players can determine duration and play/seek without errors.
 */
async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (durationMs <= 0) return blob;
  try {
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < bytes.length - 12; i++) {
      if (
        bytes[i] === 0x15 &&
        bytes[i + 1] === 0x49 &&
        bytes[i + 2] === 0xa9 &&
        bytes[i + 3] === 0x66
      ) {
        const limit = Math.min(i + 250, bytes.length - 8);
        for (let j = i + 4; j < limit; j++) {
          if (bytes[j] === 0x44 && bytes[j + 1] === 0x89) {
            const lengthByte = bytes[j + 2];
            if (lengthByte === 0x84 && j + 7 <= bytes.length) {
              view.setFloat32(j + 3, durationMs, false);
              return new Blob([buffer], { type: blob.type });
            }
            if (lengthByte === 0x88 && j + 11 <= bytes.length) {
              view.setFloat64(j + 3, durationMs, false);
              return new Blob([buffer], { type: blob.type });
            }
          }
        }
        break;
      }
    }
  } catch (err) {
    console.warn('WebM duration metadata patch skipped:', err);
  }
  return blob;
}

// ─── 1X BACK CAMERA DETECTION & STREAM ACQUISITION ───────────────────────────
/**
 * Finds the true primary 1x back camera among available video devices,
 * filtering out ultra-wide (0.5x), telephoto (2x/3x/5x), front, and virtual lenses.
 */
function pick1xBackCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | null {
  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  if (videoDevices.length === 0) return null;

  // Filter out front/selfie cameras
  const backDevices = videoDevices.filter(d => {
    const label = d.label.toLowerCase();
    return !label.includes('front') && !label.includes('user') && !label.includes('selfie') && !label.includes('face');
  });

  const pool = backDevices.length > 0 ? backDevices : videoDevices;

  // Filter out ultra-wide (0.5x), telephoto (2x/3x/5x), depth, macro, and virtual cameras
  const standard1xList = pool.filter(d => {
    const label = d.label.toLowerCase();
    const isUltra = label.includes('ultra') || label.includes('0.5') || label.includes('0.6');
    const isTele = label.includes('tele') || label.includes('zoom') || label.includes('2x') || label.includes('3x') || label.includes('5x') || label.includes('10x');
    const isMacroOrSpecial = label.includes('macro') || label.includes('depth') || label.includes('tof') || label.includes('virtual');
    return !isUltra && !isTele && !isMacroOrSpecial;
  });

  if (standard1xList.length > 0) {
    // Prefer standard primary indicators: "Back Camera" on iOS, "camera2 0" on Android
    const primary = standard1xList.find(d => {
      const label = d.label.toLowerCase();
      return (
        label === 'back camera' ||
        label === 'camera 0' ||
        label.includes('camera2 0') ||
        label.includes('main') ||
        label.includes('wide-angle camera')
      );
    });
    return primary || standard1xList[0];
  }

  return pool[0] || null;
}

/**
 * Acquires a 1080p portrait stream strictly locked to the 1x back camera,
 * with zoom explicitly locked to 1.0 (no 0.5x ultra-wide or 2x telephoto).
 */
async function acquire1xBackCameraStream(): Promise<MediaStream> {
  // Step 1: Enumerate devices to check if 1x back camera can be identified by deviceId
  let targetDeviceId: string | undefined = undefined;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const bestCamera = pick1xBackCamera(devices);
    if (bestCamera && bestCamera.deviceId && bestCamera.label) {
      targetDeviceId = bestCamera.deviceId;
    }
  } catch { }

  // Step 2: Request 1080p portrait back camera stream
  const constraintsList: MediaStreamConstraints[] = [
    {
      video: {
        ...(targetDeviceId ? { deviceId: { exact: targetDeviceId } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        aspectRatio: { ideal: 9 / 16 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    },
  ];

  let stream: MediaStream | null = null;
  let lastError: unknown = null;

  for (const c of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      if (stream && stream.getVideoTracks().length > 0) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!stream) {
    throw lastError || new Error('Failed to acquire 1x back camera stream');
  }

  // Step 3: Now that permission is granted, re-check labels if we didn't have deviceId earlier.
  // If the browser selected an ultra-wide (0.5x) or telephoto (2x), switch to the true 1x back camera.
  if (!targetDeviceId) {
    try {
      const currentTrack = stream.getVideoTracks()[0];
      const currentLabel = (currentTrack.label || '').toLowerCase();
      const isWrongLens =
        currentLabel.includes('ultra') ||
        currentLabel.includes('0.5') ||
        currentLabel.includes('0.6') ||
        currentLabel.includes('tele') ||
        currentLabel.includes('zoom');

      if (isWrongLens) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const best1x = pick1xBackCamera(devices);
        if (best1x && best1x.deviceId && best1x.deviceId !== currentTrack.getSettings().deviceId) {
          stream.getTracks().forEach(t => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: best1x.deviceId },
              width: { ideal: 1080 },
              height: { ideal: 1920 },
              aspectRatio: { ideal: 9 / 16 },
            },
            audio: false,
          });
        }
      }
    } catch (switchErr) {
      console.warn('1x lens verification skipped:', switchErr);
    }
  }

  // Step 4: Lock zoom to 1x (no digital/optical zoom offset)
  const track = stream.getVideoTracks()[0];
  if (track) {
    try {
      const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as any;
      if (caps.zoom) {
        const minZ = typeof caps.zoom.min === 'number' ? caps.zoom.min : 1;
        const maxZ = typeof caps.zoom.max === 'number' ? caps.zoom.max : 1;
        const targetZoom = Math.min(Math.max(1, minZ), maxZ);
        await track.applyConstraints({
          advanced: [{ zoom: targetZoom } as any],
        });
      }
    } catch (zoomErr) {
      console.warn('Zoom lock to 1x skipped:', zoomErr);
    }
  }

  return stream;
}

// ─── CAMERA CAPTURE COMPONENT (LOCKED 1X, 1080P PORTRAIT, FLASH ON) ───────────
interface CameraCaptureProps {
  onCapture: (videoUrl: string, mimeType: string) => void;
  onClose: () => void;
}

const CameraCapture: React.FC<CameraCaptureProps> = ({ onClose, onCapture }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>('');
  const recordingDurationRef = useRef<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRafRef = useRef<number | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);

  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [scanPct, setScanPct] = useState(0);
  const [flashSupported, setFlashSupported] = useState(false);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [showEndFrame, setShowEndFrame] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const durationIntervalRef = useRef<number | null>(null);

  // Turn flash / torch ON or OFF
  const setFlashState = async (enable: boolean) => {
    const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: enable } as any],
      });
      setIsFlashOn(enable);
    } catch (err) {
      console.warn('Failed to set flash/torch state:', err);
    }
  };

  const toggleFlash = async () => {
    if (!flashSupported) return;
    await setFlashState(!isFlashOn);
  };

  // Scanning animation while recording
  useEffect(() => {
    if (!isRecording) { setScanPct(0); return; }
    let x = 0;
    let dir = 1;
    const id = setInterval(() => {
      x += dir * 2.2;
      if (x >= 100) dir = -1;
      if (x <= 0) dir = 1;
      setScanPct(x);
    }, 16);
    return () => clearInterval(id);
  }, [isRecording]);

  // Show END frame marker after 2s of recording
  useEffect(() => {
    if (isRecording && recordingDuration >= 2) setShowEndFrame(true);
    else if (!isRecording) setShowEndFrame(false);
  }, [recordingDuration, isRecording]);

  // Camera initialization: Lock to 1x back camera & turn flash ON
  useEffect(() => {
    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await acquire1xBackCameraStream();

        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        // Check torch / flash support
        const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as any;
        const hasTorch = Boolean(caps.torch === true || (caps && 'torch' in caps));
        setFlashSupported(hasTorch);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = async () => {
            if (cancelled) return;
            setIsCameraReady(true);

            // Automatically turn flash ON
            if (hasTorch) {
              await setFlashState(true);
            }
          };
        }
      } catch (error) {
        console.error('Camera initialization failed:', error);
        alert('Camera access denied or unavailable. Please check permissions.');
        onClose();
      }
    };

    void startCamera();

    return () => {
      cancelled = true;

      // Turn flash OFF before exiting
      if (trackRef.current) {
        try {
          void trackRef.current.applyConstraints({
            advanced: [{ torch: false } as any],
          });
        } catch { }
      }

      if (recorderRef.current && recorderRef.current.state === 'recording') {
        try { recorderRef.current.stop(); } catch { }
      }

      if (canvasRafRef.current) {
        cancelAnimationFrame(canvasRafRef.current);
        canvasRafRef.current = null;
      }
      canvasStreamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current?.getTracks().forEach(track => track.stop());

      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    };
  }, [onClose]);

  // 1080p Portrait Recording (Direct stream or 1080x1920 canvas)
  const start1080pRecording = () => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings() || {};
    const mimeType = getSupportedRecorderMimeType();

    // If native stream is already portrait (height >= width), record directly at 1080p
    const isDirectPortrait =
      (settings.height && settings.width && settings.height >= settings.width) ||
      (video.videoHeight && video.videoWidth && video.videoHeight >= video.videoWidth);

    if (isDirectPortrait && !isIOSDevice()) {
      let recorder: MediaRecorder | null = null;
      try {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      } catch {
        try {
          recorder = new MediaRecorder(stream);
        } catch (err) {
          console.error('Direct MediaRecorder creation failed:', err);
        }
      }

      if (recorder) {
        setupMediaRecorder(recorder, mimeType);
        return;
      }
    }

    // For landscape streams or iOS AVFoundation feeds:
    // Render onto an exact 1080x1920 canvas to guarantee pure 1080p portrait video output
    const targetW = 1080;
    const targetH = 1920;

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    canvasRef.current = canvas;

    const paintFrame = () => {
      const vw = video.videoWidth || 1920;
      const vh = video.videoHeight || 1080;

      if (vw && vh) {
        // Crop center 9:16 portrait portion from the feed
        const targetAspect = 9 / 16;
        const currentAspect = vw / vh;
        let sx = 0, sy = 0, sw = vw, sh = vh;

        if (currentAspect > targetAspect) {
          sw = vh * targetAspect;
          sx = (vw - sw) / 2;
        } else {
          sh = vw / targetAspect;
          sy = (vh - sh) / 2;
        }

        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
      }
    };

    paintFrame();

    const drawLoop = () => {
      paintFrame();
      canvasRafRef.current = requestAnimationFrame(drawLoop);
    };
    canvasRafRef.current = requestAnimationFrame(drawLoop);

    const fps = 30;
    const canvasStream = canvas.captureStream(fps);
    canvasStreamRef.current = canvasStream;

    let canvasRecorder: MediaRecorder | null = null;
    try {
      canvasRecorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 5_000_000 });
    } catch {
      try {
        canvasRecorder = new MediaRecorder(canvasStream);
      } catch (err) {
        console.error('Canvas MediaRecorder creation failed:', err);
        if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current);
        alert('Unable to record video on this device.');
        setIsProcessing(false);
        return;
      }
    }

    setupMediaRecorder(canvasRecorder, mimeType);
  };

  const setupMediaRecorder = (recorder: MediaRecorder, preferredMimeType: string) => {
    recorderChunksRef.current = [];
    mimeTypeRef.current = recorder.mimeType || preferredMimeType || 'video/mp4';
    recorderRef.current = recorder;
    recordingDurationRef.current = 0;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        recorderChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      console.error('MediaRecorder error:', event);
    };

    recorder.onstop = async () => {
      if (canvasRafRef.current) {
        cancelAnimationFrame(canvasRafRef.current);
        canvasRafRef.current = null;
      }
      canvasStreamRef.current?.getTracks().forEach(t => t.stop());
      canvasStreamRef.current = null;
      canvasRef.current = null;

      const actualType = mimeTypeRef.current || 'video/mp4';
      let blob = new Blob(recorderChunksRef.current, { type: actualType });

      if (blob.size === 0) {
        console.error('Recording produced an empty video.');
        setIsProcessing(false);
        return;
      }

      if (actualType.includes('webm')) {
        const durationMs = (recordingDurationRef.current || 1) * 1000;
        blob = await fixWebmDuration(blob, durationMs);
      }

      setIsProcessing(false);
      onCapture(URL.createObjectURL(blob), actualType);
    };

    recorder.start();

    if ('vibrate' in navigator) navigator.vibrate(200);

    setRecordingDuration(0);
    recordingDurationRef.current = 0;
    durationIntervalRef.current = window.setInterval(() => {
      setRecordingDuration(prev => {
        const nextVal = prev + 1;
        recordingDurationRef.current = nextVal;
        return nextVal;
      });
    }, 1000);

    setIsRecording(true);
  };

  const startRecording = () => {
    if (!streamRef.current || isRecording || !isCameraReady) return;
    setShowEndFrame(false);
    start1080pRecording();
  };

  const stopRecording = () => {
    if (!isRecording) return;

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    setIsRecording(false);
    setShowEndFrame(false);
    setIsProcessing(true);

    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      setTimeout(() => {
        try {
          if (recorder.state === 'recording') recorder.stop();
        } catch (err) {
          console.error('Error stopping recorder:', err);
          setIsProcessing(false);
        }
      }, 200);
    } else {
      setIsProcessing(false);
    }
  };

  const formatDuration = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const progress = Math.min((recordingDuration / 60) * 100, 100);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#000', zIndex: 50,
      overflow: 'hidden', height: '100dvh', width: '100vw',
    }}>
      {/* ══ TOP BAR ══ */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.2) 65%, transparent 100%)',
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px' }}>
          <button
            onClick={onClose}
            disabled={isRecording || isProcessing}
            style={{
              width: 42, height: 42, borderRadius: 12,
              background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
              color: (isRecording || isProcessing) ? 'rgba(255,255,255,0.25)' : 'white',
              fontSize: 18, cursor: (isRecording || isProcessing) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: isRecording ? '#ef4444' : '#00d47a',
              boxShadow: isRecording ? '0 0 8px rgba(239,68,68,0.9)' : '0 0 8px rgba(0,212,122,0.9)',
              animation: 'blink 1s ease-in-out infinite',
            }} />
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, letterSpacing: '0.2em', fontFamily: 'monospace' }}>
              {isRecording ? 'REC · 1080P' : 'APOLLO · 1X'}
            </span>
          </div>

          <div style={{
            padding: '6px 14px', borderRadius: 20,
            background: isRecording ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${isRecording ? 'rgba(239,68,68,0.45)' : 'rgba(255,255,255,0.15)'}`,
          }}>
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
              {isRecording ? formatDuration(recordingDuration) : '0:00'}
            </span>
          </div>
        </div>
      </div>

      {/* ══ 1X PORTRAIT VIEWFINDER ══ */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
        {/* Flash button */}
        {flashSupported && isCameraReady && (
          <button
            onClick={toggleFlash}
            type="button"
            title={isFlashOn ? "Turn Flash OFF" : "Turn Flash ON"}
            style={{
              position: 'absolute', top: 'calc(72px + env(safe-area-inset-top, 0px))', right: 16, zIndex: 35,
              display: 'flex', alignItems: 'center', gap: 8,
              background: isFlashOn ? 'rgba(255, 215, 0, 0.22)' : 'rgba(0,0,0,0.65)',
              backdropFilter: 'blur(8px)',
              padding: '8px 14px', borderRadius: 20,
              border: isFlashOn ? '1px solid #FFD700' : '1px solid rgba(255,255,255,0.2)',
              color: isFlashOn ? '#FFD700' : 'rgba(255,255,255,0.85)',
              cursor: 'pointer',
              boxShadow: isFlashOn ? '0 0 14px rgba(255, 215, 0, 0.5)' : '0 2px 8px rgba(0,0,0,0.3)',
              transition: 'all 0.2s ease',
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill={isFlashOn ? '#FFD700' : 'none'}
              stroke={isFlashOn ? '#FFD700' : 'currentColor'}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', fontFamily: 'monospace' }}>
              {isFlashOn ? 'FLASH ON' : 'FLASH OFF'}
            </span>
          </button>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />

        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'radial-gradient(ellipse 130% 90% at 50% 50%, transparent 35%, rgba(0,0,0,0.65) 100%)'
        }} />

        {/* ══ HORIZONTAL SCAN FRAME ══ */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: '92%', aspectRatio: '8 / 3',
          pointerEvents: 'none', zIndex: 15,
        }}>
          <svg viewBox="0 0 560 210" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
            <defs>
              <filter id="glowGreen">
                <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <rect x="4" y="4" width="552" height="202" rx="12" fill="rgba(0,212,122,0.03)" />
            {[112, 187, 280, 373, 448].map((x, i) => (
              <line key={x} x1={x} y1="12" x2={x} y2="198"
                stroke="#00d47a" strokeWidth={i === 2 ? 1.2 : 0.6}
                opacity={i === 2 ? 0.35 : 0.12} strokeDasharray={i === 2 ? "none" : "4 6"} />
            ))}
            <circle cx="280" cy="105" r="8" fill="none" stroke="#00d47a" strokeWidth="1.5" opacity="0.7">
              <animate attributeName="opacity" values="0.2;0.9;0.2" dur="2s" repeatCount="indefinite" />
            </circle>
            <circle cx="280" cy="105" r="3" fill="#00d47a" opacity="0.5">
              <animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite" />
            </circle>
            <line x1="262" y1="105" x2="298" y2="105" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
            <line x1="280" y1="87" x2="280" y2="123" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
            {[112, 187, 280, 373, 448].map((x, i) => (
              <g key={`tk${x}`}>
                <line x1={x} y1="10" x2={x} y2={i === 2 ? 20 : 17} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
                <line x1={x} y1="200" x2={x} y2={i === 2 ? 190 : 193} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
              </g>
            ))}
            {isRecording && (
              <line x1={scanPct * 5.6} y1="10" x2={scanPct * 5.6} y2="200"
                stroke="#00d47a" strokeWidth="2.5" opacity="0.85" filter="url(#glowGreen)">
                <animate attributeName="opacity" values="0.3;0.95;0.3" dur="0.4s" repeatCount="indefinite" />
              </line>
            )}
            <rect x="8" y="8" width="544" height="194" rx="8" fill="none"
              stroke="rgba(0,212,122,0.25)" strokeWidth="1" strokeDasharray="8 6"
              style={{ animation: 'dashMove 4s linear infinite' }} />
            <g>
              <line x1="10" y1="105" x2="252" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? "0.9" : "0.55"} strokeLinecap="round" />
              <line x1="308" y1="105" x2="550" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? "0.9" : "0.55"} strokeLinecap="round" />
              <polygon points="280,98 287,105 280,112 273,105" fill="none" stroke="#00d47a" strokeWidth="1.5" strokeOpacity={isRecording ? "1" : "0.7"} />
              <polygon points="280,102 284,105 280,108 276,105" fill="#00d47a" fillOpacity={isRecording ? "0.9" : "0.4"} />
              <text x="280" y="124" fill="#00d47a" fontSize="8" fontWeight="600" textAnchor="middle" opacity={isRecording ? "0" : "0.5"}
                style={{ fontFamily: 'monospace', letterSpacing: '1.5px' }}>LEVEL</text>
            </g>
          </svg>

          <div style={{
            position: 'absolute', top: -32, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
            padding: '4px 12px', borderRadius: 20, border: '1px solid rgba(0,212,122,0.3)',
          }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: isRecording ? '#ef4444' : '#00d47a',
              boxShadow: `0 0 6px ${isRecording ? '#ef4444' : '#00d47a'}`,
              animation: 'blink 1s ease-in-out infinite',
            }} />
            <span style={{ color: '#00d47a', fontSize: 10, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', fontFamily: 'monospace' }}>
              {isRecording ? 'RECORDING' : 'ALIGN TYRE TREAD'}
            </span>
          </div>
        </div>

        {/* ══ LEFT EDGE — START FRAME ══ */}
        {(!isRecording || (isRecording && !showEndFrame)) && (
          <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
            <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <defs>
                <linearGradient id="startGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowL">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="0" y1="20" x2="0" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowL)" />
              <path d="M 16 15 Q 0 140 16 265" fill="none" stroke="url(#startGrad)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowL)" />
              <path d="M 24 25 Q 4 140 24 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="12" y1="50" x2="12" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowL)">
                {isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}
              </line>
              <polygon points="14,134 14,146 30,140" fill="#00d47a" opacity="0.95">
                {!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}
              </polygon>
              <text x="36" y="144" fill="#00d47a" fontSize="11" fontWeight="700" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>START</text>
              {isRecording && (
                <>
                  <line x1="30" y1="140" x2="52" y2="140" stroke="#00d47a" strokeWidth="2" opacity="0.5" strokeDasharray="6 4">
                    <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="1s" repeatCount="indefinite" />
                  </line>
                  <polygon points="46,136 52,140 46,144" fill="#00d47a" opacity="0.7">
                    <animate attributeName="opacity" values="0.3;0.9;0.3" dur="0.8s" repeatCount="indefinite" />
                  </polygon>
                </>
              )}
              {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (
                <line key={y} x1="0" y1={y} x2="14" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />
              ))}
            </svg>
          </div>
        )}

        {/* ══ RIGHT EDGE — END FRAME ══ */}
        {(isRecording && showEndFrame) && (
          <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
            <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <defs>
                <linearGradient id="endGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowR">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="100" y1="20" x2="100" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowR)" />
              <path d="M 84 15 Q 100 140 84 265" fill="none" stroke="url(#endGrad)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowR)" />
              <path d="M 76 25 Q 96 140 76 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="88" y1="50" x2="88" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowR)">
                {isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}
              </line>
              <polygon points="86,134 86,146 70,140" fill="#00d47a" opacity="0.95">
                {!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}
              </polygon>
              <text x="64" y="144" fill="#00d47a" fontSize="11" fontWeight="700" textAnchor="end" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>END</text>
              {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (
                <line key={y} x1="100" y1={y} x2="86" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />
              ))}
            </svg>
          </div>
        )}
      </div>

      {/* ══ BOTTOM CONTROLS ══ */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '12px 24px 16px', paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        background: 'linear-gradient(0deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)',
      }}>
        {!isRecording && isCameraReady && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 }}>
              <div style={{ display: 'flex', gap: 3 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ width: 16, height: 2, borderRadius: 1, background: `rgba(0,212,122,${0.3 + i * 0.3})` }} />
                ))}
              </div>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>Hold steady · Tread runs left → right</span>
            </div>
          </div>
        )}

        {isRecording && (
          <div style={{ width: '100%', maxWidth: 200 }}>
            <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 5 }}>
              <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #00c46e, #00d47a)', width: `${progress}%`, transition: 'width 1s linear' }} />
            </div>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>Recording: {formatDuration(recordingDuration)}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {!isRecording ? (
              <button
                onClick={startRecording}
                disabled={!isCameraReady || isProcessing}
                style={{
                  position: 'relative', background: 'none', border: 'none', padding: 0,
                  cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer',
                  opacity: (!isCameraReady || isProcessing) ? 0.4 : 1
                }}
              >
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#00d47a', boxShadow: '0 0 20px rgba(0,212,122,0.55)' }} />
                </div>
              </button>
            ) : (
              <button onClick={stopRecording} style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(239,68,68,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.07)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: '#ef4444', boxShadow: '0 0 20px rgba(239,68,68,0.6)' }} />
                </div>
              </button>
            )}
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.4)', fontSize: 10, letterSpacing: '0.08em', animation: isRecording ? 'blink 1s ease-in-out infinite' : 'none' }}>
              {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING 1X CAMERA...'}
            </span>
          </div>
        </div>
      </div>

      {isProcessing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.3s ease', zIndex: 60, overflow: 'auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, animation: 'scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)', padding: '40px 20px', maxWidth: 500, width: '100%' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(0,212,122,0.12)', border: '2px solid rgba(0,212,122,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 32, height: 32, border: '3px solid rgba(0,212,122,0.25)', borderTopColor: '#00d47a', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: 'white', fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>Finalising Scan</p>
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, margin: 0 }}>
                Processing 1080p video for tread analysis…
              </p>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes dashMove { to { stroke-dashoffset: -30; } }
        @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes scaleIn  { from{transform:scale(0.5);opacity:0} 60%{transform:scale(1.06)} to{transform:scale(1);opacity:1} }
        @keyframes pulse    { 0%,100%{opacity:0.4;transform:scale(1)} 50%{opacity:1;transform:scale(1.2)} }
        @keyframes spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
};

// ─── INSTRUCTIONS PROMPT ──────────────────────────────────────────────────────
interface InstructionsPromptProps { onContinue: () => void; onClose: () => void; }

const InstructionsPrompt: React.FC<InstructionsPromptProps> = ({ onContinue, onClose }) => (
  <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: '#080c10', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 70% 50% at 50% 60%, rgba(0,210,120,0.07) 0%, transparent 70%)' }} />
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.04, pointerEvents: 'none' }}>
      <defs><pattern id="pg" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#00d47a" strokeWidth="0.5" /></pattern></defs>
      <rect width="100%" height="100%" fill="url(#pg)" />
    </svg>
    <button onClick={onClose} style={{ position: 'absolute', top: 20, left: 20, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, width: 40, height: 40, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 18, zIndex: 1 }}>✕</button>
    <div style={{ position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1 }}>
      <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 11, letterSpacing: '0.35em', textTransform: 'uppercase', fontWeight: 500, whiteSpace: 'nowrap' }}>APOLLO · TREAD SCAN</span>
    </div>
    <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, padding: '60px 32px 32px', maxWidth: 360, width: '100%' }}>
      <img src={InstructionImg} alt="Instruction" style={{ width: 180, height: 290, marginTop: 10 }} className='border-4 border-white' />
      <div style={{ textAlign: 'center' }}>
        <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 600, margin: '0 0 8px', letterSpacing: '-0.5px' }}>Vertical Tread Scan</h2>
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          Hold phone upright. The tread runs left → right across the wide green frame.
        </p>
      </div>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { icon: '◎', label: 'Hold phone in portrait (upright)' },
          { icon: '←→', label: 'Tread runs left edge → right edge' },
          { icon: '▭', label: 'Align tread inside the wide green frame' },
          { icon: '●', label: 'Tap scan to start, tap stop when finished' },
        ].map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '10px 14px' }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: 'rgba(0,212,122,0.1)', border: '1px solid rgba(0,212,122,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00d47a', fontSize: 12, fontFamily: 'monospace' }}>{s.icon}</div>
            <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>{s.label}</span>
            <div style={{ marginLeft: 'auto', width: 20, height: 20, borderRadius: '50%', flexShrink: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 10 }}>{i + 1}</div>
          </div>
        ))}
      </div>
      <button onClick={onContinue} style={{ width: '100%', background: 'linear-gradient(135deg, #00b863, #00d47a)', border: 'none', borderRadius: 14, padding: '16px 32px', color: '#001a0d', fontSize: 15, fontWeight: 700, letterSpacing: '0.2px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
        Open Scanner
      </button>
    </div>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
      @keyframes spin        { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      @keyframes phoneRotate { 0%,25%{transform:rotate(0deg)} 55%,85%{transform:rotate(-90deg)} 100%{transform:rotate(0deg)} }
    `}</style>
  </div>
);

// ─── HOME ─────────────────────────────────────────────────────────────────────
const Home: React.FC = () => {
  const [stage, setStage] = useState<'home' | 'prompt' | 'camera'>('home');
  const [capturedVideos, setCapturedVideos] = useState<Array<{ url: string; mimeType: string }>>([]);

  const downloadVideo = async (url: string, mimeType: string) => {
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `tread_scan_${Date.now()}.${extension}`;

    try {
      if (typeof navigator !== 'undefined' && 'canShare' in navigator && 'share' in navigator) {
        const response = await fetch(url);
        const blob = await response.blob();
        const file = new File([blob], filename, { type: mimeType });

        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'Apollo Tread Scan',
            text: 'Tyre tread scan video',
          });
          return;
        }
      }
    } catch { }

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#080c10', fontFamily: "'DM Sans', sans-serif", color: 'white', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, background: 'radial-gradient(ellipse 60% 40% at 30% 20%, rgba(0,212,122,0.06) 0%, transparent 60%), radial-gradient(ellipse 50% 50% at 80% 80%, rgba(0,100,255,0.04) 0%, transparent 60%)' }} />
      <svg style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', opacity: 0.035, zIndex: 0, pointerEvents: 'none' }}>
        <defs><pattern id="hg" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#00d47a" strokeWidth="0.5" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#hg)" />
      </svg>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 440, margin: '0 auto', padding: '0 24px 48px' }}>
        <div style={{ paddingTop: 64, marginBottom: 52 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(0,212,122,0.12)', border: '1px solid rgba(0,212,122,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#00d47a" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M2 12h3M19 12h3M12 2v3M12 19v3" /></svg>
            </div>
            <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 11, letterSpacing: '0.3em', textTransform: 'uppercase' }}>APOLLO SYSTEM</span>
          </div>
          <h1 style={{ fontSize: 40, fontWeight: 700, margin: '0 0 8px', letterSpacing: '-1.5px', lineHeight: 1.1 }}>Tread<span style={{ color: '#00d47a' }}>Scan</span></h1>
          <p style={{ color: 'rgba(255,255,255,0.38)', fontSize: 14, margin: 0, lineHeight: 1.6 }}>AI-powered tyre tread depth analysis</p>
        </div>

        <button onClick={() => setStage('prompt')} style={{ width: '100%', background: 'none', border: '1px solid rgba(0,212,122,0.2)', borderRadius: 20, padding: 0, cursor: 'pointer', overflow: 'hidden', position: 'relative', marginBottom: 20 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(0,212,122,0.08) 0%, rgba(0,100,200,0.04) 100%)' }} />
          <div style={{ position: 'relative', padding: '34px 32px' }}>
            <div style={{ marginBottom: 26, display: 'flex', justifyContent: 'center' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ position: 'absolute', inset: -12, borderRadius: '50%', border: '1px solid rgba(0,212,122,0.15)', animation: 'ringPulse 2.5s ease-in-out infinite' }} />
                <div style={{ position: 'absolute', inset: -24, borderRadius: '50%', border: '1px solid rgba(0,212,122,0.07)', animation: 'ringPulse 2.5s ease-in-out infinite 0.5s' }} />
                <div style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(0,212,122,0.1)', border: '1px solid rgba(0,212,122,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00d47a" strokeWidth="1.5" strokeLinecap="round"><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11, letterSpacing: '0.25em', margin: '0 0 8px', textTransform: 'uppercase' }}>Tap to begin</p>
              <h2 style={{ fontSize: 21, fontWeight: 600, margin: '0 0 6px', letterSpacing: '-0.4px' }}>Start Tyre Scan</h2>
              <p style={{ color: 'rgba(255,255,255,0.33)', fontSize: 13, margin: '0 0 22px' }}>Horizontal frame recording · 1080p</p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                {['Portrait 1080p', '1x Back Camera', 'Flash On'].map(f => (
                  <span key={f} style={{ padding: '4px 12px', borderRadius: 20, background: 'rgba(0,212,122,0.08)', border: '1px solid rgba(0,212,122,0.15)', color: 'rgba(0,212,122,0.8)', fontSize: 11, fontWeight: 500 }}>{f}</span>
                ))}
              </div>
            </div>
          </div>
        </button>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 28 }}>
          {[{ value: '1080p', unit: '', label: 'Resolution' }, { value: '1x', unit: '', label: 'Camera' }, { value: 'Flash', unit: '', label: 'Lighting' }].map(s => (
            <div key={s.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: '14px 10px', textAlign: 'center' }}>
              <div style={{ marginBottom: 2 }}>
                <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px' }}>{s.value}</span>
                <span style={{ fontSize: 11, color: '#00d47a', fontWeight: 600 }}>{s.unit}</span>
              </div>
              <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, margin: 0 }}>{s.label}</p>
            </div>
          ))}
        </div>

        {capturedVideos.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'rgba(255,255,255,0.65)' }}>Recent Scans</h3>
              <span style={{ padding: '2px 10px', borderRadius: 20, background: 'rgba(0,212,122,0.1)', border: '1px solid rgba(0,212,122,0.2)', color: '#00d47a', fontSize: 11 }}>{capturedVideos.length}</span>
            </div>
            {capturedVideos.map((url, i) => (
              <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00d47a', boxShadow: '0 0 6px #00d47a' }} />
                    <span style={{ color: '#00d47a', fontSize: 11, fontWeight: 700, letterSpacing: '0.5px' }}>SCAN #{capturedVideos.length - i}</span>
                  </div>
                  <button onClick={() => downloadVideo(url.url, url.mimeType)}
                    style={{ padding: '5px 12px', borderRadius: 8, background: 'rgba(0,212,122,0.12)', border: '1px solid rgba(0,212,122,0.25)', color: '#00d47a', fontSize: 10, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    SAVE VIDEO
                  </button>
                </div>
                <video src={url.url} controls style={{ width: '100%', borderRadius: 10, display: 'block', border: '1px solid rgba(0,212,122,0.3)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }} />
              </div>
            ))}
          </div>
        )}

        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 16, padding: 20 }}>
          <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', margin: '0 0 16px' }}>How it works</p>
          {([
            ['Tap "Start Tyre Scan"', 'Launches the 1x back camera with flash on'],
            ['Hold phone in portrait mode', 'Tyre tread runs left → right across screen'],
            ['Align tread in wide green frame', 'START on left edge, END on right edge'],
            ['Tap scan to record, tap stop when done', 'Captures crystal clear 1080p portrait video'],
          ] as [string, string][]).map(([title, desc], i) => (
            <div key={i} style={{ display: 'flex', gap: 14, marginBottom: i < 3 ? 16 : 0 }}>
              <div style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0, background: 'rgba(0,212,122,0.08)', border: '1px solid rgba(0,212,122,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00d47a', fontSize: 11, fontWeight: 700 }}>{i + 1}</div>
              <div>
                <p style={{ color: 'rgba(255,255,255,0.68)', fontSize: 13, fontWeight: 500, margin: '0 0 2px' }}>{title}</p>
                <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 12, margin: 0 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {stage === 'prompt' && <InstructionsPrompt onContinue={() => setStage('camera')} onClose={() => setStage('home')} />}
      {stage === 'camera' && (
        <CameraCapture
          onClose={() => setStage('home')}
          onCapture={(videoUrl, mimeType) => {
            setCapturedVideos(prev => [{ url: videoUrl, mimeType }, ...prev]);
            setStage('home');
          }}
        />
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes ringPulse { 0%,100%{transform:scale(1);opacity:0.6} 50%{transform:scale(1.15);opacity:0.2} }
      `}</style>
    </div>
  );
};

export default Home;
