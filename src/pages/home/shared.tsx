import { useState, useRef, useEffect, useCallback } from 'react';
// import InstructionVideo from "../../assets/instruction_video.mp4";
import InstructionImg from "../../assets/instruction_img.jpeg";
// ─── UTILITY: DETECT IOS / IPHONE ─────────────────────────────────────────────
const isIOSDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
};

// ─── CAMERA METRICS & TYPES ──────────────────────────────────────────────────
export interface CameraMetrics {
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
  facingMode?: string;
  displayAspect?: string;
}

interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  focusMode?: string;
  exposureMode?: string;
  torch?: boolean;
  zoom?: number;
}

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
  exposureMode?: string[];
  zoom?: { min: number; max: number; step: number };
}

interface CameraCaptureProps {
  onCapture: (videoUrl: string, mimeType: string) => void;
  onClose: () => void;
}

// Format aspect ratio helper for display (e.g. "9:16", "3:4", etc.)
const formatAspectRatio = (width?: number, height?: number, rawAspect?: number): string => {
  if (!width || !height) {
    if (rawAspect) {
      if (Math.abs(rawAspect - 9 / 16) < 0.05) return '9:16';
      if (Math.abs(rawAspect - 3 / 4) < 0.05) return '3:4';
      if (Math.abs(rawAspect - 16 / 9) < 0.05) return '16:9';
      if (Math.abs(rawAspect - 4 / 3) < 0.05) return '4:3';
      return rawAspect.toFixed(2);
    }
    return 'Adaptive';
  }

  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.03) return '9:16';
  if (Math.abs(ratio - 3 / 4) < 0.03) return '3:4';
  if (Math.abs(ratio - 16 / 9) < 0.03) return '16:9';
  if (Math.abs(ratio - 4 / 3) < 0.03) return '4:3';
  if (Math.abs(ratio - 1) < 0.03) return '1:1';
  return ratio < 1 ? `${width}:${height} (${ratio.toFixed(2)})` : `${height}:${width} (${ratio.toFixed(2)})`;
};

// ─── RECORDING CHECKS (match backend video_validator) ─────────────────────────
const MIN_RECORD_SECONDS = 7;   // backend rejects videos shorter than 7 s
const MIN_BRIGHTNESS = 100;     // backend BRIGHTNESS_MIN

// Determine best supported MediaRecorder MIME type (Prioritizing MP4 H.264 for universal gallery playback)
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

// Calculate practical adaptive bitrate based on negotiated resolution & frame rate
const calculateAdaptiveBitrate = (width?: number, height?: number, frameRate?: number): number => {
  const w = width || 1080;
  const h = height || 1920;
  const fps = frameRate || 30;
  const totalPixelsPerSec = w * h * fps;

  const targetBitrate = Math.round(totalPixelsPerSec * 0.10);
  return Math.min(Math.max(targetBitrate, 1_500_000), 8_000_000);
};

/**
 * Injects duration metadata into a WebM Blob so Android/Samsung Gallery
 * and native media players can determine duration and play/seek the video without "Can't play video" errors.
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

// ═════════════════════════════════════════════════════════════════════════════
// ─── 1. ANDROID DEDICATED CAMERA CAPTURE (PROVEN WORKING CODE) ───────────────
// ═════════════════════════════════════════════════════════════════════════════

async function acquireAdaptiveCameraStreamAndroid(): Promise<MediaStream> {
  const constraintProfiles: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        aspectRatio: { ideal: 9 / 16 },
        frameRate: { ideal: 30, min: 15 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 720 },
        height: { ideal: 1280 },
        aspectRatio: { ideal: 9 / 16 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        aspectRatio: { ideal: 16 / 9 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
        aspectRatio: { ideal: 9 / 16 },
      },
      audio: false,
    },
    {
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    },
    { video: true, audio: false },
  ];

  let stream: MediaStream | null = null;
  let lastError: unknown = null;

  for (const constraints of constraintProfiles) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream && stream.getVideoTracks().length > 0) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!stream) throw lastError || new Error('Failed to acquire camera stream');

  // Lock to 1x back camera: if browser opened ultra-wide (0.5x) or telephoto (2x), switch to standard 1x
  try {
    const currentTrack = stream.getVideoTracks()[0];
    const label = (currentTrack?.label || '').toLowerCase();
    const is05xOrTele = label.includes('ultra') || label.includes('0.5') || label.includes('tele');
    if (is05xOrTele && typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      const normal1x = videoDevices.find(d => {
        const l = d.label.toLowerCase();
        return (
          !l.includes('front') &&
          !l.includes('selfie') &&
          !l.includes('ultra') &&
          !l.includes('0.5') &&
          !l.includes('tele') &&
          (l.includes('back') || l.includes('rear') || l.includes('environment'))
        );
      });
      if (normal1x && normal1x.deviceId && normal1x.deviceId !== currentTrack.getSettings().deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: normal1x.deviceId },
            width: { ideal: 1080 },
            height: { ideal: 1920 },
            aspectRatio: { ideal: 9 / 16 },
          },
          audio: false,
        });
      }
    }
  } catch (lensErr) {
    console.warn('1x camera check skipped:', lensErr);
  }

  const track = stream.getVideoTracks()[0];
  if (track) {
    try {
      const capabilities = (typeof track.getCapabilities === 'function'
        ? track.getCapabilities()
        : {}) as ExtendedMediaTrackCapabilities;
      const currentSettings = track.getSettings();

      if (capabilities.height && capabilities.width) {
        const maxHeight = typeof capabilities.height === 'object' && 'max' in capabilities.height ? capabilities.height.max : undefined;
        const maxWidth = typeof capabilities.width === 'object' && 'max' in capabilities.width ? capabilities.width.max : undefined;

        const currentDim = Math.max(currentSettings.width || 0, currentSettings.height || 0);
        const maxSupportedDim = Math.max(maxWidth || 0, maxHeight || 0);

        if (maxSupportedDim > currentDim && maxSupportedDim >= 1280) {
          const targetLong = Math.min(maxSupportedDim, 1920);
          const targetShort = Math.round(targetLong * (9 / 16));
          const isPortraitTrack = (currentSettings.height || 0) >= (currentSettings.width || 0);

          try {
            await track.applyConstraints({
              width: { ideal: isPortraitTrack ? targetShort : targetLong },
              height: { ideal: isPortraitTrack ? targetLong : targetShort },
              aspectRatio: { ideal: isPortraitTrack ? 9 / 16 : 16 / 9 },
            });
          } catch (refineErr) {
            console.warn('applyConstraints resolution refinement skipped:', refineErr);
          }
        }
      }

      const advancedConstraints: ExtendedMediaTrackConstraintSet = {};
      let hasAdvanced = false;

      // Lock zoom to 1x if supported
      if (capabilities.zoom && typeof capabilities.zoom.min === 'number') {
        const minZ = capabilities.zoom.min;
        const maxZ = capabilities.zoom.max;
        if (1 >= minZ && 1 <= maxZ) {
          advancedConstraints.zoom = 1;
          hasAdvanced = true;
        }
      }

      if (capabilities.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        advancedConstraints.focusMode = 'continuous';
        hasAdvanced = true;
      }
      if (capabilities.exposureMode && Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
        advancedConstraints.exposureMode = 'continuous';
        hasAdvanced = true;
      }
      if (capabilities.torch === true || 'torch' in capabilities) {
        advancedConstraints.torch = true;
        hasAdvanced = true;
      }

      if (hasAdvanced) {
        try {
          await track.applyConstraints({
            advanced: [advancedConstraints as MediaTrackConstraintSet],
          });
        } catch { }
      }
    } catch (capErr) {
      console.warn('Capability inspection/refinement encountered non-fatal error:', capErr);
    }
  }

  return stream;
}

const CameraCaptureAndroid: React.FC<CameraCaptureProps> = ({ onClose, onCapture }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>('');
  const recordingDurationRef = useRef<number>(0);

  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [scanPct, setScanPct] = useState(0);
  const [flashSupported, setFlashSupported] = useState(false);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [showEndFrame, setShowEndFrame] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTooDark, setIsTooDark] = useState(false);

  // Live brightness check while recording (1x per second, small canvas, light on CPU)
  useEffect(() => {
    if (!isRecording) { setIsTooDark(false); return; }
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!ctx || !v || !v.videoWidth) return;
      try {
        ctx.drawImage(v, 0, 0, 64, 64);
        const d = ctx.getImageData(0, 0, 64, 64).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        setIsTooDark(sum / (d.length / 4) < MIN_BRIGHTNESS);
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording]);
  const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});

  const durationIntervalRef = useRef<number | null>(null);

  const toggleFlash = async () => {
    const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
    if (!track || !flashSupported) return;

    try {
      const nextState = !isFlashOn;
      const adv: ExtendedMediaTrackConstraintSet = { torch: nextState };
      await track.applyConstraints({
        advanced: [adv as MediaTrackConstraintSet],
      });
      setIsFlashOn(nextState);
    } catch (err) {
      console.error('Failed to toggle flash/torch:', err);
    }
  };

  const extractCameraDiagnostics = useCallback((stream: MediaStream) => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    trackRef.current = track;
    const settings = track.getSettings();
    const capabilities = (typeof track.getCapabilities === 'function'
      ? track.getCapabilities()
      : {}) as ExtendedMediaTrackCapabilities;

    const actualWidth = settings.width || videoRef.current?.videoWidth;
    const actualHeight = settings.height || videoRef.current?.videoHeight;
    const actualFrameRate = settings.frameRate ? Math.round(settings.frameRate) : undefined;
    const actualAspectRatio = settings.aspectRatio || (actualWidth && actualHeight ? actualWidth / actualHeight : undefined);

    const metrics: CameraMetrics = {
      width: actualWidth,
      height: actualHeight,
      frameRate: actualFrameRate,
      aspectRatio: actualAspectRatio,
      facingMode: settings.facingMode,
      displayAspect: formatAspectRatio(actualWidth, actualHeight, actualAspectRatio),
    };

    setCameraMetrics(metrics);
    setFlashSupported(capabilities.torch === true || 'torch' in capabilities);
  }, []);

  useEffect(() => {
    if (!isRecording) { setScanPct(0); return; }
    let x = 0; let dir = 1;
    const id = setInterval(() => {
      x += dir * 2.2;
      if (x >= 100) dir = -1;
      if (x <= 0) dir = 1;
      setScanPct(x);
    }, 16);
    return () => clearInterval(id);
  }, [isRecording]);

  useEffect(() => {
    if (isRecording && recordingDuration >= 2) setShowEndFrame(true);
    else if (!isRecording) setShowEndFrame(false);
  }, [recordingDuration, isRecording]);

  useEffect(() => {
    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await acquireAdaptiveCameraStreamAndroid();

        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = async () => {
            if (cancelled) return;
            extractCameraDiagnostics(stream);
            setIsCameraReady(true);

            try {
              const capabilities = (typeof track.getCapabilities === 'function'
                ? track.getCapabilities()
                : {}) as ExtendedMediaTrackCapabilities;
              if (capabilities.torch === true || 'torch' in capabilities) {
                const adv: ExtendedMediaTrackConstraintSet = { torch: true };
                await track.applyConstraints({
                  advanced: [adv as MediaTrackConstraintSet],
                });
                setIsFlashOn(true);
              }
            } catch (torchErr) {
              console.warn('Initial flash auto-enable skipped/error:', torchErr);
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

      if (trackRef.current) {
        try {
          const adv: ExtendedMediaTrackConstraintSet = { torch: false };
          void trackRef.current.applyConstraints({
            advanced: [adv as MediaTrackConstraintSet],
          });
        } catch { }
      }

      streamRef.current?.getTracks().forEach(track => track.stop());

      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    };
  }, [onClose, extractCameraDiagnostics]);

  const startRecording = () => {
    if (!streamRef.current || isRecording || !isCameraReady) return;
    actuallyStartRecording();
  };

  const startDirectMediaRecorder = (): boolean => {
    const stream = streamRef.current;
    if (!stream) return false;

    const track = stream.getVideoTracks()[0];
    const settings = track ? track.getSettings() : {};
    const nativeWidth = settings.width || cameraMetrics.width || 1080;
    const nativeHeight = settings.height || cameraMetrics.height || 1920;

    // DIRECT STREAM RECORDING: records the native 1080x1920 portrait stream directly from sensor
    const mimeType = getSupportedRecorderMimeType();
    const targetBitrate = calculateAdaptiveBitrate(
      nativeWidth,
      nativeHeight,
      settings.frameRate || cameraMetrics.frameRate
    );

    let recorder: MediaRecorder | null = null;

    if (mimeType) {
      try {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate });
      } catch {
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch {
          recorder = null;
        }
      }
    }
    if (!recorder) {
      try {
        recorder = new MediaRecorder(stream);
      } catch (err) {
        console.error('MediaRecorder initialization failed:', err);
        return false;
      }
    }

    recorderChunksRef.current = [];
    mimeTypeRef.current = recorder.mimeType || mimeType || 'video/webm';
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
      const actualType = mimeTypeRef.current || 'video/webm';
      let blob = new Blob(recorderChunksRef.current, { type: actualType });

      if (blob.size === 0) {
        console.error('Recording produced an empty video.'); alert('Recording failed – please record again.');
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
    return true;
  };

  const actuallyStartRecording = () => {
    if (!streamRef.current || !videoRef.current) return;

    setShowEndFrame(false);

    const started = startDirectMediaRecorder();
    if (!started) {
      setIsProcessing(false);
      alert('Unable to record the camera stream on this device.');
      return;
    }

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

  const stopRecording = () => {
    if (!isRecording) return;
    if (recordingDurationRef.current < MIN_RECORD_SECONDS) return;

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    setIsRecording(false);
    setShowEndFrame(false);
    setIsProcessing(true);

    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
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
      background: '#000', zIndex: 50, display: 'flex',
      flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start',
      overflow: 'hidden', height: '100dvh', width: '100vw',
    }}>
      {/* ══ TOP BAR ══ */}
      <div style={{ background: '#000', zIndex: 20 }}>
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
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, letterSpacing: '0.2em', fontFamily: 'monospace' }}>
              {isRecording ? 'REC' : 'APOLLO'}
            </span>
          </div>

          <div style={{
            padding: '6px 14px', borderRadius: 20,
            background: isRecording ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}`,
          }}>
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
              {isRecording ? formatDuration(recordingDuration) : '0:00'}
            </span>
          </div>
        </div>
      </div>

      {/* ══ PORTRAIT VIEWFINDER ══ */}
      <div ref={containerRef} style={{
        position: 'relative', width: '100%', flex: 1,
        overflow: 'hidden', background: '#000',
      }}>
        {flashSupported && isCameraReady && (
          <button
            onClick={toggleFlash}
            type="button"
            title={isFlashOn ? "Turn Flash OFF" : "Turn Flash ON"}
            style={{
              position: 'absolute', top: 16, right: 16, zIndex: 25,
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

        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
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
        </div>

        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 130% 90% at 50% 50%, transparent 30%, rgba(0,0,0,0.65) 100%)' }} />

        {/* ══ HORIZONTAL SCAN FRAME ══ */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: '92%', aspectRatio: '8 / 3',
          pointerEvents: 'none', zIndex: 15,
        }}>
          <svg viewBox="0 0 560 210" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
            <defs>
              <filter id="glowAndroid">
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
                stroke="#00d47a" strokeWidth="2.5" opacity="0.85" filter="url(#glowAndroid)">
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
                <linearGradient id="startGradA" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowLA">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="0" y1="20" x2="0" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowLA)" />
              <path d="M 16 15 Q 0 140 16 265" fill="none" stroke="url(#startGradA)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowLA)" />
              <path d="M 24 25 Q 4 140 24 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="12" y1="50" x2="12" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowLA)">
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
                <linearGradient id="endGradA" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowRA">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="100" y1="20" x2="100" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowRA)" />
              <path d="M 84 15 Q 100 140 84 265" fill="none" stroke="url(#endGradA)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowRA)" />
              <path d="M 76 25 Q 96 140 76 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="88" y1="50" x2="88" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowRA)">
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 24px 16px', background: '#000' }}>
        {!isRecording && isCameraReady && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 }}>
              <div style={{ display: 'flex', gap: 3 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ width: 16, height: 2, borderRadius: 1, background: `rgba(0,212,122,${0.3 + i * 0.3})` }} />
                ))}
              </div>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Hold steady · Tread runs left → right</span>
            </div>
            <div style={{ color: '#00D47A', fontSize: 12, fontWeight: 600, marginTop: 4 }}>
              Fill the box with the tread – both edges visible
            </div>
          </div>
        )}

        {isRecording && (
          <div style={{ width: '100%', maxWidth: 200 }}>
            <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 5 }}>
              <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #00c46e, #00d47a)', width: `${progress}%`, transition: 'width 1s linear' }} />
            </div>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>Recording: {formatDuration(recordingDuration)}</span>
            {recordingDuration < MIN_RECORD_SECONDS && (
              <div style={{ color: '#fbbf24', fontSize: 11, marginTop: 4 }}>Keep recording… {MIN_RECORD_SECONDS - recordingDuration}s</div>
            )}
            {isTooDark && (
              <div style={{ color: '#f87171', fontSize: 11, fontWeight: 600, marginTop: 4 }}>Too dark – turn on flash or move to light</div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px',
            borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            minWidth: 120,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d47a' }} />
              <span style={{ color: '#00d47a', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 }}>
                {cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'ADAPTIVE'}
              </span>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: 'monospace' }}>
              {cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'FPS: Auto'} • {cameraMetrics.displayAspect || '9:16'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {!isRecording ? (
              <button onClick={startRecording} disabled={!isCameraReady || isProcessing}
                style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer', opacity: (!isCameraReady || isProcessing) ? 0.4 : 1 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#00d47a', boxShadow: '0 0 20px rgba(0,212,122,0.55)' }} />
                </div>
              </button>
            ) : (
              <button onClick={stopRecording} disabled={recordingDuration < MIN_RECORD_SECONDS}
                style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: recordingDuration < MIN_RECORD_SECONDS ? 'not-allowed' : 'pointer', opacity: recordingDuration < MIN_RECORD_SECONDS ? 0.4 : 1 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(239,68,68,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.07)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: '#ef4444', boxShadow: '0 0 20px rgba(239,68,68,0.6)' }} />
                </div>
              </button>
            )}
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.35)', fontSize: 10, letterSpacing: '0.08em', animation: isRecording ? 'blink 1s ease-in-out infinite' : 'none' }}>
              {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING...'}
            </span>
          </div>

          <div style={{ minWidth: 120, display: 'flex', justifyContent: 'flex-end' }}>
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 9, fontFamily: 'monospace', textTransform: 'uppercase' }}>
              {cameraMetrics.facingMode || 'REAR'}
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
                Processing video for tread analysis…
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

// ═════════════════════════════════════════════════════════════════════════════
// ─── 2. IPHONE (IOS) DEDICATED CAMERA CAPTURE ────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

async function acquireAdaptiveCameraStreamIOS(): Promise<MediaStream> {
  // NOTE ON ASPECT RATIO: unlike Android/Chrome (which can pick a native sensor
  // mode that already matches a requested narrow aspect ratio like 9:16),
  // iOS Safari/WebKit (AVFoundation) has no native 9:16 capture preset. When
  // asked for a strict `aspectRatio: 9/16`, it takes the sensor's natural,
  // wider feed and digitally crops/zooms it to force that narrow ratio —
  // BEFORE this app ever sees a frame. That digital zoom is what made both
  // the live preview and the recorded video look "zoomed in" compared to the
  // native Camera app. We no longer request a narrow aspect ratio here; we
  // ask for the camera's natural wide capture instead, and let the existing
  // object-fit:cover (preview) / containerAspect crop (recording) do the
  // portrait framing entirely in software — same as the native Camera app's
  // viewfinder does.
  const constraintProfiles: MediaStreamConstraints[] = [
    // 1. Full HD wide capture — natural iOS video preset, no forced crop-zoom.
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, min: 24 },
      },
      audio: false,
    },
    // 2. HD wide capture fallback.
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    },
    // 3. Generic environment camera, no size/aspect constraints — whatever
    // natural (un-zoomed) mode the device defaults to.
    {
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    },
    { video: true, audio: false },
  ];

  let stream: MediaStream | null = null;
  let lastError: unknown = null;

  for (const constraints of constraintProfiles) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream && stream.getVideoTracks().length > 0) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!stream) throw lastError || new Error('Failed to acquire camera stream');

  // Lock to 1x back camera: if browser opened ultra-wide (0.5x) or telephoto (2x), switch to standard 1x
  try {
    const currentTrack = stream.getVideoTracks()[0];
    const label = (currentTrack?.label || '').toLowerCase();
    const is05xOrTele = label.includes('ultra') || label.includes('0.5') || label.includes('tele');
    if (is05xOrTele && typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      const normal1x = videoDevices.find(d => {
        const l = d.label.toLowerCase();
        return (
          !l.includes('front') &&
          !l.includes('selfie') &&
          !l.includes('ultra') &&
          !l.includes('0.5') &&
          !l.includes('tele') &&
          (l.includes('back') || l.includes('rear') || l.includes('environment'))
        );
      });
      if (normal1x && normal1x.deviceId && normal1x.deviceId !== currentTrack.getSettings().deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: normal1x.deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, min: 24 },
          },
          audio: false,
        });
      }
    }
  } catch (lensErr) {
    console.warn('iOS 1x camera check skipped:', lensErr);
  }

  const track = stream.getVideoTracks()[0];
  if (track) {
    try {
      const capabilities = (typeof track.getCapabilities === 'function'
        ? track.getCapabilities()
        : {}) as ExtendedMediaTrackCapabilities;
      const currentSettings = track.getSettings();

      if (capabilities.height && capabilities.width) {
        const maxHeight = typeof capabilities.height === 'object' && 'max' in capabilities.height ? capabilities.height.max : undefined;
        const maxWidth = typeof capabilities.width === 'object' && 'max' in capabilities.width ? capabilities.width.max : undefined;

        const maxSupportedDim = Math.max(maxWidth || 0, maxHeight || 0);
        const currentDim = Math.max(currentSettings.width || 0, currentSettings.height || 0);

        const currentW = currentSettings.width || 0;
        const currentH = currentSettings.height || 0;

        if (maxSupportedDim > currentDim && maxSupportedDim >= 1280 && currentW > 0 && currentH > 0) {
          // Bump resolution for quality WITHOUT forcing an aspect ratio — an
          // explicit `aspectRatio` here would make WebKit re-crop/zoom the
          // feed again, undoing the natural wide capture requested above.
          // We scale both dimensions up by the same factor, preserving
          // whatever natural (un-zoomed) ratio the device already chose.
          const scale = Math.min(maxSupportedDim, 1920) / currentDim;

          try {
            await track.applyConstraints({
              width: { ideal: Math.round(currentW * scale) },
              height: { ideal: Math.round(currentH * scale) },
            });
          } catch (refineErr) {
            console.warn('iOS applyConstraints resolution refinement skipped:', refineErr);
          }
        }
      }

      const advancedConstraints: ExtendedMediaTrackConstraintSet = {};
      let hasAdvanced = false;

      // Lock zoom to 1x if supported
      if (capabilities.zoom && typeof capabilities.zoom.min === 'number') {
        const minZ = capabilities.zoom.min;
        const maxZ = capabilities.zoom.max;
        if (1 >= minZ && 1 <= maxZ) {
          advancedConstraints.zoom = 1;
          hasAdvanced = true;
        }
      }

      if (capabilities.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        advancedConstraints.focusMode = 'continuous';
        hasAdvanced = true;
      }
      if (capabilities.exposureMode && Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
        advancedConstraints.exposureMode = 'continuous';
        hasAdvanced = true;
      }
      if (capabilities.torch === true || 'torch' in capabilities) {
        advancedConstraints.torch = true;
        hasAdvanced = true;
      }

      if (hasAdvanced) {
        try {
          await track.applyConstraints({
            advanced: [advancedConstraints as MediaTrackConstraintSet],
          });
        } catch { }
      }
    } catch (capErr) {
      console.warn('iOS Capability inspection/refinement encountered non-fatal error:', capErr);
    }
  }

  return stream;
}

const CameraCaptureIOS: React.FC<CameraCaptureProps> = ({ onClose, onCapture }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
  const [flashSupported, setFlashSupported] = useState(false);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [showEndFrame, setShowEndFrame] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTooDark, setIsTooDark] = useState(false);

  // Live brightness check while recording (1x per second, small canvas, light on CPU)
  useEffect(() => {
    if (!isRecording) { setIsTooDark(false); return; }
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!ctx || !v || !v.videoWidth) return;
      try {
        ctx.drawImage(v, 0, 0, 64, 64);
        const d = ctx.getImageData(0, 0, 64, 64).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        setIsTooDark(sum / (d.length / 4) < MIN_BRIGHTNESS);
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording]);
  const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});

  // Some iOS WebViews (in-app browsers / wrapped native shells) don't
  // reliably resolve `100dvh`, silently collapsing it to a much smaller
  // value — this is what made the preview render "small" instead of
  // filling the screen like the native Camera app. We track the real
  // viewport height in JS (visualViewport when available, since it
  // reacts correctly to iOS Safari's dynamic toolbar) and apply it as an
  // explicit pixel height, so the viewfinder always gets its full,
  // correct on-screen box — which also keeps the width-full / native
  // 1080×1920-style framing intact for the recording crop math below.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const durationIntervalRef = useRef<number | null>(null);

  const toggleFlash = async () => {
    const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
    if (!track || !flashSupported) return;

    try {
      const nextState = !isFlashOn;
      const adv: ExtendedMediaTrackConstraintSet = { torch: nextState };
      await track.applyConstraints({
        advanced: [adv as MediaTrackConstraintSet],
      });
      setIsFlashOn(nextState);
    } catch (err) {
      console.error('Failed to toggle flash/torch:', err);
    }
  };

  const extractCameraDiagnostics = useCallback((stream: MediaStream) => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    trackRef.current = track;
    const settings = track.getSettings();
    const capabilities = (typeof track.getCapabilities === 'function'
      ? track.getCapabilities()
      : {}) as ExtendedMediaTrackCapabilities;

    const actualWidth = settings.width || videoRef.current?.videoWidth;
    const actualHeight = settings.height || videoRef.current?.videoHeight;
    const actualFrameRate = settings.frameRate ? Math.round(settings.frameRate) : undefined;
    const actualAspectRatio = settings.aspectRatio || (actualWidth && actualHeight ? actualWidth / actualHeight : undefined);

    const metrics: CameraMetrics = {
      width: actualWidth,
      height: actualHeight,
      frameRate: actualFrameRate,
      aspectRatio: actualAspectRatio,
      facingMode: settings.facingMode,
      displayAspect: formatAspectRatio(actualWidth, actualHeight, actualAspectRatio),
    };

    setCameraMetrics(metrics);
    setFlashSupported(capabilities.torch === true || 'torch' in capabilities);
  }, []);

  useEffect(() => {
    if (isRecording && recordingDuration >= 2) setShowEndFrame(true);
    else if (!isRecording) setShowEndFrame(false);
  }, [recordingDuration, isRecording]);

  useEffect(() => {
    const updateViewportHeight = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      setViewportHeight(h);
    };

    updateViewportHeight();

    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await acquireAdaptiveCameraStreamIOS();

        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = async () => {
            if (cancelled) return;
            extractCameraDiagnostics(stream);
            setIsCameraReady(true);

            try {
              const capabilities = (typeof track.getCapabilities === 'function'
                ? track.getCapabilities()
                : {}) as ExtendedMediaTrackCapabilities;
              if (capabilities.torch === true || 'torch' in capabilities) {
                const adv: ExtendedMediaTrackConstraintSet = { torch: true };
                await track.applyConstraints({
                  advanced: [adv as MediaTrackConstraintSet],
                });
                setIsFlashOn(true);
              }
            } catch (torchErr) {
              console.warn('Initial flash auto-enable skipped/error:', torchErr);
            }
          };
        }
      } catch (error) {
        console.error('iOS Camera initialization failed:', error);
        alert('Camera access denied or unavailable. Please check permissions.');
        onClose();
      }
    };

    void startCamera();

    return () => {
      cancelled = true;

      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }

      if (canvasRafRef.current) {
        cancelAnimationFrame(canvasRafRef.current);
        canvasRafRef.current = null;
      }
      canvasStreamRef.current?.getTracks().forEach(t => t.stop());

      if (trackRef.current) {
        try {
          const adv: ExtendedMediaTrackConstraintSet = { torch: false };
          void trackRef.current.applyConstraints({
            advanced: [adv as MediaTrackConstraintSet],
          });
        } catch { }
      }

      streamRef.current?.getTracks().forEach(track => track.stop());

      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    };
  }, [onClose, extractCameraDiagnostics]);

  const startRecording = () => {
    if (!streamRef.current || isRecording || !isCameraReady) return;
    actuallyStartRecording();
  };

  const startCroppedCanvasRecordingIOS = (
    video: HTMLVideoElement,
    nativeWidth: number,
    nativeHeight: number,
    container: HTMLDivElement | null,
    onRecorderReady: (r: MediaRecorder) => void
  ): void => {
    const curVw = video.videoWidth || (nativeWidth <= nativeHeight ? nativeWidth : nativeHeight);
    const curVh = video.videoHeight || (nativeWidth <= nativeHeight ? nativeHeight : nativeWidth);

    // Full-bleed match: the preview fills the ENTIRE viewfinder container via
    // objectFit:'cover' (no letterbox/pillarbox), exactly like the native
    // Camera app. To make the recording look identical, we derive the crop
    // from the container's actual measured on-screen box instead of a fixed
    // 9:16 constant — this is the same math CSS object-fit:cover performs.
    const containerRect = container?.getBoundingClientRect();
    const containerAspect =
      containerRect && containerRect.width > 0 && containerRect.height > 0
        ? containerRect.width / containerRect.height
        : 9 / 16; // fallback only if container isn't measurable yet

    // The output canvas is built with this SAME aspect ratio as the crop, so
    // drawImage() scales width/height by an identical factor — no stretch.
    // Long edge pinned to 1920 for resolution/quality; width follows the
    // container's real aspect ratio. Width rounded to an even number since
    // H.264 encoders require even dimensions.
    // Cap the output to the same 1080×1920 ceiling as the native Camera
    // app — long edge (height) never exceeds 1920, short edge (width)
    // never exceeds 1080 — while still following the *actual* on-screen
    // aspect ratio (containerAspect) so the recording frames exactly what
    // the full-bleed preview showed.
    const MAX_LONG_EDGE = 1920;
    const MAX_SHORT_EDGE = 1080;

    const targetH = MAX_LONG_EDGE;
    let targetW = Math.round(targetH * containerAspect);
    targetW = Math.min(targetW, MAX_SHORT_EDGE);
    if (targetW % 2 !== 0) targetW -= 1;
    targetW = Math.max(targetW, 2);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    canvasRef.current = canvas;

    const paintFrame = () => {
      const vw = video.videoWidth || curVw;
      const vh = video.videoHeight || curVh;

      if (vw && vh) {
        // Same math as CSS object-fit:cover, against the container's real
        // aspect ratio — keeps the recorded crop identical to the full-bleed
        // preview.
        const srcRatio = vw / vh;
        let sx = 0, sy = 0, sw = vw, sh = vh;

        if (srcRatio > containerAspect) {
          sw = vh * containerAspect;
          sx = (vw - sw) / 2;
        } else {
          sh = vw / containerAspect;
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

    const mimeType = getSupportedRecorderMimeType();
    const targetBitrate = calculateAdaptiveBitrate(targetW, targetH, fps);

    let recorder: MediaRecorder | null = null;
    if (mimeType) {
      try {
        recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: targetBitrate });
      } catch {
        try {
          recorder = new MediaRecorder(canvasStream, { mimeType });
        } catch {
          recorder = null;
        }
      }
    }
    if (!recorder) {
      try {
        recorder = new MediaRecorder(canvasStream);
      } catch (err) {
        console.error('Canvas MediaRecorder initialization failed:', err);
        if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current);
        return;
      }
    }

    mimeTypeRef.current = recorder.mimeType || mimeType || 'video/mp4';
    onRecorderReady(recorder);
  };

  const actuallyStartRecording = () => {
    if (!streamRef.current || !videoRef.current) return;

    setShowEndFrame(false);

    const track = streamRef.current.getVideoTracks()[0];
    const settings = track ? track.getSettings() : {};
    const nativeWidth = settings.width || cameraMetrics.width || 1080;
    const nativeHeight = settings.height || cameraMetrics.height || 1920;

    startCroppedCanvasRecordingIOS(
      videoRef.current,
      nativeWidth,
      nativeHeight,
      containerRef.current,
      (canvasRecorder: MediaRecorder) => {
        recorderChunksRef.current = [];
        mimeTypeRef.current = canvasRecorder.mimeType || mimeTypeRef.current || 'video/mp4';
        recorderRef.current = canvasRecorder;
        recordingDurationRef.current = 0;

        canvasRecorder.ondataavailable = (event: BlobEvent) => {
          if (event.data && event.data.size > 0) recorderChunksRef.current.push(event.data);
        };
        canvasRecorder.onerror = (event) => { console.error('Canvas MediaRecorder error:', event); };
        canvasRecorder.onstop = async () => {
          if (canvasRafRef.current) {
            cancelAnimationFrame(canvasRafRef.current);
            canvasRafRef.current = null;
          }
          canvasStreamRef.current?.getTracks().forEach(t => t.stop());
          canvasStreamRef.current = null;
          canvasRef.current = null;

          const actualType = mimeTypeRef.current || 'video/mp4';
          const blob = new Blob(recorderChunksRef.current, { type: actualType });
          if (blob.size === 0) { console.error('Canvas recording produced empty video.'); alert('Recording failed – please record again.'); setIsProcessing(false); return; }
          setIsProcessing(false);
          onCapture(URL.createObjectURL(blob), actualType);
        };

        canvasRecorder.start();
      }
    );

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

  const stopRecording = () => {
    if (!isRecording) return;
    if (recordingDurationRef.current < MIN_RECORD_SECONDS) return;

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
      }, 250);
    } else {
      setIsProcessing(false);
      if (canvasRafRef.current) {
        cancelAnimationFrame(canvasRafRef.current);
        canvasRafRef.current = null;
      }
      canvasStreamRef.current?.getTracks().forEach(t => t.stop());
      canvasStreamRef.current = null;
      canvasRef.current = null;
    }
  };

  const formatDuration = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const progress = Math.min((recordingDuration / 60) * 100, 100);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#000', zIndex: 50,
      overflow: 'hidden',
      height: viewportHeight ? `${viewportHeight}px` : '100dvh',
      width: '100vw',
    }}>
      {/* ══ TOP BAR — hovers over the full-bleed preview, native-camera style,
          instead of squeezing the viewfinder into a smaller box ══ */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
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
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, letterSpacing: '0.2em', fontFamily: 'monospace' }}>
              {isRecording ? 'REC' : 'APOLLO'}
            </span>
          </div>

          <div style={{
            padding: '6px 14px', borderRadius: 20,
            background: isRecording ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}`,
          }}>
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
              {isRecording ? formatDuration(recordingDuration) : '0:00'}
            </span>
          </div>
        </div>
      </div>

      {/* ══ PORTRAIT VIEWFINDER ══ */}
      {/* position:absolute + inset:0 makes this box claim the ENTIRE screen
          (not just the leftover space between the top bar and bottom
          controls), so the video (width:100%, height:100%, objectFit:cover)
          truly fills the screen edge-to-edge like the native Camera app.
          The top bar and bottom controls are separate absolutely-positioned
          layers that hover on top of this preview instead of squeezing it
          into a smaller box — exactly like native camera UIs do. Because the
          recording crop math (startCroppedCanvasRecordingIOS) derives its
          aspect ratio from this container's real on-screen box, the
          recorded video keeps matching whatever the user actually sees. */}
      <div ref={containerRef} style={{
        position: 'absolute', inset: 0,
        overflow: 'hidden', background: '#000',
      }}>
        {flashSupported && isCameraReady && (
          <button
            onClick={toggleFlash}
            type="button"
            title={isFlashOn ? "Turn Flash OFF" : "Turn Flash ON"}
            style={{
              position: 'absolute', top: 'calc(70px + env(safe-area-inset-top, 0px))', right: 16, zIndex: 25,
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

        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
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
        </div>

        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 130% 90% at 50% 50%, transparent 30%, rgba(0,0,0,0.65) 100%)' }} />

        {/* ══ HORIZONTAL SCAN FRAME ══ */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: '92%', aspectRatio: '8 / 3',
          pointerEvents: 'none', zIndex: 15,
        }}>
          <svg viewBox="0 0 560 210" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
            <defs>
              <filter id="glowIOS">
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
              <g filter="url(#glowIOS)">
                <line x1="20" y1="10" x2="20" y2="200"
                  stroke="#00d47a" strokeWidth="2.5" opacity="0.85">
                  <animate attributeName="x1" values="20;540;20" dur="2.4s" repeatCount="indefinite" />
                  <animate attributeName="x2" values="20;540;20" dur="2.4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.4;0.95;0.4" dur="0.4s" repeatCount="indefinite" />
                </line>
              </g>
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
                <linearGradient id="startGradIOS" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowLIOS">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="0" y1="20" x2="0" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowLIOS)" />
              <path d="M 16 15 Q 0 140 16 265" fill="none" stroke="url(#startGradIOS)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowLIOS)" />
              <path d="M 24 25 Q 4 140 24 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="12" y1="50" x2="12" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowLIOS)">
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
                <linearGradient id="endGradIOS" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" />
                  <stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" />
                </linearGradient>
                <filter id="softGlowRIOS">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <line x1="100" y1="20" x2="100" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#softGlowRIOS)" />
              <path d="M 84 15 Q 100 140 84 265" fill="none" stroke="url(#endGradIOS)" strokeWidth="3.5" strokeLinecap="round" filter="url(#softGlowRIOS)" />
              <path d="M 76 25 Q 96 140 76 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
              <line x1="88" y1="50" x2="88" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#softGlowRIOS)">
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

      {/* ══ BOTTOM CONTROLS — hovers over the full-bleed preview, native-camera
          style, instead of squeezing the viewfinder into a smaller box ══ */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '12px 24px 16px', paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.4) 55%, transparent 100%)',
      }}>
        {!isRecording && isCameraReady && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 }}>
              <div style={{ display: 'flex', gap: 3 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ width: 16, height: 2, borderRadius: 1, background: `rgba(0,212,122,${0.3 + i * 0.3})` }} />
                ))}
              </div>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Hold steady · Tread runs left → right</span>
            </div>
            <div style={{ color: '#00D47A', fontSize: 12, fontWeight: 600, marginTop: 4 }}>
              Fill the box with the tread – both edges visible
            </div>
          </div>
        )}

        {isRecording && (
          <div style={{ width: '100%', maxWidth: 200 }}>
            <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 5 }}>
              <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #00c46e, #00d47a)', width: `${progress}%`, transition: 'width 1s linear' }} />
            </div>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>Recording: {formatDuration(recordingDuration)}</span>
            {recordingDuration < MIN_RECORD_SECONDS && (
              <div style={{ color: '#fbbf24', fontSize: 11, marginTop: 4 }}>Keep recording… {MIN_RECORD_SECONDS - recordingDuration}s</div>
            )}
            {isTooDark && (
              <div style={{ color: '#f87171', fontSize: 11, fontWeight: 600, marginTop: 4 }}>Too dark – turn on flash or move to light</div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px',
            borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            minWidth: 120,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d47a' }} />
              <span style={{ color: '#00d47a', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 }}>
                {cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'ADAPTIVE'}
              </span>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: 'monospace' }}>
              {cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'FPS: Auto'} • {cameraMetrics.displayAspect || '9:16'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {!isRecording ? (
              <button onClick={startRecording} disabled={!isCameraReady || isProcessing}
                style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer', opacity: (!isCameraReady || isProcessing) ? 0.4 : 1 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#00d47a', boxShadow: '0 0 20px rgba(0,212,122,0.55)' }} />
                </div>
              </button>
            ) : (
              <button onClick={stopRecording} disabled={recordingDuration < MIN_RECORD_SECONDS}
                style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: recordingDuration < MIN_RECORD_SECONDS ? 'not-allowed' : 'pointer', opacity: recordingDuration < MIN_RECORD_SECONDS ? 0.4 : 1 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid rgba(239,68,68,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.07)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: '#ef4444', boxShadow: '0 0 20px rgba(239,68,68,0.6)' }} />
                </div>
              </button>
            )}
            <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.35)', fontSize: 10, letterSpacing: '0.08em', animation: isRecording ? 'blink 1s ease-in-out infinite' : 'none' }}>
              {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING...'}
            </span>
          </div>

          <div style={{ minWidth: 120, display: 'flex', justifyContent: 'flex-end' }}>
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 9, fontFamily: 'monospace', textTransform: 'uppercase' }}>
              {cameraMetrics.facingMode || 'REAR'}
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
                Processing video for tread analysis…
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
      {/* <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid rgba(0,212,122,0.15)', animation: 'spin 12s linear infinite' }} />
        <div style={{ position: 'absolute', inset: 12, borderRadius: '50%', border: '1px dashed rgba(0,212,122,0.1)', animation: 'spin 8s linear infinite reverse' }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,212,122,0.1) 0%, transparent 70%)' }} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'phoneRotate 3s cubic-bezier(0.4,0,0.2,1) infinite' }}>
          <svg width="40" height="68" viewBox="0 0 48 82" fill="none">
            <rect x="1" y="1" width="46" height="80" rx="8" fill="rgba(0,212,122,0.06)" stroke="rgba(0,212,122,0.6)" strokeWidth="1.5" />
            <rect x="6" y="10" width="36" height="54" rx="3" fill="rgba(0,212,122,0.04)" stroke="rgba(0,212,122,0.2)" strokeWidth="1" />
            <rect x="18" y="70" width="12" height="3" rx="1.5" fill="rgba(0,212,122,0.4)" />
            <circle cx="24" cy="5.5" r="1.5" fill="rgba(0,212,122,0.3)" />
            <line x1="6" y1="37" x2="42" y2="37" stroke="rgba(0,212,122,0.3)" strokeWidth="0.8" strokeDasharray="3 2" />
          </svg>
        </div>
      </div> */}
      {/* <video autoPlay loop muted playsInline style={{ width: 160, height: 160, paddingTop: 12 }}>
        <source src={InstructionVideo} type="video/mp4" />
      </video> */}
      <img src={InstructionImg} alt="" style={{ width: 180, height: 290, marginTop: 10 }} className='border-4 border-white' />
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
              <p style={{ color: 'rgba(255,255,255,0.33)', fontSize: 13, margin: '0 0 22px' }}>Horizontal frame recording</p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                {['Portrait mode', 'Left → right tread', 'Adaptive quality'].map(f => (
                  <span key={f} style={{ padding: '4px 12px', borderRadius: 20, background: 'rgba(0,212,122,0.08)', border: '1px solid rgba(0,212,122,0.15)', color: 'rgba(0,212,122,0.8)', fontSize: 11, fontWeight: 500 }}>{f}</span>
                ))}
              </div>
            </div>
          </div>
        </button>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 28 }}>
          {[{ value: '±0.1', unit: 'mm', label: 'Accuracy' }, { value: 'Full', unit: '', label: 'Frame' }, { value: 'Adaptive', unit: '', label: 'Quality' }].map(s => (
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
            ['Tap "Start Tyre Scan"', 'Launches the guided camera scanner'],
            ['Hold phone in portrait mode', 'Tyre tread runs left → right across screen'],
            ['Align tread in wide green frame', 'START on left edge, END on right edge'],
            ['Tap scan to start, stop when done', 'Records the camera stream without canvas resizing'],
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
        isIOSDevice() ? (
          <CameraCaptureIOS
            onClose={() => setStage('home')}
            onCapture={(videoUrl, mimeType) => {
              setCapturedVideos(prev => [{ url: videoUrl, mimeType }, ...prev]);
              setStage('home');
            }}
          />
        ) : (
          <CameraCaptureAndroid
            onClose={() => setStage('home')}
            onCapture={(videoUrl, mimeType) => {
              setCapturedVideos(prev => [{ url: videoUrl, mimeType }, ...prev]);
              setStage('home');
            }}
          />
        )
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes ringPulse { 0%,100%{transform:scale(1);opacity:0.6} 50%{transform:scale(1.15);opacity:0.2} }
      `}</style>
    </div>
  );
};

export default Home;
