// components/TyreTreadRecorder.tsx (Updated with callback)
import React, { useRef, useState, useEffect } from 'react';

interface TyreTreadRecorderProps {
  onRecordingComplete: (videoBlob: Blob) => void;
}

const START_PHASE_DURATION = 2000;

interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

interface ExtendedTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}

const TyreTreadRecorder: React.FC<TyreTreadRecorderProps> = ({ onRecordingComplete }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [phase, setPhase] = useState<'IDLE' | 'START' | 'SCANNING'>('IDLE');
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [timer, setTimer] = useState(0);

  useEffect(() => {
    let localStream: MediaStream | null = null;

    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: 1280, height: 720 },
        });
        localStream = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          const track = stream.getVideoTracks()[0];
          const capabilities = (typeof track?.getCapabilities === 'function' ? track.getCapabilities() : {}) as ExtendedCapabilities;
          if (capabilities.torch) {
            const adv: ExtendedTrackConstraintSet = { torch: true };
            await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
          }
        }
      } catch (err) {
        console.error("Error accessing camera:", err);
      }
    };

    void initCamera();
    return () => {
      localStream?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // Timer for progress bar
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (phase === 'SCANNING') {
      interval = setInterval(() => {
        setTimer(prev => (prev + 1) % 100);
      }, 30);
    }
    return () => clearInterval(interval);
  }, [phase]);

  // Recording Logic
  const startRecording = () => {
    const video = videoRef.current;
    if (!video || !video.srcObject) return;

    setRecordedChunks([]);
    const stream = video.srcObject as MediaStream;
    const mimeType = 'video/webm;codecs=vp8';

    // 🚀 ULTRA HIGH QUALITY SETTINGS
    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: 20000000 // 20 Mbps
    };

    const recorder = new MediaRecorder(stream, recorderOptions);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) setRecordedChunks(prev => [...prev, e.data]);
    };

    recorder.onstop = () => {
      if (recordedChunks.length > 0) {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        onRecordingComplete(blob);
      }
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    setPhase('START');
    setTimer(0);

    // Phase transition after 2s
    setTimeout(() => {
      setPhase('SCANNING');
      if ('vibrate' in navigator) navigator.vibrate(200);
    }, START_PHASE_DURATION);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    setPhase('IDLE');

    // Stop tracks/flash
    const stream = videoRef.current?.srcObject as MediaStream | undefined;
    stream?.getTracks().forEach(track => {
      if (track.kind === 'video') {
        const adv: ExtendedTrackConstraintSet = { torch: false };
        void track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
      }
    });
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex items-center justify-center">
      {/* Main Viewfinder - FULL OPAQUE */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* UI GUIDES - FULL WIDTH FRAME */}
      <div className="absolute inset-0 flex items-center justify-between px-1">
        {/* START FRAME (LEFT EDGE) */}
        <div
          className={`h-[92%] border-r-[10px] relative flex flex-col justify-center items-center transition-colors duration-500 w-16
    ${phase === 'START'
              ? 'border-green-500 shadow-[0_0_30px_rgba(34,197,94,0.8)]'
              : 'border-white/40'}`}
        >
          {phase === 'START' && (
            <div className="text-green-400 font-bold animate-pulse text-center absolute left-6 w-24">
              <p className="text-xl">START HERE</p>
              <span className="text-6xl">→</span>
            </div>
          )}

          {/* Scanning Line */}
          {phase === 'SCANNING' && (
            <div className="absolute top-0 left-0 w-1 h-full bg-white/50 shadow-[0_0_10px_white]" />
          )}
        </div>

        {/* SCANNING PROGRESS LINE (Moves across the whole screen) */}
        {phase === 'SCANNING' && (
          <div className="absolute top-1/2 left-0 w-full h-2 bg-white/30 shadow-[0_0_15px_white] animate-scan-horizontal" />
        )}

        {/* END FRAME (RIGHT EDGE) */}
        <div
          className={`h-[92%] border-l-[10px] relative flex flex-col justify-center items-center transition-colors duration-500 w-16
    ${phase === 'SCANNING'
              ? 'border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.8)]'
              : 'border-white/40'}`}
        >
          {phase === 'SCANNING' && (
            <div className="text-red-500 font-bold text-center absolute right-12 w-48 animate-in fade-in duration-700">
              <span className="text-6xl">←</span>
              <p className="text-xl">END HERE</p>
            </div>
          )}
        </div>
      </div>

      {/* TOP HUD */}
      <div className="absolute top-10 w-full text-center px-6">
        <h2 className="text-white font-bold text-2xl tracking-widest drop-shadow-lg uppercase">
          {phase === 'START' ? 'POSITION TYRE START' :
            phase === 'SCANNING' ? 'MOVE CAMERA ACROSS TREAD' : 'READY TO SCAN'}
        </h2>
        {isRecording && (
          <div className="mt-6 w-3/4 mx-auto h-3 bg-gray-800/80 rounded-full overflow-hidden border border-white/20">
            <div className="h-full bg-red-500 transition-all duration-100 shadow-[0_0_10px_#ef4444]" style={{ width: `${timer}%` }} />
          </div>
        )}
      </div>

      {/* CONTROLS */}
      <div className="absolute bottom-10 w-full flex justify-center">
        {!isRecording ? (
          <button
            onClick={startRecording}
            className="w-24 h-24 rounded-full border-4 border-white flex items-center justify-center p-1.5 hover:scale-105 transition-transform bg-black/20 backdrop-blur-sm"
          >
            <div className="w-full h-full bg-red-600 rounded-full hover:bg-red-500 transition-colors shadow-lg" />
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="w-24 h-24 rounded-full border-4 border-white flex items-center justify-center hover:scale-105 transition-transform bg-black/20 backdrop-blur-sm"
          >
            <div className="w-12 h-12 bg-white rounded-lg shadow-lg" />
          </button>
        )}
      </div>

      {/* Back Button */}
      <button
        onClick={() => window.history.back()}
        className="absolute top-10 left-6 text-white bg-black/50 rounded-full p-3 hover:bg-black/70 transition-colors backdrop-blur-md"
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <style >{`
        @keyframes scan-horizontal {
          0% { transform: translateY(-30vh); opacity: 0.3; }
          50% { opacity: 1; }
          100% { transform: translateY(30vh); opacity: 0.3; }
        }
        .animate-scan-horizontal {
          animation: scan-horizontal 2s ease-in-out infinite;
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .fade-in {
          animation: fade-in 0.5s ease-out;
        }
      `}</style>
    </div>
  );
};

export default TyreTreadRecorder; 