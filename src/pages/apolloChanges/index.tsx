/**
 * AiOverlayCaptureOverlay
 *
 * Full-screen AI-themed dark camera overlay for tyre tread video capture.
 * Ported from index_25_08_2026.tsx reference design.
 *
 * Recording pipeline:
 *   Android: Direct MediaRecorder on the live camera stream (fast path).
 *   iOS:     Canvas-crop recording via rAF compositing (always, because iOS
 *            AVFoundation delivers a wide 16:9 stream — canvas crops it to
 *            the container's real aspect ratio so recording matches preview).
 *
 * Platform detection via isIOSDevice() routes to CameraCaptureIOS or
 * CameraCaptureAndroid at runtime.
 *
 * Props interface is { open, onClose, onCapture(file: File) } — same contract
 * as TyreVideoCaptureOverlay so VideoCapture/index.ts swaps them transparently.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
// instruction_video.mp4 is served from /public/ — no import needed
const InstructionVideo = '/instruction_video.mp4';

// ─── UTILITY: DETECT IOS ──────────────────────────────────────────────────────

const isIOSDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
};

// ─── TYPES ───────────────────────────────────────────────────────────────────

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
}

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
    torch?: boolean;
    focusMode?: string[];
    exposureMode?: string[];
}

interface CameraCaptureProps {
    onCapture: (videoUrl: string, mimeType: string) => void;
    onClose: () => void;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const formatAspectRatio = (
    width?: number, height?: number, rawAspect?: number,
): string => {
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
    return ratio < 1
        ? `${width}:${height} (${ratio.toFixed(2)})`
        : `${height}:${width} (${ratio.toFixed(2)})`;
};

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

const calculateAdaptiveBitrate = (
    width?: number, height?: number, frameRate?: number,
): number => {
    const w = width || 1080;
    const h = height || 1920;
    const fps = frameRate || 30;
    const targetBitrate = Math.round(w * h * fps * 0.10);
    return Math.min(Math.max(targetBitrate, 1_500_000), 8_000_000);
};

/**
 * Patches EBML Duration metadata into a WebM Blob so Android/Samsung Gallery
 * can determine duration and seek without "Can't play video" errors.
 */
async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
    if (durationMs <= 0) return blob;
    try {
        const buffer = await blob.arrayBuffer();
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length - 12; i++) {
            if (
                bytes[i] === 0x15 && bytes[i + 1] === 0x49 &&
                bytes[i + 2] === 0xa9 && bytes[i + 3] === 0x66
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
        console.warn('[AiOverlay] WebM duration patch skipped:', err);
    }
    return blob;
}

// ─── ANDROID CAMERA ACQUISITION ──────────────────────────────────────────────

async function acquireAdaptiveCameraStreamAndroid(): Promise<MediaStream> {
    const constraintProfiles: MediaStreamConstraints[] = [
        // 1. Full HD portrait (1080x1920, 9:16)
        {
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 }, frameRate: { ideal: 30, min: 15 } },
            audio: false,
        },
        // 2. HD portrait (720x1280, 9:16)
        {
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 1280 }, aspectRatio: { ideal: 9 / 16 }, frameRate: { ideal: 30 } },
            audio: false,
        },
        // 3. Lower-quality 9:16 fallback (576x1024, 9:16)
        {
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 576 }, height: { ideal: 1024 }, aspectRatio: { ideal: 9 / 16 }, frameRate: { ideal: 30 } },
            audio: false,
        },
        // 4. Generic 9:16 portrait
        { video: { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 9 / 16 } }, audio: false },
        // 5. Generic environment
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        // 6. Generic video
        { video: true, audio: false },
    ];

    let stream: MediaStream | null = null;
    let lastError: unknown = null;
    for (const constraints of constraintProfiles) {
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (stream && stream.getVideoTracks().length > 0) break;
        } catch (err) { lastError = err; }
    }
    if (!stream) throw lastError || new Error('Failed to acquire camera stream');

    const track = stream.getVideoTracks()[0];
    if (track) {
        try {
            const capabilities = (typeof track.getCapabilities === 'function'
                ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
            const currentSettings = track.getSettings();

            if (capabilities.height && capabilities.width) {
                const maxHeight = typeof capabilities.height === 'object' && 'max' in capabilities.height
                    ? (capabilities.height as { max?: number }).max : undefined;
                const maxWidth = typeof capabilities.width === 'object' && 'max' in capabilities.width
                    ? (capabilities.width as { max?: number }).max : undefined;
                const currentDim = Math.max(currentSettings.width || 0, currentSettings.height || 0);
                const maxSupportedDim = Math.max(maxWidth || 0, maxHeight || 0);
                if (maxSupportedDim > currentDim && maxSupportedDim >= 1024) {
                    const targetLong = Math.min(maxSupportedDim, 1920);
                    const targetShort = Math.round(targetLong * (9 / 16));
                    try {
                        // Always force 9:16 portrait dimensions
                        await track.applyConstraints({
                            width: { ideal: targetShort },
                            height: { ideal: targetLong },
                            aspectRatio: { ideal: 9 / 16 },
                        });
                    } catch (refineErr) { console.warn('[AiOverlay] Android resolution refinement skipped:', refineErr); }
                }
            }

            const advancedConstraints: ExtendedMediaTrackConstraintSet = {};
            let hasAdvanced = false;
            if (capabilities.focusMode?.includes('continuous')) { advancedConstraints.focusMode = 'continuous'; hasAdvanced = true; }
            if (capabilities.exposureMode?.includes('continuous')) { advancedConstraints.exposureMode = 'continuous'; hasAdvanced = true; }
            if (capabilities.torch === true || 'torch' in capabilities) { advancedConstraints.torch = true; hasAdvanced = true; }
            if (hasAdvanced) {
                try { await track.applyConstraints({ advanced: [advancedConstraints as MediaTrackConstraintSet] }); } catch { /* ignore */ }
            }
        } catch (capErr) { console.warn('[AiOverlay] Android capability refinement non-fatal:', capErr); }
    }
    return stream;
}

// ─── IOS CAMERA ACQUISITION ───────────────────────────────────────────────────
// NOTE: iOS/AVFoundation has no native 9:16 capture preset. Requesting
// aspectRatio:9/16 forces a digital zoom/crop BEFORE this app sees any frame,
// making the preview look zoomed-in. We request the natural wide capture
// (1920×1080) instead and let object-fit:cover + canvas crop handle portrait
// framing in software — same approach as the native iOS Camera app.

async function acquireAdaptiveCameraStreamIOS(): Promise<MediaStream> {
    const constraintProfiles: MediaStreamConstraints[] = [
        // 1. Full HD wide — natural iOS video preset, no forced crop-zoom.
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, min: 24 } }, audio: false },
        // 2. HD wide fallback.
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false },
        // 3. Generic environment — whatever natural (un-zoomed) mode the device defaults to.
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        { video: true, audio: false },
    ];

    let stream: MediaStream | null = null;
    let lastError: unknown = null;
    for (const constraints of constraintProfiles) {
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (stream && stream.getVideoTracks().length > 0) break;
        } catch (err) { lastError = err; }
    }
    if (!stream) throw lastError || new Error('Failed to acquire iOS camera stream');

    const track = stream.getVideoTracks()[0];
    if (track) {
        try {
            const capabilities = (typeof track.getCapabilities === 'function'
                ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
            const currentSettings = track.getSettings();

            if (capabilities.height && capabilities.width) {
                const maxHeight = typeof capabilities.height === 'object' && 'max' in capabilities.height
                    ? (capabilities.height as { max?: number }).max : undefined;
                const maxWidth = typeof capabilities.width === 'object' && 'max' in capabilities.width
                    ? (capabilities.width as { max?: number }).max : undefined;
                const maxSupportedDim = Math.max(maxWidth || 0, maxHeight || 0);
                const currentDim = Math.max(currentSettings.width || 0, currentSettings.height || 0);
                const currentW = currentSettings.width || 0;
                const currentH = currentSettings.height || 0;
                // Scale both dims by the same factor — preserves natural aspect ratio,
                // no forced re-crop. No aspectRatio constraint (would re-trigger zoom).
                if (maxSupportedDim > currentDim && maxSupportedDim >= 1280 && currentW > 0 && currentH > 0) {
                    const scale = Math.min(maxSupportedDim, 1920) / currentDim;
                    try {
                        await track.applyConstraints({
                            width: { ideal: Math.round(currentW * scale) },
                            height: { ideal: Math.round(currentH * scale) },
                        });
                    } catch (refineErr) { console.warn('[AiOverlay] iOS resolution refinement skipped:', refineErr); }
                }
            }

            const advancedConstraints: ExtendedMediaTrackConstraintSet = {};
            let hasAdvanced = false;
            if (capabilities.focusMode?.includes('continuous')) { advancedConstraints.focusMode = 'continuous'; hasAdvanced = true; }
            if (capabilities.exposureMode?.includes('continuous')) { advancedConstraints.exposureMode = 'continuous'; hasAdvanced = true; }
            if (capabilities.torch === true || 'torch' in capabilities) { advancedConstraints.torch = true; hasAdvanced = true; }
            if (hasAdvanced) {
                try { await track.applyConstraints({ advanced: [advancedConstraints as MediaTrackConstraintSet] }); } catch { /* ignore */ }
            }
        } catch (capErr) { console.warn('[AiOverlay] iOS capability refinement non-fatal:', capErr); }
    }
    return stream;
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── ANDROID CAMERA CAPTURE ──────────────────────────────────────────────────
// Direct stream recording (fast path) when native portrait stream is available.
// Automatic Canvas Crop fallback when sensor delivers landscape stream,
// guaranteeing a 1080x1920 vertical portrait output video.
// The stream is acquired once by the parent (AiOverlayCaptureOverlay) and
// passed in as a prop — it stays alive across record/stop/retake cycles so
// the camera hardware negotiation never runs twice, keeping resolution stable.
// ═════════════════════════════════════════════════════════════════════════════

interface CameraCaptureAndroidProps extends CameraCaptureProps {
    stream: MediaStream;
}

function CameraCaptureAndroid({ onClose, onCapture, stream }: CameraCaptureAndroidProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    // streamRef points to the parent-owned stream — never stopped here
    const streamRef = useRef<MediaStream>(stream);
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
    const [scanPct, setScanPct] = useState(0);
    const [flashSupported, setFlashSupported] = useState(false);
    const [isFlashOn, setIsFlashOn] = useState(false);
    const [showEndFrame, setShowEndFrame] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});

    const durationIntervalRef = useRef<number | null>(null);

    const toggleFlash = async () => {
        const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
        if (!track || !flashSupported) return;
        try {
            const nextState = !isFlashOn;
            await track.applyConstraints({ advanced: [{ torch: nextState } as MediaTrackConstraintSet] });
            setIsFlashOn(nextState);
        } catch (err) { console.error('[AiOverlay] Flash toggle failed:', err); }
    };

    const extractCameraDiagnostics = useCallback((stream: MediaStream) => {
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        trackRef.current = track;
        const settings = track.getSettings();
        const capabilities = (typeof track.getCapabilities === 'function'
            ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
        const actualWidth = settings.width || videoRef.current?.videoWidth;
        const actualHeight = settings.height || videoRef.current?.videoHeight;
        const actualFrameRate = settings.frameRate ? Math.round(settings.frameRate) : undefined;
        const actualAspectRatio = settings.aspectRatio ||
            (actualWidth && actualHeight ? actualWidth / actualHeight : undefined);
        setCameraMetrics({
            width: actualWidth, height: actualHeight, frameRate: actualFrameRate,
            aspectRatio: actualAspectRatio, facingMode: settings.facingMode,
            displayAspect: formatAspectRatio(actualWidth, actualHeight, actualAspectRatio),
        });
        setFlashSupported(capabilities.torch === true || 'torch' in capabilities);
    }, []);

    // Scan line animation
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

    // End-frame indicator (show after 2 s of recording)
    useEffect(() => {
        if (isRecording && recordingDuration >= 2) setShowEndFrame(true);
        else if (!isRecording) setShowEndFrame(false);
    }, [recordingDuration, isRecording]);

    // Wire the parent-owned stream to the <video> element.
    // The stream is already live — no getUserMedia call here.
    // We do NOT stop the stream on unmount; the parent controls its lifetime.
    useEffect(() => {
        let cancelled = false;
        const s = streamRef.current;

        const attachStream = async () => {
            if (!videoRef.current) return;
            videoRef.current.srcObject = s;
            videoRef.current.onloadedmetadata = async () => {
                if (cancelled) return;
                extractCameraDiagnostics(s);
                setIsCameraReady(true);
                try {
                    const track = s.getVideoTracks()[0];
                    const caps = (typeof track.getCapabilities === 'function'
                        ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
                    if (caps.torch === true || 'torch' in caps) {
                        await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
                        setIsFlashOn(true);
                    }
                } catch (torchErr) { console.warn('[AiOverlay] Android torch skipped:', torchErr); }
            };
            // If metadata already loaded (stream reused across retake), fire immediately
            if (videoRef.current.readyState >= 1) {
                videoRef.current.onloadedmetadata?.(new Event('loadedmetadata'));
            }
        };

        void attachStream();

        return () => {
            cancelled = true;
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
            canvasStreamRef.current?.getTracks().forEach(t => t.stop());
            canvasStreamRef.current = null;
            canvasRef.current = null;

            // Turn off torch on unmount — parent still owns the track
            if (trackRef.current) {
                try { void trackRef.current.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }); } catch { /* ignore */ }
            }
            if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; }
        };
    }, [extractCameraDiagnostics]);

    // Direct recording for native portrait streams (Fast path, zero overhead)
    const startDirectMediaRecorder = (): boolean => {
        const stream = streamRef.current;
        if (!stream) return false;
        const track = stream.getVideoTracks()[0];
        const settings = track ? track.getSettings() : {};
        const nativeWidth = settings.width || cameraMetrics.width || 1080;
        const nativeHeight = settings.height || cameraMetrics.height || 1920;
        const mimeType = getSupportedRecorderMimeType();
        const targetBitrate = calculateAdaptiveBitrate(nativeWidth, nativeHeight, settings.frameRate || cameraMetrics.frameRate);

        let recorder: MediaRecorder | null = null;
        if (mimeType) {
            try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate }); }
            catch { try { recorder = new MediaRecorder(stream, { mimeType }); } catch { recorder = null; } }
        }
        if (!recorder) {
            try { recorder = new MediaRecorder(stream); }
            catch (err) { console.error('[AiOverlay] Android MediaRecorder init failed:', err); return false; }
        }

        recorderChunksRef.current = [];
        mimeTypeRef.current = recorder.mimeType || mimeType || 'video/webm';
        recorderRef.current = recorder;
        recordingDurationRef.current = 0;

        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) recorderChunksRef.current.push(event.data);
        };
        recorder.onerror = (event) => { console.error('[AiOverlay] Android MediaRecorder error:', event); };
        recorder.onstop = async () => {
            const actualType = mimeTypeRef.current || 'video/webm';
            let blob = new Blob(recorderChunksRef.current, { type: actualType });
            if (blob.size === 0) { console.error('[AiOverlay] Android recording empty.'); setIsProcessing(false); return; }
            if (actualType.includes('webm')) {
                blob = await fixWebmDuration(blob, (recordingDurationRef.current || 1) * 1000);
            }
            setIsProcessing(false);
            onCapture(URL.createObjectURL(blob), actualType);
        };
        recorder.start();
        return true;
    };

    // Canvas crop fallback for landscape sensor streams (Guarantees 1080x1920 vertical portrait)
    const startCroppedCanvasRecordingAndroid = (
        video: HTMLVideoElement,
        nativeWidth: number,
        nativeHeight: number,
        container: HTMLDivElement | null,
        onRecorderReady: (r: MediaRecorder) => void,
    ): void => {
        const curVw = video.videoWidth || (nativeWidth <= nativeHeight ? nativeWidth : nativeHeight);
        const curVh = video.videoHeight || (nativeWidth <= nativeHeight ? nativeHeight : nativeWidth);

        const containerRect = container?.getBoundingClientRect();
        const containerAspect =
            containerRect && containerRect.width > 0 && containerRect.height > 0
                ? containerRect.width / containerRect.height
                : 9 / 16;

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
                const srcRatio = vw / vh;
                let sx = 0, sy = 0, sw = vw, sh = vh;
                if (srcRatio > containerAspect) { sw = vh * containerAspect; sx = (vw - sw) / 2; }
                else { sh = vw / containerAspect; sy = (vh - sh) / 2; }
                ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
            }
        };
        paintFrame();
        const drawLoop = () => { paintFrame(); canvasRafRef.current = requestAnimationFrame(drawLoop); };
        canvasRafRef.current = requestAnimationFrame(drawLoop);

        const fps = 30;
        const canvasStream = canvas.captureStream(fps);
        canvasStreamRef.current = canvasStream;
        const mimeType = getSupportedRecorderMimeType();
        const targetBitrate = calculateAdaptiveBitrate(targetW, targetH, fps);

        let recorder: MediaRecorder | null = null;
        if (mimeType) {
            try { recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: targetBitrate }); }
            catch { try { recorder = new MediaRecorder(canvasStream, { mimeType }); } catch { recorder = null; } }
        }
        if (!recorder) {
            try { recorder = new MediaRecorder(canvasStream); }
            catch (err) { console.error('[AiOverlay] Android canvas MediaRecorder init failed:', err); if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current); return; }
        }
        mimeTypeRef.current = recorder.mimeType || mimeType || 'video/webm';
        onRecorderReady(recorder);
    };

    const actuallyStartRecording = () => {
        if (!streamRef.current || !videoRef.current) return;
        setShowEndFrame(false);

        const track = streamRef.current.getVideoTracks()[0];
        const settings = track ? track.getSettings() : {};
        const nativeWidth = settings.width || videoRef.current.videoWidth || cameraMetrics.width || 1080;
        const nativeHeight = settings.height || videoRef.current.videoHeight || cameraMetrics.height || 1920;

        // Smart routing:
        // If the hardware delivered a landscape feed (width > height), route through Canvas Crop
        // to guarantee a 1080x1920 portrait video matching the viewfinder.
        // If already portrait (height >= width), use fast direct stream recording.
        const isLandscapeStream = nativeWidth > nativeHeight;

        if (isLandscapeStream) {
            startCroppedCanvasRecordingAndroid(
                videoRef.current,
                nativeWidth,
                nativeHeight,
                containerRef.current,
                (canvasRecorder: MediaRecorder) => {
                    recorderChunksRef.current = [];
                    mimeTypeRef.current = canvasRecorder.mimeType || mimeTypeRef.current || 'video/webm';
                    recorderRef.current = canvasRecorder;
                    recordingDurationRef.current = 0;

                    canvasRecorder.ondataavailable = (event: BlobEvent) => {
                        if (event.data && event.data.size > 0) recorderChunksRef.current.push(event.data);
                    };
                    canvasRecorder.onerror = (event) => { console.error('[AiOverlay] Android canvas MediaRecorder error:', event); };
                    canvasRecorder.onstop = async () => {
                        if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
                        canvasStreamRef.current?.getTracks().forEach(t => t.stop());
                        canvasStreamRef.current = null;
                        canvasRef.current = null;

                        const actualType = mimeTypeRef.current || 'video/webm';
                        let blob = new Blob(recorderChunksRef.current, { type: actualType });
                        if (blob.size === 0) { console.error('[AiOverlay] Android canvas recording empty.'); setIsProcessing(false); return; }
                        if (actualType.includes('webm')) {
                            blob = await fixWebmDuration(blob, (recordingDurationRef.current || 1) * 1000);
                        }
                        setIsProcessing(false);
                        onCapture(URL.createObjectURL(blob), actualType);
                    };
                    canvasRecorder.start();
                }
            );
        } else {
            const started = startDirectMediaRecorder();
            if (!started) { setIsProcessing(false); alert('Unable to record on this device.'); return; }
        }

        if ('vibrate' in navigator) navigator.vibrate(200);
        setRecordingDuration(0);
        recordingDurationRef.current = 0;
        durationIntervalRef.current = window.setInterval(() => {
            setRecordingDuration(prev => { const n = prev + 1; recordingDurationRef.current = n; return n; });
        }, 1000);
        setIsRecording(true);
    };

    const startRecording = () => {
        if (!streamRef.current || isRecording || !isCameraReady) return;
        actuallyStartRecording();
    };

    const stopRecording = () => {
        if (!isRecording) return;
        if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; }
        setIsRecording(false);
        setShowEndFrame(false);
        setIsProcessing(true);
        const recorder = recorderRef.current;
        if (recorder?.state === 'recording') {
            recorder.stop();
        } else {
            setIsProcessing(false);
            if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
            canvasStreamRef.current?.getTracks().forEach(t => t.stop());
            canvasStreamRef.current = null;
            canvasRef.current = null;
        }
    };

    const formatDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    const progress = Math.min((recordingDuration / 60) * 100, 100);

    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#000', zIndex: 50, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', overflow: 'hidden', height: '100dvh', width: '100vw' }}>

            {/* ══ TOP BAR ══ */}
            <div style={{ background: '#000', zIndex: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px' }}>
                    <button onClick={onClose} disabled={isRecording || isProcessing} style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: (isRecording || isProcessing) ? 'rgba(255,255,255,0.25)' : 'white', fontSize: 18, cursor: (isRecording || isProcessing) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: isRecording ? '#ef4444' : '#00d47a', boxShadow: isRecording ? '0 0 8px rgba(239,68,68,0.9)' : '0 0 8px rgba(0,212,122,0.9)', animation: 'aio-blink 1s ease-in-out infinite' }} />
                        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, letterSpacing: '0.2em', fontFamily: 'monospace' }}>{isRecording ? 'REC' : 'APOLLO'}</span>
                    </div>
                    <div style={{ padding: '6px 14px', borderRadius: 20, background: isRecording ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.08)', border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}` }}>
                        <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>{isRecording ? formatDuration(recordingDuration) : '0:00'}</span>
                    </div>
                </div>
            </div>

            {/* ══ VIEWFINDER ══ */}
            <div ref={containerRef} style={{ position: 'relative', width: '100%', flex: 1, overflow: 'hidden', background: '#000' }}>
                {flashSupported && isCameraReady && (
                    <button onClick={() => void toggleFlash()} type="button" title={isFlashOn ? 'Turn Flash OFF' : 'Turn Flash ON'} style={{ position: 'absolute', top: 16, right: 16, zIndex: 25, display: 'flex', alignItems: 'center', gap: 8, background: isFlashOn ? 'rgba(255,215,0,0.22)' : 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', padding: '8px 14px', borderRadius: 20, border: isFlashOn ? '1px solid #FFD700' : '1px solid rgba(255,255,255,0.2)', color: isFlashOn ? '#FFD700' : 'rgba(255,255,255,0.85)', cursor: 'pointer', boxShadow: isFlashOn ? '0 0 14px rgba(255,215,0,0.5)' : '0 2px 8px rgba(0,0,0,0.3)', transition: 'all 0.2s ease' }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill={isFlashOn ? '#FFD700' : 'none'} stroke={isFlashOn ? '#FFD700' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', fontFamily: 'monospace' }}>{isFlashOn ? 'FLASH ON' : 'FLASH OFF'}</span>
                    </button>
                )}

                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>

                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 130% 90% at 50% 50%, transparent 30%, rgba(0,0,0,0.65) 100%)' }} />

                {/* ══ HORIZONTAL SCAN FRAME ══ */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: '92%', aspectRatio: '8 / 3', pointerEvents: 'none', zIndex: 15 }}>
                    <svg viewBox="0 0 560 210" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
                        <defs>
                            <filter id="aio-glowAndroid"><feGaussianBlur stdDeviation="2" result="coloredBlur" /><feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                        </defs>
                        <rect x="4" y="4" width="552" height="202" rx="12" fill="rgba(0,212,122,0.03)" />
                        {[112, 187, 280, 373, 448].map((x, i) => (
                            <line key={x} x1={x} y1="12" x2={x} y2="198" stroke="#00d47a" strokeWidth={i === 2 ? 1.2 : 0.6} opacity={i === 2 ? 0.35 : 0.12} strokeDasharray={i === 2 ? undefined : '4 6'} />
                        ))}
                        <circle cx="280" cy="105" r="8" fill="none" stroke="#00d47a" strokeWidth="1.5" opacity="0.7"><animate attributeName="opacity" values="0.2;0.9;0.2" dur="2s" repeatCount="indefinite" /></circle>
                        <circle cx="280" cy="105" r="3" fill="#00d47a" opacity="0.5"><animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite" /></circle>
                        <line x1="262" y1="105" x2="298" y2="105" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
                        <line x1="280" y1="87" x2="280" y2="123" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
                        {[112, 187, 280, 373, 448].map((x, i) => (
                            <g key={`tk${x}`}>
                                <line x1={x} y1="10" x2={x} y2={i === 2 ? 20 : 17} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
                                <line x1={x} y1="200" x2={x} y2={i === 2 ? 190 : 193} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
                            </g>
                        ))}
                        {isRecording && (
                            <line x1={scanPct * 5.6} y1="10" x2={scanPct * 5.6} y2="200" stroke="#00d47a" strokeWidth="2.5" opacity="0.85" filter="url(#aio-glowAndroid)">
                                <animate attributeName="opacity" values="0.3;0.95;0.3" dur="0.4s" repeatCount="indefinite" />
                            </line>
                        )}
                        <rect x="8" y="8" width="544" height="194" rx="8" fill="none" stroke="rgba(0,212,122,0.25)" strokeWidth="1" strokeDasharray="8 6" style={{ animation: 'aio-dashMove 4s linear infinite' }} />
                        <g>
                            <line x1="10" y1="105" x2="252" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? '0.9' : '0.55'} strokeLinecap="round" />
                            <line x1="308" y1="105" x2="550" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? '0.9' : '0.55'} strokeLinecap="round" />
                            <polygon points="280,98 287,105 280,112 273,105" fill="none" stroke="#00d47a" strokeWidth="1.5" strokeOpacity={isRecording ? '1' : '0.7'} />
                            <polygon points="280,102 284,105 280,108 276,105" fill="#00d47a" fillOpacity={isRecording ? '0.9' : '0.4'} />
                            <text x="280" y="124" fill="#00d47a" fontSize="8" fontWeight="600" textAnchor="middle" opacity={isRecording ? '0' : '0.5'} style={{ fontFamily: 'monospace', letterSpacing: '1.5px' }}>LEVEL</text>
                        </g>
                    </svg>

                    <div style={{ position: 'absolute', top: -32, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', padding: '4px 12px', borderRadius: 20, border: '1px solid rgba(0,212,122,0.3)' }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: isRecording ? '#ef4444' : '#00d47a', boxShadow: `0 0 6px ${isRecording ? '#ef4444' : '#00d47a'}`, animation: 'aio-blink 1s ease-in-out infinite' }} />
                        <span style={{ color: '#00d47a', fontSize: 10, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', fontFamily: 'monospace' }}>{isRecording ? 'RECORDING' : 'ALIGN TYRE TREAD'}</span>
                    </div>
                </div>

                {/* ══ LEFT EDGE — START FRAME ══ */}
                {(!isRecording || (isRecording && !showEndFrame)) && (
                    <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
                        <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                            <defs>
                                <linearGradient id="aio-startGradA" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" /><stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" /><stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" /></linearGradient>
                                <filter id="aio-softGlowLA"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                            </defs>
                            <line x1="0" y1="20" x2="0" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#aio-softGlowLA)" />
                            <path d="M 16 15 Q 0 140 16 265" fill="none" stroke="url(#aio-startGradA)" strokeWidth="3.5" strokeLinecap="round" filter="url(#aio-softGlowLA)" />
                            <path d="M 24 25 Q 4 140 24 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                            <line x1="12" y1="50" x2="12" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#aio-softGlowLA)">{isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}</line>
                            <polygon points="14,134 14,146 30,140" fill="#00d47a" opacity="0.95">{!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}</polygon>
                            <text x="36" y="144" fill="#00d47a" fontSize="11" fontWeight="700" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>START</text>
                            {isRecording && (<><line x1="30" y1="140" x2="52" y2="140" stroke="#00d47a" strokeWidth="2" opacity="0.5" strokeDasharray="6 4"><animate attributeName="stroke-dashoffset" from="0" to="-20" dur="1s" repeatCount="indefinite" /></line><polygon points="46,136 52,140 46,144" fill="#00d47a" opacity="0.7"><animate attributeName="opacity" values="0.3;0.9;0.3" dur="0.8s" repeatCount="indefinite" /></polygon></>)}
                            {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (<line key={y} x1="0" y1={y} x2="14" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />))}
                        </svg>
                    </div>
                )}

                {/* ══ RIGHT EDGE — END FRAME ══ */}
                {isRecording && showEndFrame && (
                    <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
                        <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                            <defs>
                                <linearGradient id="aio-endGradA" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" /><stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" /><stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" /></linearGradient>
                                <filter id="aio-softGlowRA"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                            </defs>
                            <line x1="100" y1="20" x2="100" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#aio-softGlowRA)" />
                            <path d="M 84 15 Q 100 140 84 265" fill="none" stroke="url(#aio-endGradA)" strokeWidth="3.5" strokeLinecap="round" filter="url(#aio-softGlowRA)" />
                            <path d="M 76 25 Q 96 140 76 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                            <line x1="88" y1="50" x2="88" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#aio-softGlowRA)">{isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}</line>
                            <polygon points="86,134 86,146 70,140" fill="#00d47a" opacity="0.95">{!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}</polygon>
                            <text x="64" y="144" fill="#00d47a" fontSize="11" fontWeight="700" textAnchor="end" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>END</text>
                            {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (<line key={y} x1="100" y1={y} x2="86" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />))}
                        </svg>
                    </div>
                )}
            </div>{/* end viewfinder */}

            {/* ══ BOTTOM CONTROLS ══ */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 24px 16px', background: '#000' }}>
                {!isRecording && isCameraReady && (
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 }}>
                            <div style={{ display: 'flex', gap: 3 }}>{[0, 1, 2].map(i => (<div key={i} style={{ width: 16, height: 2, borderRadius: 1, background: `rgba(0,212,122,${0.3 + i * 0.3})` }} />))}</div>
                            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Hold steady · Tread runs left → right</span>
                        </div>
                    </div>
                )}
                {isRecording && (
                    <div style={{ width: '100%', maxWidth: 200 }}>
                        <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 5 }}>
                            <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #00c46e, #00d47a)', width: `${progress}%`, transition: 'width 1s linear' }} />
                        </div>
                        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>Recording: {formatDuration(recordingDuration)}</span>
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 120 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d47a' }} />
                            <span style={{ color: '#00d47a', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 }}>{cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'ADAPTIVE'}</span>
                        </div>
                        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: 'monospace' }}>{cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'FPS: Auto'} • {cameraMetrics.displayAspect || '9:16'}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        {!isRecording ? (
                            <button onClick={startRecording} disabled={!isCameraReady || isProcessing} style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer', opacity: (!isCameraReady || isProcessing) ? 0.4 : 1 }}>
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
                        <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.35)', fontSize: 10, letterSpacing: '0.08em', animation: isRecording ? 'aio-blink 1s ease-in-out infinite' : 'none' }}>
                            {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING...'}
                        </span>
                    </div>
                    <div style={{ minWidth: 120, display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 9, fontFamily: 'monospace', textTransform: 'uppercase' }}>{cameraMetrics.facingMode || 'REAR'}</span>
                    </div>
                </div>
            </div>

            {/* ══ PROCESSING OVERLAY ══ */}
            {isProcessing && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, animation: 'aio-fadeIn 0.3s ease' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, animation: 'aio-scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)', padding: '40px 20px', maxWidth: 500, width: '100%' }}>
                        <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(0,212,122,0.12)', border: '2px solid rgba(0,212,122,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ width: 32, height: 32, border: '3px solid rgba(0,212,122,0.25)', borderTopColor: '#00d47a', borderRadius: '50%', animation: 'aio-spin 0.9s linear infinite' }} />
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <p style={{ color: 'white', fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>Finalising Scan</p>
                            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, margin: 0 }}>Processing video for tread analysis…</p>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        @keyframes aio-dashMove { to { stroke-dashoffset: -30; } }
        @keyframes aio-blink    { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes aio-fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes aio-scaleIn  { from{transform:scale(0.5);opacity:0} 60%{transform:scale(1.06)} to{transform:scale(1);opacity:1} }
        @keyframes aio-spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
        </div>
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── IOS CAMERA CAPTURE ───────────────────────────────────────────────────────
// Canvas-crop recording — ALWAYS used on iOS. The viewfinder fills the full
// screen (position:absolute+inset:0) with top/bottom controls as overlapping
// absolute layers, matching the native iOS Camera app layout.
// visualViewport height tracking fixes iOS WebView 100dvh collapse bug.
// ═════════════════════════════════════════════════════════════════════════════

function CameraCaptureIOS({ onClose, onCapture }: CameraCaptureProps) {
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
    const [cameraMetrics, setCameraMetrics] = useState<CameraMetrics>({});
    // Tracks real viewport height — fixes iOS WebView 100dvh collapse
    const [viewportHeight, setViewportHeight] = useState<number | null>(null);

    const durationIntervalRef = useRef<number | null>(null);

    const toggleFlash = async () => {
        const track = trackRef.current || streamRef.current?.getVideoTracks()[0];
        if (!track || !flashSupported) return;
        try {
            const nextState = !isFlashOn;
            await track.applyConstraints({ advanced: [{ torch: nextState } as MediaTrackConstraintSet] });
            setIsFlashOn(nextState);
        } catch (err) { console.error('[AiOverlay] iOS flash toggle failed:', err); }
    };

    const extractCameraDiagnostics = useCallback((stream: MediaStream) => {
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        trackRef.current = track;
        const settings = track.getSettings();
        const capabilities = (typeof track.getCapabilities === 'function'
            ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
        const actualWidth = settings.width || videoRef.current?.videoWidth;
        const actualHeight = settings.height || videoRef.current?.videoHeight;
        const actualFrameRate = settings.frameRate ? Math.round(settings.frameRate) : undefined;
        const actualAspectRatio = settings.aspectRatio ||
            (actualWidth && actualHeight ? actualWidth / actualHeight : undefined);
        setCameraMetrics({
            width: actualWidth, height: actualHeight, frameRate: actualFrameRate,
            aspectRatio: actualAspectRatio, facingMode: settings.facingMode,
            displayAspect: formatAspectRatio(actualWidth, actualHeight, actualAspectRatio),
        });
        setFlashSupported(capabilities.torch === true || 'torch' in capabilities);
    }, []);

    // End-frame indicator
    useEffect(() => {
        if (isRecording && recordingDuration >= 2) setShowEndFrame(true);
        else if (!isRecording) setShowEndFrame(false);
    }, [recordingDuration, isRecording]);

    // visualViewport height tracking (fixes iOS WebView 100dvh collapse)
    useEffect(() => {
        const update = () => {
            const h = window.visualViewport?.height ?? window.innerHeight;
            setViewportHeight(h);
        };
        update();
        window.visualViewport?.addEventListener('resize', update);
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        return () => {
            window.visualViewport?.removeEventListener('resize', update);
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
        };
    }, []);

    // Camera init / teardown
    useEffect(() => {
        let cancelled = false;
        const startCamera = async () => {
            try {
                const stream = await acquireAdaptiveCameraStreamIOS();
                if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
                streamRef.current = stream;
                trackRef.current = stream.getVideoTracks()[0];
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.onloadedmetadata = async () => {
                        if (cancelled) return;
                        extractCameraDiagnostics(stream);
                        setIsCameraReady(true);
                        try {
                            const track = stream.getVideoTracks()[0];
                            const caps = (typeof track.getCapabilities === 'function'
                                ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
                            if (caps.torch === true || 'torch' in caps) {
                                await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
                                setIsFlashOn(true);
                            }
                        } catch (torchErr) { console.warn('[AiOverlay] iOS initial torch skipped:', torchErr); }
                    };
                }
            } catch (error) {
                console.error('[AiOverlay] iOS camera init failed:', error);
                alert('Camera access denied or unavailable. Please check permissions.');
                onClose();
            }
        };
        void startCamera();
        return () => {
            cancelled = true;
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
            canvasStreamRef.current?.getTracks().forEach(t => t.stop());
            if (trackRef.current) {
                try { void trackRef.current.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }); } catch { /* ignore */ }
            }
            streamRef.current?.getTracks().forEach(t => t.stop());
            if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; }
        };
    }, [onClose, extractCameraDiagnostics]);

    // Canvas crop recording — always used on iOS
    const startCroppedCanvasRecordingIOS = (
        video: HTMLVideoElement,
        nativeWidth: number,
        nativeHeight: number,
        container: HTMLDivElement | null,
        onRecorderReady: (r: MediaRecorder) => void,
    ): void => {
        const curVw = video.videoWidth || (nativeWidth <= nativeHeight ? nativeWidth : nativeHeight);
        const curVh = video.videoHeight || (nativeWidth <= nativeHeight ? nativeHeight : nativeWidth);

        // Derive crop from container's real on-screen box — same math as CSS object-fit:cover.
        const containerRect = container?.getBoundingClientRect();
        const containerAspect =
            containerRect && containerRect.width > 0 && containerRect.height > 0
                ? containerRect.width / containerRect.height
                : 9 / 16;

        // Long edge pinned to 1920, short edge follows real container aspect.
        // Width forced to even (H.264 requirement). Capped at 1080.
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
                const srcRatio = vw / vh;
                let sx = 0, sy = 0, sw = vw, sh = vh;
                if (srcRatio > containerAspect) { sw = vh * containerAspect; sx = (vw - sw) / 2; }
                else { sh = vw / containerAspect; sy = (vh - sh) / 2; }
                ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
            }
        };
        paintFrame();
        const drawLoop = () => { paintFrame(); canvasRafRef.current = requestAnimationFrame(drawLoop); };
        canvasRafRef.current = requestAnimationFrame(drawLoop);

        const fps = 30;
        const canvasStream = canvas.captureStream(fps);
        canvasStreamRef.current = canvasStream;
        const mimeType = getSupportedRecorderMimeType();
        const targetBitrate = calculateAdaptiveBitrate(targetW, targetH, fps);

        let recorder: MediaRecorder | null = null;
        if (mimeType) {
            try { recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: targetBitrate }); }
            catch { try { recorder = new MediaRecorder(canvasStream, { mimeType }); } catch { recorder = null; } }
        }
        if (!recorder) {
            try { recorder = new MediaRecorder(canvasStream); }
            catch (err) { console.error('[AiOverlay] iOS canvas MediaRecorder init failed:', err); if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current); return; }
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
            videoRef.current, nativeWidth, nativeHeight, containerRef.current,
            (canvasRecorder: MediaRecorder) => {
                recorderChunksRef.current = [];
                mimeTypeRef.current = canvasRecorder.mimeType || mimeTypeRef.current || 'video/mp4';
                recorderRef.current = canvasRecorder;
                recordingDurationRef.current = 0;

                canvasRecorder.ondataavailable = (event: BlobEvent) => {
                    if (event.data && event.data.size > 0) recorderChunksRef.current.push(event.data);
                };
                canvasRecorder.onerror = (event) => { console.error('[AiOverlay] iOS canvas MediaRecorder error:', event); };
                canvasRecorder.onstop = async () => {
                    if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
                    canvasStreamRef.current?.getTracks().forEach(t => t.stop());
                    canvasStreamRef.current = null;
                    canvasRef.current = null;
                    const actualType = mimeTypeRef.current || 'video/mp4';
                    const blob = new Blob(recorderChunksRef.current, { type: actualType });
                    if (blob.size === 0) { console.error('[AiOverlay] iOS canvas recording empty.'); setIsProcessing(false); return; }
                    setIsProcessing(false);
                    onCapture(URL.createObjectURL(blob), actualType);
                };
                canvasRecorder.start();
            },
        );

        if ('vibrate' in navigator) navigator.vibrate(200);
        setRecordingDuration(0);
        recordingDurationRef.current = 0;
        durationIntervalRef.current = window.setInterval(() => {
            setRecordingDuration(prev => { const n = prev + 1; recordingDurationRef.current = n; return n; });
        }, 1000);
        setIsRecording(true);
    };

    const startRecording = () => {
        if (!streamRef.current || isRecording || !isCameraReady) return;
        actuallyStartRecording();
    };

    const stopRecording = () => {
        if (!isRecording) return;
        if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; }
        setIsRecording(false);
        setShowEndFrame(false);
        setIsProcessing(true);
        const recorder = recorderRef.current;
        if (recorder?.state === 'recording') {
            // 250ms grace period — ensures iOS canvas recorder flushes final frames
            setTimeout(() => {
                try { if (recorder.state === 'recording') recorder.stop(); }
                catch (err) { console.error('[AiOverlay] iOS stop error:', err); setIsProcessing(false); }
            }, 250);
        } else {
            setIsProcessing(false);
            if (canvasRafRef.current) { cancelAnimationFrame(canvasRafRef.current); canvasRafRef.current = null; }
            canvasStreamRef.current?.getTracks().forEach(t => t.stop());
            canvasStreamRef.current = null;
            canvasRef.current = null;
        }
    };

    const formatDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    const progress = Math.min((recordingDuration / 60) * 100, 100);

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: '#000', zIndex: 50, overflow: 'hidden',
            // JS pixel height instead of 100dvh — fixes iOS WebView collapse
            height: viewportHeight ? `${viewportHeight}px` : '100dvh',
            width: '100vw',
        }}>

            {/* ══ TOP BAR — absolute overlay, gradient fade, safe-area padding ══ */}
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
                background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
                paddingTop: 'env(safe-area-inset-top, 0px)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px' }}>
                    <button onClick={onClose} disabled={isRecording || isProcessing} style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: (isRecording || isProcessing) ? 'rgba(255,255,255,0.25)' : 'white', fontSize: 18, cursor: (isRecording || isProcessing) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: isRecording ? '#ef4444' : '#00d47a', boxShadow: isRecording ? '0 0 8px rgba(239,68,68,0.9)' : '0 0 8px rgba(0,212,122,0.9)', animation: 'aio-blink 1s ease-in-out infinite' }} />
                        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, letterSpacing: '0.2em', fontFamily: 'monospace' }}>{isRecording ? 'REC' : 'APOLLO'}</span>
                    </div>
                    <div style={{ padding: '6px 14px', borderRadius: 20, background: isRecording ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.08)', border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)'}` }}>
                        <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>{isRecording ? formatDuration(recordingDuration) : '0:00'}</span>
                    </div>
                </div>
            </div>

            {/* ══ FULL-SCREEN VIEWFINDER — position:absolute inset:0 fills entire screen
          Top bar and bottom controls overlay on top — native Camera app layout ══ */}
            <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
                {/* Flash button — offset below top bar + safe-area */}
                {flashSupported && isCameraReady && (
                    <button onClick={() => void toggleFlash()} type="button" title={isFlashOn ? 'Turn Flash OFF' : 'Turn Flash ON'} style={{ position: 'absolute', top: 'calc(70px + env(safe-area-inset-top, 0px))', right: 16, zIndex: 25, display: 'flex', alignItems: 'center', gap: 8, background: isFlashOn ? 'rgba(255,215,0,0.22)' : 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', padding: '8px 14px', borderRadius: 20, border: isFlashOn ? '1px solid #FFD700' : '1px solid rgba(255,255,255,0.2)', color: isFlashOn ? '#FFD700' : 'rgba(255,255,255,0.85)', cursor: 'pointer', boxShadow: isFlashOn ? '0 0 14px rgba(255,215,0,0.5)' : '0 2px 8px rgba(0,0,0,0.3)', transition: 'all 0.2s ease' }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill={isFlashOn ? '#FFD700' : 'none'} stroke={isFlashOn ? '#FFD700' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', fontFamily: 'monospace' }}>{isFlashOn ? 'FLASH ON' : 'FLASH OFF'}</span>
                    </button>
                )}

                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>

                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 130% 90% at 50% 50%, transparent 30%, rgba(0,0,0,0.65) 100%)' }} />

                {/* ══ HORIZONTAL SCAN FRAME ══ */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: '92%', aspectRatio: '8 / 3', pointerEvents: 'none', zIndex: 15 }}>
                    <svg viewBox="0 0 560 210" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
                        <defs>
                            <filter id="aio-glowIOS"><feGaussianBlur stdDeviation="2" result="coloredBlur" /><feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                        </defs>
                        <rect x="4" y="4" width="552" height="202" rx="12" fill="rgba(0,212,122,0.03)" />
                        {[112, 187, 280, 373, 448].map((x, i) => (
                            <line key={x} x1={x} y1="12" x2={x} y2="198" stroke="#00d47a" strokeWidth={i === 2 ? 1.2 : 0.6} opacity={i === 2 ? 0.35 : 0.12} strokeDasharray={i === 2 ? undefined : '4 6'} />
                        ))}
                        <circle cx="280" cy="105" r="8" fill="none" stroke="#00d47a" strokeWidth="1.5" opacity="0.7"><animate attributeName="opacity" values="0.2;0.9;0.2" dur="2s" repeatCount="indefinite" /></circle>
                        <circle cx="280" cy="105" r="3" fill="#00d47a" opacity="0.5"><animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite" /></circle>
                        <line x1="262" y1="105" x2="298" y2="105" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
                        <line x1="280" y1="87" x2="280" y2="123" stroke="#00d47a" strokeWidth="0.8" opacity="0.4" />
                        {[112, 187, 280, 373, 448].map((x, i) => (
                            <g key={`tk${x}`}>
                                <line x1={x} y1="10" x2={x} y2={i === 2 ? 20 : 17} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
                                <line x1={x} y1="200" x2={x} y2={i === 2 ? 190 : 193} stroke="#00d47a" strokeWidth={i === 2 ? 2 : 1} opacity="0.5" strokeLinecap="round" />
                            </g>
                        ))}
                        {/* iOS: scan line driven by SVG animate — no JS interval needed */}
                        {isRecording && (
                            <g filter="url(#aio-glowIOS)">
                                <line x1="20" y1="10" x2="20" y2="200" stroke="#00d47a" strokeWidth="2.5" opacity="0.85">
                                    <animate attributeName="x1" values="20;540;20" dur="2.4s" repeatCount="indefinite" />
                                    <animate attributeName="x2" values="20;540;20" dur="2.4s" repeatCount="indefinite" />
                                    <animate attributeName="opacity" values="0.4;0.95;0.4" dur="0.4s" repeatCount="indefinite" />
                                </line>
                            </g>
                        )}
                        <rect x="8" y="8" width="544" height="194" rx="8" fill="none" stroke="rgba(0,212,122,0.25)" strokeWidth="1" strokeDasharray="8 6" style={{ animation: 'aio-dashMove 4s linear infinite' }} />
                        <g>
                            <line x1="10" y1="105" x2="252" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? '0.9' : '0.55'} strokeLinecap="round" />
                            <line x1="308" y1="105" x2="550" y2="105" stroke="#00d47a" strokeWidth="2" strokeOpacity={isRecording ? '0.9' : '0.55'} strokeLinecap="round" />
                            <polygon points="280,98 287,105 280,112 273,105" fill="none" stroke="#00d47a" strokeWidth="1.5" strokeOpacity={isRecording ? '1' : '0.7'} />
                            <polygon points="280,102 284,105 280,108 276,105" fill="#00d47a" fillOpacity={isRecording ? '0.9' : '0.4'} />
                            <text x="280" y="124" fill="#00d47a" fontSize="8" fontWeight="600" textAnchor="middle" opacity={isRecording ? '0' : '0.5'} style={{ fontFamily: 'monospace', letterSpacing: '1.5px' }}>LEVEL</text>
                        </g>
                    </svg>

                    <div style={{ position: 'absolute', top: -32, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', padding: '4px 12px', borderRadius: 20, border: '1px solid rgba(0,212,122,0.3)' }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: isRecording ? '#ef4444' : '#00d47a', boxShadow: `0 0 6px ${isRecording ? '#ef4444' : '#00d47a'}`, animation: 'aio-blink 1s ease-in-out infinite' }} />
                        <span style={{ color: '#00d47a', fontSize: 10, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', fontFamily: 'monospace' }}>{isRecording ? 'RECORDING' : 'ALIGN TYRE TREAD'}</span>
                    </div>
                </div>

                {/* ══ LEFT EDGE — START FRAME ══ */}
                {(!isRecording || (isRecording && !showEndFrame)) && (
                    <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
                        <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                            <defs>
                                <linearGradient id="aio-startGradIOS" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" /><stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" /><stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" /></linearGradient>
                                <filter id="aio-softGlowLIOS"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                            </defs>
                            <line x1="0" y1="20" x2="0" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#aio-softGlowLIOS)" />
                            <path d="M 16 15 Q 0 140 16 265" fill="none" stroke="url(#aio-startGradIOS)" strokeWidth="3.5" strokeLinecap="round" filter="url(#aio-softGlowLIOS)" />
                            <path d="M 24 25 Q 4 140 24 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                            <line x1="12" y1="50" x2="12" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#aio-softGlowLIOS)">{isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}</line>
                            <polygon points="14,134 14,146 30,140" fill="#00d47a" opacity="0.95">{!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}</polygon>
                            <text x="36" y="144" fill="#00d47a" fontSize="11" fontWeight="700" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>START</text>
                            {isRecording && (<><line x1="30" y1="140" x2="52" y2="140" stroke="#00d47a" strokeWidth="2" opacity="0.5" strokeDasharray="6 4"><animate attributeName="stroke-dashoffset" from="0" to="-20" dur="1s" repeatCount="indefinite" /></line><polygon points="46,136 52,140 46,144" fill="#00d47a" opacity="0.7"><animate attributeName="opacity" values="0.3;0.9;0.3" dur="0.8s" repeatCount="indefinite" /></polygon></>)}
                            {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (<line key={y} x1="0" y1={y} x2="14" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />))}
                        </svg>
                    </div>
                )}

                {/* ══ RIGHT EDGE — END FRAME ══ */}
                {isRecording && showEndFrame && (
                    <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: '22%', height: '80%', pointerEvents: 'none', zIndex: 15 }}>
                        <svg viewBox="0 0 100 280" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                            <defs>
                                <linearGradient id="aio-endGradIOS" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#00d47a" stopOpacity="0.2" /><stop offset="50%" stopColor="#00d47a" stopOpacity="0.95" /><stop offset="100%" stopColor="#00d47a" stopOpacity="0.2" /></linearGradient>
                                <filter id="aio-softGlowRIOS"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                            </defs>
                            <line x1="100" y1="20" x2="100" y2="260" stroke="#00d47a" strokeWidth="4" opacity="0.95" filter="url(#aio-softGlowRIOS)" />
                            <path d="M 84 15 Q 100 140 84 265" fill="none" stroke="url(#aio-endGradIOS)" strokeWidth="3.5" strokeLinecap="round" filter="url(#aio-softGlowRIOS)" />
                            <path d="M 76 25 Q 96 140 76 255" fill="none" stroke="#00d47a" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                            <line x1="88" y1="50" x2="88" y2="230" stroke="#00d47a" strokeWidth="2.5" opacity="0.9" strokeDasharray="8 4" filter="url(#aio-softGlowRIOS)">{isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite" />}</line>
                            <polygon points="86,134 86,146 70,140" fill="#00d47a" opacity="0.95">{!isRecording && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />}</polygon>
                            <text x="64" y="144" fill="#00d47a" fontSize="11" fontWeight="700" textAnchor="end" style={{ fontFamily: 'monospace', letterSpacing: '1px' }}>END</text>
                            {[45, 75, 105, 135, 165, 195, 225, 255].map(y => (<line key={y} x1="100" y1={y} x2="86" y2={y} stroke="#00d47a" strokeWidth="2" opacity="0.8" strokeLinecap="round" />))}
                        </svg>
                    </div>
                )}
            </div>{/* end viewfinder */}

            {/* ══ BOTTOM CONTROLS — absolute overlay, gradient fade, safe-area padding ══ */}
            <div style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: '12px 24px 16px',
                paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
                background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.4) 55%, transparent 100%)',
            }}>
                {!isRecording && isCameraReady && (
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 }}>
                            <div style={{ display: 'flex', gap: 3 }}>{[0, 1, 2].map(i => (<div key={i} style={{ width: 16, height: 2, borderRadius: 1, background: `rgba(0,212,122,${0.3 + i * 0.3})` }} />))}</div>
                            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Hold steady · Tread runs left → right</span>
                        </div>
                    </div>
                )}
                {isRecording && (
                    <div style={{ width: '100%', maxWidth: 200 }}>
                        <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 5 }}>
                            <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, #00c46e, #00d47a)', width: `${progress}%`, transition: 'width 1s linear' }} />
                        </div>
                        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>Recording: {formatDuration(recordingDuration)}</span>
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 120 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d47a' }} />
                            <span style={{ color: '#00d47a', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 }}>{cameraMetrics.width && cameraMetrics.height ? `${cameraMetrics.width}×${cameraMetrics.height}` : 'ADAPTIVE'}</span>
                        </div>
                        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: 'monospace' }}>{cameraMetrics.frameRate ? `${cameraMetrics.frameRate} FPS` : 'FPS: Auto'} • {cameraMetrics.displayAspect || '9:16'}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        {!isRecording ? (
                            <button onClick={startRecording} disabled={!isCameraReady || isProcessing} style={{ position: 'relative', background: 'none', border: 'none', padding: 0, cursor: (!isCameraReady || isProcessing) ? 'not-allowed' : 'pointer', opacity: (!isCameraReady || isProcessing) ? 0.4 : 1 }}>
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
                        <span style={{ color: isRecording ? '#ef4444' : 'rgba(255,255,255,0.35)', fontSize: 10, letterSpacing: '0.08em', animation: isRecording ? 'aio-blink 1s ease-in-out infinite' : 'none' }}>
                            {isRecording ? '● STOP' : isCameraReady ? 'TAP TO SCAN' : 'LOADING...'}
                        </span>
                    </div>
                    <div style={{ minWidth: 120, display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 9, fontFamily: 'monospace', textTransform: 'uppercase' }}>{cameraMetrics.facingMode || 'REAR'}</span>
                    </div>
                </div>
            </div>

            {/* ══ PROCESSING OVERLAY ══ */}
            {isProcessing && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, animation: 'aio-fadeIn 0.3s ease' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, animation: 'aio-scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)', padding: '40px 20px', maxWidth: 500, width: '100%' }}>
                        <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(0,212,122,0.12)', border: '2px solid rgba(0,212,122,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ width: 32, height: 32, border: '3px solid rgba(0,212,122,0.25)', borderTopColor: '#00d47a', borderRadius: '50%', animation: 'aio-spin 0.9s linear infinite' }} />
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <p style={{ color: 'white', fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>Finalising Scan</p>
                            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, margin: 0 }}>Processing video for tread analysis…</p>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        @keyframes aio-dashMove { to { stroke-dashoffset: -30; } }
        @keyframes aio-blink    { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes aio-fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes aio-scaleIn  { from{transform:scale(0.5);opacity:0} 60%{transform:scale(1.06)} to{transform:scale(1);opacity:1} }
        @keyframes aio-spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
        </div>
    );
}

// ─── INSTRUCTIONS PROMPT ──────────────────────────────────────────────────────

interface InstructionsPromptProps {
    onContinue: () => void;
    onClose: () => void;
}

function InstructionsPrompt({ onContinue, onClose }: InstructionsPromptProps) {
    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: '#080c10', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse 70% 50% at 50% 60%, rgba(0,210,120,0.07) 0%, transparent 70%)' }} />
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.04, pointerEvents: 'none' }}>
                <defs><pattern id="aio-pg" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#00d47a" strokeWidth="0.5" /></pattern></defs>
                <rect width="100%" height="100%" fill="url(#aio-pg)" />
            </svg>
            <button onClick={onClose} style={{ position: 'absolute', top: 20, left: 20, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, width: 40, height: 40, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 18, zIndex: 1 }}>✕</button>
            <div style={{ position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1 }}>
                <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 11, letterSpacing: '0.35em', textTransform: 'uppercase', fontWeight: 500, whiteSpace: 'nowrap' }}>APOLLO · TREAD SCAN</span>
            </div>
            <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, padding: '60px 32px 32px', maxWidth: 360, width: '100%' }}>
                {/* Instruction video served from /public/instruction_video.mp4 */}
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video autoPlay loop muted playsInline style={{ width: 160, height: 160, paddingTop: 12, borderRadius: 12 }}>
                    <source src={InstructionVideo} type="video/mp4" />
                </video>
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
        @keyframes aio-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
        </div>
    );
}

// ─── PUBLIC COMPONENT ────────────────────────────────────────────────────────

export interface AiOverlayCaptureOverlayProps {
    open: boolean;
    onClose: () => void;
    /** Called with the recorded video as a File — same contract as TyreVideoCaptureOverlay */
    onCapture: (file: File) => void;
}

type Stage = 'prompt' | 'camera';

/**
 * AiOverlayCaptureOverlay — drop-in replacement for TyreVideoCaptureOverlay,
 * activated by VITE_VIDEO_CAPTURE_MODE=AI_Overlay.
 *
 * Flow: InstructionsPrompt → CameraCaptureIOS (iOS) | CameraCaptureAndroid (other)
 *
 * Android stream lifetime:
 *   Acquired ONCE on the first open, held in androidStreamRef across every
 *   record → stop → retake cycle. Released only when open goes false.
 *   This guarantees the camera hardware negotiation runs exactly once, so the
 *   stream resolution never changes between takes.
 *
 * Blob URL → File conversion happens here before calling onCapture.
 */
export function AiOverlayCaptureOverlay({
    open,
    onClose,
    onCapture,
}: AiOverlayCaptureOverlayProps) {
    const [stage, setStage] = useState<Stage>('prompt');

    // Android-only: holds the live stream across retakes
    const androidStreamRef = useRef<MediaStream | null>(null);
    const [androidStream, setAndroidStream] = useState<MediaStream | null>(null);

    // Reset stage to prompt whenever overlay is (re-)opened
    useEffect(() => { if (open) setStage('prompt'); }, [open]);

    // Body scroll lock
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [open]);

    // Android stream: acquire once when opened, release when closed.
    // iOS uses its own internal stream (not affected).
    useEffect(() => {
        if (isIOSDevice()) return;

        if (open) {
            // Acquire only if we don't already have a live stream
            if (!androidStreamRef.current) {
                acquireAdaptiveCameraStreamAndroid()
                    .then(s => {
                        androidStreamRef.current = s;
                        setAndroidStream(s);
                    })
                    .catch(err => {
                        console.error('[AiOverlay] Android pre-acquire failed:', err);
                        alert('Camera access denied or unavailable. Please check permissions.');
                        onClose();
                    });
            }
        } else {
            // Overlay closed — release the stream
            if (androidStreamRef.current) {
                androidStreamRef.current.getTracks().forEach(t => t.stop());
                androidStreamRef.current = null;
                setAndroidStream(null);
            }
        }
    }, [open, onClose]);

    const handleCapture = useCallback(async (blobUrl: string, mimeType: string) => {
        try {
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
            const file = new File([blob], `airtd-tread-${Date.now()}.${ext}`, { type: mimeType });
            URL.revokeObjectURL(blobUrl);
            onCapture(file);
        } catch (e) {
            console.error('[AiOverlay] Failed to convert blob URL to File:', e);
            URL.revokeObjectURL(blobUrl);
        }
        onClose();
    }, [onCapture, onClose]);

    if (!open) return null;

    if (stage === 'prompt') {
        return (
            <InstructionsPrompt
                onContinue={() => setStage('camera')}
                onClose={onClose}
            />
        );
    }

    // iOS: uses its own internal stream acquisition (not affected by this change)
    if (isIOSDevice()) {
        return (
            <CameraCaptureIOS
                onCapture={(url, mime) => void handleCapture(url, mime)}
                onClose={onClose}
            />
        );
    }

    // Android: wait for the pre-acquired stream before rendering the capture UI
    if (!androidStream) {
        return (
            <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 36, height: 36, border: '3px solid rgba(0,212,122,0.25)', borderTopColor: '#00d47a', borderRadius: '50%', animation: 'aio-spin 0.9s linear infinite' }} />
                <style>{`@keyframes aio-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
            </div>
        );
    }

    return (
        <CameraCaptureAndroid
            stream={androidStream}
            onCapture={(url, mime) => void handleCapture(url, mime)}
            onClose={onClose}
        />
    );
}
