import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface CameraCaptureProps {
  onCapture: (croppedVideoUrl: string, originalVideoUrl: string) => void;
  onClose: () => void;
}

const CameraCapture: React.FC<CameraCaptureProps> = ({ onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [timeLeft, setTimeLeft] = useState(8);
  const [recordingComplete, setRecordingComplete] = useState(false);

  // Camera initialization
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          streamRef.current = stream;
          videoRef.current.onloadedmetadata = () => setIsCameraReady(true);
        }
      } catch (err) {
        alert('Camera access denied.');
        onClose();
      }
    };

    startCamera();

    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, [onClose]);

  // Recording logic
  const startRecording = () => {
    if (!streamRef.current || isRecording || !videoRef.current) return;

    const mimeType = 'video/webm;codecs=vp8';

    // 🚀 HIGH QUALITY SETTINGS
    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: 20000000 // 20 Mbps
    };

    const recorder = new MediaRecorder(streamRef.current, recorderOptions);
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const videoUrl = URL.createObjectURL(blob);
      setRecordingComplete(true);
      setTimeout(() => {
        // Pass same URL for both if consumer expects two, or just one
        onCapture(videoUrl, videoUrl);
      }, 500);
    };

    recorder.start();
    setIsRecording(true);
    setTimeLeft(8);

    let seconds = 8;
    const interval = setInterval(() => {
      seconds--;
      setTimeLeft(seconds);
      if (seconds === 0) {
        clearInterval(interval);
        if (recorder.state === 'recording') recorder.stop();
        setIsRecording(false);
      }
    }, 1000);
  };

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden flex flex-col items-center justify-center">
      <div className="relative w-full h-full">
        <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />

        {/* FULL WIDTH GUIDE FRAME */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[98%] aspect-[8/3] border-[6px] border-green-500 rounded-xl pointer-events-none shadow-[0_0_30px_rgba(34,197,94,0.4)]">
          <div className="absolute inset-0 bg-green-500/10" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full pb-4">
            <span className="text-green-500 text-lg font-black tracking-[0.2em] uppercase drop-shadow-md">Recording Area</span>
          </div>
          {isRecording && <div className="absolute inset-0 border-[6px] border-red-500 animate-pulse" />}
        </div>

        {/* UI Controls */}
        <div className="absolute inset-0 flex flex-col justify-between p-8 pointer-events-none">
          <div className="flex justify-between items-start pointer-events-auto">
            <button onClick={onClose} disabled={isRecording} className="p-4 bg-black/60 rounded-full text-white backdrop-blur-md">
              <X size={32} />
            </button>
            <div className="bg-black/60 px-6 py-3 rounded-full flex items-center gap-3 backdrop-blur-md border border-white/20">
              <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-red-500 animate-pulse shadow-[0_0_10px_#ef4444]' : 'bg-green-500'}`} />
              <span className="text-white text-xl font-bold font-mono tracking-wider">{isRecording ? `0:0${timeLeft}` : 'READY'}</span>
            </div>
          </div>

          <div className="flex flex-col items-center gap-6 pointer-events-auto pb-10">
            {!isRecording && !recordingComplete && (
              <p className="text-white text-xl font-bold bg-black/60 px-8 py-3 rounded-full backdrop-blur-md border border-white/10 uppercase tracking-widest shadow-xl">
                Align tyre tread in the frame
              </p>
            )}
            <button
              onClick={startRecording}
              disabled={!isCameraReady || isRecording || recordingComplete}
              className="w-24 h-24 rounded-full border-4 border-white flex items-center justify-center group disabled:opacity-50 transition-all active:scale-95 bg-black/20 backdrop-blur-sm"
            >
              <div className={`transition-all duration-300 shadow-2xl ${isRecording ? 'w-10 h-10 bg-red-500 rounded-md' : 'w-16 h-16 bg-red-500 rounded-full group-hover:scale-110'}`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CameraCapture;