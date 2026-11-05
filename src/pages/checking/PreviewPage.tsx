// components/PreviewPage.tsx
import React, { useEffect, useRef } from 'react';

interface PreviewPageProps {
  videoUrl: string;
  onRetake: () => void;
  onSave: () => void;
  onNewCapture: () => void;
}

const PreviewPage: React.FC<PreviewPageProps> = ({ 
  videoUrl, 
  onRetake, 
  onSave, 
  onNewCapture 
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Auto-play the preview video
    if (videoRef.current) {
      videoRef.current.play().catch(e => console.log('Auto-play prevented:', e));
    }
  }, [videoUrl]);

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 px-6 py-4 flex items-center justify-between">
        <button
          onClick={onNewCapture}
          className="text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-white text-xl font-semibold">Preview Scan</h2>
        <div className="w-6" /> {/* Spacer */}
      </div>

      {/* Video Preview */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-4xl w-full bg-black rounded-xl overflow-hidden shadow-2xl">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            loop
            className="w-full h-auto"
            playsInline
          />
        </div>
      </div>

      {/* Scan Details */}
      <div className="bg-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="text-center">
              <p className="text-gray-400 text-sm">Duration</p>
              <p className="text-white font-semibold">
                {(() => {
                  const video = videoRef.current;
                  return video?.duration ? `${Math.round(video.duration)}s` : '--';
                })()}
              </p>
            </div>
            <div className="text-center">
              <p className="text-gray-400 text-sm">Format</p>
              <p className="text-white font-semibold">WebM</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              onClick={onRetake}
              className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center space-x-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>Retake</span>
            </button>
            <button
              onClick={onSave}
              className="flex-1 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center space-x-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>Save to Device</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PreviewPage;